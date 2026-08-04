import { describe, expect, it } from "vitest";
import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";
import {
  cellValueToPlainText,
  cellValueToSqlLiteral,
  describeSelection,
  inferTableNameFromSql,
  primaryKeyColumnIndexes,
  serializeResultAsCsv,
  serializeResultAsTsv,
  resolveExportTableName,
  serializeRowsAsInsert,
  serializeSelectionAsInList,
  serializeSelectionAsJson,
  serializeSelectionAsMarkdown,
  serializeSelectionAsTsv,
} from "./resultExport";

const COLUMNS: QueryColumn[] = [
  { name: "id", databaseType: "BIGINT", nullable: false },
  { name: "note", databaseType: "TEXT", nullable: true },
  { name: "payload", databaseType: "JSON", nullable: true },
];

const ROWS: CellValue[][] = [
  [
    { kind: "integer", value: "1" },
    { kind: "text", value: "hello\tworld" },
    { kind: "json", value: "{\"ok\":true}" },
  ],
  [
    { kind: "integer", value: "2" },
    { kind: "null" },
    { kind: "binary", value: "AAEC" },
  ],
];

describe("resultExport", () => {
  it("converts cell values into stable plain text", () => {
    expect(cellValueToPlainText({ kind: "null" })).toBe("NULL");
    expect(cellValueToPlainText({ kind: "boolean", value: false })).toBe("false");
    expect(cellValueToPlainText({ kind: "float", value: 1.5 })).toBe("1.5");
    expect(cellValueToPlainText({ kind: "binary", value: "AAEC" })).toBe("[Binary]");
  });

  it("serializes TSV with headers and tab-safe cell text", () => {
    expect(serializeResultAsTsv(COLUMNS, ROWS)).toBe(
      "id\tnote\tpayload\n1\thello world\t{\"ok\":true}\n2\tNULL\t[Binary]",
    );
  });

  it("serializes CSV with RFC 4180 quoting", () => {
    const quotedRows: CellValue[][] = [[
      { kind: "integer", value: "3" },
      { kind: "text", value: "a, \"b\"" },
      { kind: "text", value: "line\nbreak" },
    ]];
    expect(serializeResultAsCsv(COLUMNS, quotedRows)).toBe(
      "id,note,payload\n3,\"a, \"\"b\"\"\",\"line\nbreak\"",
    );
  });

  it("serializes only the selected rectangle as TSV without headers", () => {
    expect(
      serializeSelectionAsTsv(COLUMNS, ROWS, {
        startRow: 0,
        startCol: 1,
        endRow: 1,
        endCol: 1,
      }),
    ).toBe("hello world\nNULL");
  });

  it("serializes a selection with field names / aliases as the header row", () => {
    const aliased: QueryColumn[] = [
      { name: "order_id", databaseType: "BIGINT", nullable: false },
      { name: "label", databaseType: "TEXT", nullable: true },
      { name: "payload", databaseType: "JSON", nullable: true },
    ];
    expect(
      serializeSelectionAsTsv(
        aliased,
        ROWS,
        { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
        { includeHeaders: true },
      ),
    ).toBe("order_id\tlabel\n1\thello world");
  });

  it("formats SQL literals for INSERT statements", () => {
    expect(cellValueToSqlLiteral({ kind: "null" }, "TEXT")).toBe("NULL");
    expect(cellValueToSqlLiteral({ kind: "boolean", value: true }, "TINYINT")).toBe("1");
    expect(cellValueToSqlLiteral({ kind: "integer", value: "9" }, "BIGINT")).toBe("9");
    expect(cellValueToSqlLiteral({ kind: "text", value: "O'Reilly" }, "VARCHAR")).toBe(
      "CONVERT(X'4F275265696C6C79' USING utf8mb4)",
    );
    expect(cellValueToSqlLiteral({ kind: "json", value: "{\"a\":1}" }, "JSON")).toBe(
      "CONVERT(X'7B2261223A317D' USING utf8mb4)",
    );
    expect(cellValueToSqlLiteral({ kind: "binary", value: "AAEC" }, "BLOB")).toBe(
      "FROM_BASE64(CONVERT(X'41414543' USING utf8mb4))",
    );
  });

  it("infers table names from FROM clauses", () => {
    expect(inferTableNameFromSql("SELECT * FROM orders WHERE id = 1")).toBe("orders");
    expect(inferTableNameFromSql("select a from `shop`.`order_items` o")).toBe("shop.order_items");
    expect(inferTableNameFromSql("SELECT 1")).toBe("your_table");
    expect(resolveExportTableName("SELECT * FROM orders", "shop")).toBe("shop.orders");
    expect(resolveExportTableName("SELECT * FROM `shop`.`orders`", "other")).toBe("shop.orders");
  });

  it("identifies id columns as primary-key candidates", () => {
    expect(primaryKeyColumnIndexes(COLUMNS)).toEqual([0]);
    expect(primaryKeyColumnIndexes([{ name: "userId", databaseType: "INT", nullable: false }])).toEqual([]);
  });

  it("serializes selected rows as INSERT with optional id omission", () => {
    expect(
      serializeRowsAsInsert(COLUMNS, ROWS, {
        tableName: "demo.orders",
        includePrimaryKey: true,
        rowIndexes: [0],
      }),
    ).toBe(
      "INSERT INTO `demo`.`orders` (`id`, `note`, `payload`) VALUES (1, CONVERT(X'68656C6C6F09776F726C64' USING utf8mb4), CONVERT(X'7B226F6B223A747275657D' USING utf8mb4));",
    );

    expect(
      serializeRowsAsInsert(COLUMNS, ROWS, {
        tableName: "orders",
        includePrimaryKey: false,
        rowIndexes: [0, 1],
      }),
    ).toBe(
      [
        "INSERT INTO `orders` (`note`, `payload`) VALUES",
        "(CONVERT(X'68656C6C6F09776F726C64' USING utf8mb4), CONVERT(X'7B226F6B223A747275657D' USING utf8mb4)),",
        "(NULL, FROM_BASE64(CONVERT(X'41414543' USING utf8mb4)));",
      ].join("\n"),
    );
  });

  it("serializes selections as JSON, Markdown, and IN lists", () => {
    expect(
      serializeSelectionAsJson(COLUMNS, ROWS, {
        startRow: 0,
        startCol: 0,
        endRow: 0,
        endCol: 1,
      }),
    ).toBe(JSON.stringify({ id: "1", note: "hello\tworld" }, null, 2));

    expect(
      serializeSelectionAsMarkdown(COLUMNS, ROWS, {
        startRow: 0,
        startCol: 0,
        endRow: 0,
        endCol: 1,
      }),
    ).toBe("| id | note |\n| --- | --- |\n| 1 | hello\tworld |");

    expect(
      serializeSelectionAsInList(COLUMNS, ROWS, {
        startRow: 0,
        startCol: 0,
        endRow: 1,
        endCol: 0,
      }),
    ).toBe("IN (1, 2)");
  });

  it("exports raw JSON numbers without a JavaScript precision round trip", () => {
    expect(
      serializeSelectionAsJson(COLUMNS, [[
        { kind: "integer", value: "1" },
        { kind: "text", value: "exact" },
        { kind: "json", value: "{\"id\":18446744073709551615}" },
      ]], {
        startRow: 0,
        startCol: 2,
        endRow: 0,
        endCol: 2,
      }),
    ).toBe("{\"id\":18446744073709551615}");
  });

  it("describes selection status for the results header", () => {
    expect(describeSelection(null, false, 3)).toBeNull();
    expect(
      describeSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, false, 3),
    ).toBe("已选 1 个单元格");
    expect(
      describeSelection({ startRow: 0, startCol: 0, endRow: 1, endCol: 2 }, false, 3),
    ).toBe("已选 2 行");
    expect(
      describeSelection({ startRow: 0, startCol: 0, endRow: 1, endCol: 2 }, true, 3),
    ).toBe("已选全部 2 行");
  });
});
