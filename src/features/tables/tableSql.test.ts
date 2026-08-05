import { describe, expect, it } from "vitest";
import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";
import {
  buildDdlStatements,
  buildTableMutationPlan,
  columnDefaultValidationError,
  columnTypeValidationError,
  buildAlterTableCommentStatement,
  formatMysqlColumnType,
  isStructureColumnEditable,
  parseCreateTableComment,
  parseMysqlColumnType,
  suggestMysqlBaseTypes,
  tableRowIdentity,
  type StagedExistingRow,
  type TableColumnDefinition,
} from "./tableSql";

const ID_COLUMN: TableColumnDefinition = {
  sourceName: "id",
  name: "id",
  type: "bigint unsigned",
  nullable: false,
  defaultValue: null,
  defaultExpression: false,
  comment: "",
  primary: true,
  extra: "auto_increment",
  characterSet: null,
  collation: null,
  generationExpression: "",
};

const NAME_COLUMN: TableColumnDefinition = {
  ...ID_COLUMN,
  sourceName: "name",
  name: "name",
  type: "varchar(50)",
  nullable: true,
  primary: false,
  extra: "",
  characterSet: "utf8mb4",
  collation: "utf8mb4_0900_ai_ci",
};

const QUERY_COLUMNS: QueryColumn[] = [
  { name: "id", databaseType: "BIGINT UNSIGNED", nullable: false },
  { name: "name", databaseType: "VARCHAR", nullable: true },
];

/** Builds the immutable original row used by stable-key mutation tests. */
function originalRow(id = "1", name = "old"): CellValue[] {
  return [{ kind: "integer", value: id }, { kind: "text", value: name }];
}

/** Builds one staged existing-row update keyed by its original primary key. */
function stagedUpdate(row: CellValue[], column: string, value: string | null): Map<string, StagedExistingRow> {
  const identity = tableRowIdentity(row, QUERY_COLUMNS, ["id"]);
  return new Map([[identity, { originalRow: row, values: new Map([[column, value]]) }]]);
}

