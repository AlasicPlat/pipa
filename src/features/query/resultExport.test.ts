import { describe, expect, it } from "vitest";
import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";
import { cellValueToPlainText, serializeResultAsCsv, serializeResultAsTsv } from "./resultExport";

const COLUMNS: QueryColumn[] = [
  { name: "id", databaseType: "BIGINT", nullable: false },
  { name: "note", databaseType: "TEXT", nullable: true },
  { name: "payload", databaseType: "JSON", nullable: true },
];

const ROWS: CellValue[][] = [
  [
    { kind: "integer", value: "1" },
    { kind: "text", value: "hello\tworld" },
    { kind: "json", value: { ok: true } },
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
});