describe("table SQL generation", () => {
  it("preserves charset/collation and encodes DDL strings without SQL-mode escapes", () => {
    const renamed = { ...ID_COLUMN, name: "order_id", comment: "主键" };
    const added: TableColumnDefinition = {
      ...NAME_COLUMN,
      sourceName: null,
      name: "status",
      type: "varchar(20)",
      nullable: false,
      defaultValue: "new",
      characterSet: null,
      collation: null,
    };

    expect(buildDdlStatements("shop", "orders", [ID_COLUMN], [renamed, added])).toEqual([
      "ALTER TABLE `shop`.`orders` CHANGE COLUMN `id` `order_id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT X'E4B8BBE994AE';",
      "ALTER TABLE `shop`.`orders` ADD COLUMN `status` varchar(20) NOT NULL DEFAULT X'6E6577';",
    ]);
  });

  it("drops character-only clauses when a text column changes to a numeric type", () => {
    const numericDraft = { ...NAME_COLUMN, type: "int", nullable: false };

    expect(buildDdlStatements("shop", "orders", [NAME_COLUMN], [numericDraft])).toEqual([
      "ALTER TABLE `shop`.`orders` CHANGE COLUMN `name` `name` int NOT NULL;",
    ]);
  });

  it("builds typed updates from immutable original keys", () => {
    const row = originalRow("18446744073709551615");
    const plan = buildTableMutationPlan({
      database: "shop",
      table: "orders",
      queryColumns: QUERY_COLUMNS,
      schema: [ID_COLUMN, NAME_COLUMN],
      updatedRows: stagedUpdate(row, "name", "O'Reilly"),
      deletedRows: new Map(),
      insertedRows: [],
    });

    expect(plan.errors).toEqual([]);
    expect(plan.mutations).toEqual([{
      type: "update",
      key: [{ name: "id", value: { kind: "integer", value: "18446744073709551615" } }],
      values: [{ name: "name", value: { kind: "text", value: "O'Reilly" } }],
    }]);
    expect(plan.statements[0]).toContain("CONVERT(X'4F275265696C6C79' USING utf8mb4)");
  });

  it("never places quote/backslash payloads into preview SQL text", () => {
    const payload = "C:\\tmp\\'; DELETE FROM users; --";
    const plan = buildTableMutationPlan({
      database: "shop",
      table: "orders",
      queryColumns: QUERY_COLUMNS,
      schema: [ID_COLUMN, NAME_COLUMN],
      updatedRows: stagedUpdate(originalRow(), "name", payload),
      deletedRows: new Map(),
      insertedRows: [],
    });

    expect(plan.errors).toEqual([]);
    expect(plan.statements[0]).not.toContain(payload);
    expect(plan.statements[0]).not.toContain("DELETE FROM users");
    expect(plan.mutations[0]).toMatchObject({
      type: "update",
      values: [{ value: { kind: "text", value: payload } }],
    });
  });

  it("keeps omitted insert columns on DEFAULT and supports explicit NULL", () => {
    const plan = buildTableMutationPlan({
      database: "shop",
      table: "orders",
      queryColumns: QUERY_COLUMNS,
      schema: [ID_COLUMN, NAME_COLUMN],
      updatedRows: new Map(),
      deletedRows: new Map(),
      insertedRows: [new Map(), new Map([["name", null]])],
    });

    expect(plan.errors).toEqual([]);
    expect(plan.mutations).toEqual([
      { type: "insert", values: [] },
      { type: "insert", values: [{ name: "name", value: { kind: "null" } }] },
    ]);
    expect(plan.statements).toEqual([
      "INSERT INTO `shop`.`orders` () VALUES ();",
      "INSERT INTO `shop`.`orders` (`name`) VALUES (NULL);",
    ]);
  });

  it("preserves binary primary keys and raw JSON large numbers", () => {
    const binaryId = { ...ID_COLUMN, type: "varbinary(16)" };
    const jsonColumn = { ...NAME_COLUMN, name: "payload", sourceName: "payload", type: "json" };
    const columns: QueryColumn[] = [
      { name: "id", databaseType: "VARBINARY", nullable: false },
      { name: "payload", databaseType: "JSON", nullable: true },
    ];
    const row: CellValue[] = [
      { kind: "binary", value: "AAEC" },
      { kind: "json", value: "{\"id\":18446744073709551615}" },
    ];
    const identity = tableRowIdentity(row, columns, ["id"]);
    const plan = buildTableMutationPlan({
      database: "shop",
      table: "records",
      queryColumns: columns,
      schema: [binaryId, jsonColumn],
      updatedRows: new Map([[identity, {
        originalRow: row,
        values: new Map([["payload", "{\"id\":18446744073709551614}"]]),
      }]]),
      deletedRows: new Map(),
      insertedRows: [],
    });

    expect(plan.errors).toEqual([]);
    expect(plan.mutations[0]).toMatchObject({
      type: "update",
      key: [{ value: { kind: "binary", value: "AAEC" } }],
      values: [{ value: { kind: "json", value: "{\"id\":18446744073709551614}" } }],
    });
  });

  it("rejects invalid ranges, invalid JSON, and NULL for NOT NULL columns", () => {
    const plan = buildTableMutationPlan({
      database: "shop",
      table: "orders",
      queryColumns: QUERY_COLUMNS,
      schema: [ID_COLUMN, NAME_COLUMN],
      updatedRows: new Map(),
      deletedRows: new Map(),
      insertedRows: [
        new Map([["id", "18446744073709551616"], ["name", null]]),
        new Map([["id", null]]),
      ],
    });
    const jsonPlan = buildTableMutationPlan({
      database: "shop",
      table: "orders",
      queryColumns: QUERY_COLUMNS,
      schema: [ID_COLUMN, { ...NAME_COLUMN, type: "json" }],
      updatedRows: new Map(),
      deletedRows: new Map(),
      insertedRows: [new Map([["name", "{broken"]])],
    });

    expect(plan.errors).toContain("id：超出 BIGINT UNSIGNED 范围");
    expect(plan.errors).toContain("id：该字段不允许 NULL");
    expect(jsonPlan.errors).toContain("name：请输入有效 JSON");
  });

  it("rejects values MySQL could otherwise round, truncate, or coerce", () => {
    const columns: TableColumnDefinition[] = [
      { ...NAME_COLUMN, name: "amount", sourceName: "amount", type: "decimal(5,2)" },
      { ...NAME_COLUMN, name: "code", sourceName: "code", type: "varchar(3)" },
      { ...NAME_COLUMN, name: "created_at", sourceName: "created_at", type: "datetime(3)" },
      { ...NAME_COLUMN, name: "token", sourceName: "token", type: "varbinary(2)" },
      { ...NAME_COLUMN, name: "year_value", sourceName: "year_value", type: "year" },
      { ...NAME_COLUMN, name: "unsigned_amount", sourceName: "unsigned_amount", type: "decimal(5,2) unsigned" },
      { ...NAME_COLUMN, name: "fixed_ratio", sourceName: "fixed_ratio", type: "double(5,2)" },
    ];
    const plan = buildTableMutationPlan({
      database: "shop",
      table: "typed_values",
      queryColumns: columns.map((column) => ({ name: column.name, databaseType: column.type, nullable: true })),
      schema: columns,
      updatedRows: new Map(),
      deletedRows: new Map(),
      insertedRows: [new Map([
        ["amount", "1000.001"],
        ["code", "four"],
        ["created_at", "2026-02-30 25:00:00.1234"],
        ["token", "AAEC"],
        ["year_value", "1800"],
        ["unsigned_amount", "-1.00"],
        ["fixed_ratio", "1.234"],
      ])],
    });

    expect(plan.errors).toEqual(expect.arrayContaining([
      "amount：超出 DECIMAL(5,2) 范围或小数位数",
      "code：内容超过 VARCHAR(3) 字符长度",
      "created_at：时间格式无效",
      "token：二进制内容超过 VARBINARY(2) 容量",
      "year_value：YEAR 仅允许 0 或 1901–2155",
      "unsigned_amount：UNSIGNED 小数不能为负数",
      "fixed_ratio：超出 DOUBLE(5,2) 范围或小数位数",
    ]));
  });

  it("rejects float underflow, invalid ENUM/SET members, and excess BIT bits", () => {
    const columns: TableColumnDefinition[] = [
      { ...NAME_COLUMN, name: "ratio", sourceName: "ratio", type: "float" },
      { ...NAME_COLUMN, name: "precise_ratio", sourceName: "precise_ratio", type: "double" },
      { ...NAME_COLUMN, name: "float_as_double", sourceName: "float_as_double", type: "float(30)" },
      { ...NAME_COLUMN, name: "state", sourceName: "state", type: "enum('A','O''Reilly','back\\\\slash')" },
      { ...NAME_COLUMN, name: "flags", sourceName: "flags", type: "set('x','O''Reilly')" },
      { ...NAME_COLUMN, name: "bits", sourceName: "bits", type: "bit(4)" },
    ];
    const queryColumns = columns.map((column) => ({
      name: column.name,
      databaseType: column.type,
      nullable: true,
    }));
    const invalid = buildTableMutationPlan({
      database: "shop",
      table: "typed_values",
      queryColumns,
      schema: columns,
      updatedRows: new Map(),
      deletedRows: new Map(),
      insertedRows: [
        new Map([
          ["ratio", "1e-100"],
          ["precise_ratio", "1e-4000"],
          ["state", "missing"],
          ["flags", "x,x"],
          ["bits", ""],
        ]),
        new Map([["bits", "/w=="]]),
      ],
    });

    expect(invalid.errors).toEqual(expect.arrayContaining([
      "ratio：浮点数超出 FLOAT 可表示范围",
      "precise_ratio：浮点数超出可表示范围",
      "state：值不在 ENUM 定义中",
      "flags：值不在 SET 定义中或包含重复项",
      "bits：BIT(4) 必须提供 1 字节 Base64 数据",
      "bits：二进制内容超出 BIT(4) 位范围",
    ]));

    const valid = buildTableMutationPlan({
      database: "shop",
      table: "typed_values",
      queryColumns,
      schema: columns,
      updatedRows: new Map(),
      deletedRows: new Map(),
      insertedRows: [new Map([
        ["ratio", "16777217"],
        ["precise_ratio", "-0"],
        ["float_as_double", "16777217"],
        ["state", "back\\slash"],
        ["flags", "x,O'Reilly"],
        ["bits", "Cg=="],
      ])],
    });

    expect(valid.errors).toEqual([]);
    expect(valid.mutations[0]).toMatchObject({
      type: "insert",
      values: expect.arrayContaining([
        { name: "ratio", value: { kind: "float", value: "16777216" } },
        { name: "precise_ratio", value: { kind: "float", value: "-0" } },
        { name: "float_as_double", value: { kind: "float", value: "16777217" } },
        { name: "state", value: { kind: "text", value: "back\\slash" } },
      ]),
    });
  });

  it("locks spatial and unknown column attributes out of visual reconstruction", () => {
    expect(isStructureColumnEditable({ ...NAME_COLUMN, type: "geometry" })).toBe(false);
    expect(isStructureColumnEditable({ ...NAME_COLUMN, extra: "mystery_attribute" })).toBe(false);
    expect(isStructureColumnEditable({ ...NAME_COLUMN, extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP" })).toBe(true);
    expect(isStructureColumnEditable({ ...NAME_COLUMN, type: "varbinary(4)", defaultValue: "0x" })).toBe(false);
    expect(isStructureColumnEditable({
      ...NAME_COLUMN,
      type: "json",
      defaultValue: "json_object()",
      defaultExpression: true,
    })).toBe(false);
    expect(isStructureColumnEditable({
      ...NAME_COLUMN,
      generationExpression: "(`id` + 1)",
      extra: "STORED GENERATED",
    })).toBe(false);
    expect(isStructureColumnEditable({
      ...NAME_COLUMN,
      type: "timestamp(3)",
      defaultValue: "CURRENT_TIMESTAMP(3)",
      defaultExpression: true,
      extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)",
      characterSet: null,
      collation: null,
    })).toBe(true);
  });

  it("parenthesizes non-timestamp expression defaults when generating a new column", () => {
    const expressionColumn: TableColumnDefinition = {
      ...NAME_COLUMN,
      sourceName: null,
      name: "payload",
      type: "json",
      defaultValue: "json_object()",
      defaultExpression: true,
      characterSet: null,
      collation: null,
    };

    expect(buildDdlStatements("shop", "orders", [], [expressionColumn])).toEqual([
      "ALTER TABLE `shop`.`orders` ADD COLUMN `payload` json NULL DEFAULT (json_object());",
    ]);
  });

  it("keeps NULL and CURRENT_TIMESTAMP as text defaults on character columns", () => {
    const nullText = {
      ...NAME_COLUMN,
      sourceName: null,
      name: "null_text",
      defaultValue: "NULL",
      characterSet: null,
      collation: null,
    };
    const timestampText = {
      ...nullText,
      name: "timestamp_text",
      defaultValue: "CURRENT_TIMESTAMP",
    };

    expect(buildDdlStatements("shop", "orders", [], [nullText, timestampText])).toEqual([
      "ALTER TABLE `shop`.`orders` ADD COLUMN `null_text` varchar(50) NULL DEFAULT X'4E554C4C';",
      "ALTER TABLE `shop`.`orders` ADD COLUMN `timestamp_text` varchar(50) NULL DEFAULT X'43555252454E545F54494D455354414D50';",
    ]);
  });

  it("requires explicit SQL for defaults whose metadata needs a type expression", () => {
    expect(columnDefaultValidationError({
      ...NAME_COLUMN,
      type: "varbinary(4)",
      defaultValue: "AAEC",
      characterSet: null,
      collation: null,
    })).toMatch(/显式类型表达式/u);
    expect(columnDefaultValidationError({
      ...NAME_COLUMN,
      type: "json",
      defaultValue: "json_object()",
      defaultExpression: true,
      characterSet: null,
      collation: null,
    })).toBeNull();
  });

  it("rejects executable or complex raw type grammar in the visual DDL editor", () => {
    const injected = { ...NAME_COLUMN, type: "varchar(20); DROP TABLE users" };
    expect(columnTypeValidationError(injected.type)).toMatch(/不支持的复杂语法/u);
    expect(buildDdlStatements("shop", "orders", [NAME_COLUMN], [injected])).toEqual([]);
    expect(isStructureColumnEditable({ ...NAME_COLUMN, type: "enum('a','b')" })).toBe(false);
  });

  it("round-trips visual type parts without changing untouched COLUMN_TYPE strings", () => {
    for (const sample of [
      "bigint unsigned",
      "bigint(20) unsigned",
      "varchar(140)",
      "decimal(10,2) unsigned",
      "timestamp(3)",
      "int",
      "double(10,2) unsigned zerofill",
    ]) {
      const parsed = parseMysqlColumnType(sample);
      expect(parsed).not.toBeNull();
      expect(formatMysqlColumnType(parsed!)).toBe(sample);
    }
    expect(parseMysqlColumnType("enum('a','b')")).toBeNull();
    expect(formatMysqlColumnType({
      baseType: "bigint",
      lengthArgs: "20",
      unsigned: true,
      zerofill: false,
    })).toBe("bigint(20) unsigned");
    expect(formatMysqlColumnType({
      baseType: "varchar",
      lengthArgs: "50",
      unsigned: true,
      zerofill: true,
    })).toBe("varchar(50)");
  });

  it("does not emit CHANGE when only parse/format is applied", () => {
    const draft = {
      ...ID_COLUMN,
      type: formatMysqlColumnType(parseMysqlColumnType(ID_COLUMN.type)!),
    };
    expect(buildDdlStatements("shop", "orders", [ID_COLUMN], [draft])).toEqual([]);
  });

  it("suggests MySQL base types by prefix and substring", () => {
    expect(suggestMysqlBaseTypes("in")).toEqual(expect.arrayContaining(["int", "integer"]));
    expect(suggestMysqlBaseTypes("in")[0]).toBe("int");
    expect(suggestMysqlBaseTypes("bi")[0]).toBe("bigint");
    expect(suggestMysqlBaseTypes("var")).toEqual(expect.arrayContaining(["varchar", "varbinary"]));
  });

  it("parses table-level COMMENT from SHOW CREATE TABLE without taking column comments", () => {
    const createSql = [
      "CREATE TABLE `orders` (",
      "  `id` int NOT NULL COMMENT '主键',",
      "  `name` varchar(50) COMMENT '名字''测试'",
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表''主表';",
    ].join("\n");
    expect(parseCreateTableComment(createSql)).toBe("订单表'主表");
    expect(parseCreateTableComment("CREATE TABLE `t` (`id` int)")).toBe("");
    expect(buildAlterTableCommentStatement("shop", "orders", "订单表")).toBe(
      "ALTER TABLE `shop`.`orders` COMMENT = X'E8AEA2E58D95E8A1A8';",
    );
  });
});
