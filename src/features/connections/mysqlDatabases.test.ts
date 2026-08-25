import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CellValue } from "../../bindings/CellValue";
import {
  buildShowTablesStatement,
  countDatabaseTables,
  isSystemDatabase,
  listMySqlDatabases,
} from "./mysqlDatabases";

const executeQueryOnce = vi.hoisted(() => vi.fn());

vi.mock("../query/executeQueryOnce", () => ({ executeQueryOnce }));

/** Builds one streamed text row for the schema metadata query. */
function schemaRow(name: string, charset: string, collation: string): CellValue[] {
  return [
    { kind: "text", value: name },
    { kind: "text", value: charset },
    { kind: "text", value: collation },
  ];
}

/** Registers the schema listing and safety tests. */
function registerMySqlDatabaseTests(): void {
  beforeEach(() => {
    executeQueryOnce.mockReset();
  });

  it("lists user schemas before server-managed ones", async () => {
    executeQueryOnce.mockResolvedValue({
      columns: [],
      affectedRows: 0,
      rows: [
        schemaRow("information_schema", "utf8mb3", "utf8mb3_general_ci"),
        schemaRow("shop", "utf8mb4", "utf8mb4_0900_ai_ci"),
        schemaRow("mysql", "utf8mb4", "utf8mb4_0900_ai_ci"),
        schemaRow("analytics", "utf8mb4", "utf8mb4_bin"),
      ],
    });

    const databases = await listMySqlDatabases("connection-1");

    expect(databases.map((database) => database.name)).toEqual([
      "analytics",
      "shop",
      "information_schema",
      "mysql",
    ]);
    expect(databases.map((database) => database.system)).toEqual([false, false, true, true]);
    expect(databases[0]).toEqual({
      name: "analytics",
      charset: "utf8mb4",
      collation: "utf8mb4_bin",
      system: false,
    });
  });

  it("reads the visible set from INFORMATION_SCHEMA so grants are honored", async () => {
    executeQueryOnce.mockResolvedValue({ columns: [], rows: [], affectedRows: 0 });

    await listMySqlDatabases("connection-1");

    const [connectionId, sql] = executeQueryOnce.mock.calls[0] ?? [];
    expect(connectionId).toBe("connection-1");
    expect(sql).toContain("INFORMATION_SCHEMA.SCHEMATA");
    // A per-query database override is rejected for MySQL at the IPC boundary, so this must not
    // pass one; the statement is self-contained instead.
    expect(executeQueryOnce.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("skips rows without a schema name", async () => {
    executeQueryOnce.mockResolvedValue({
      columns: [],
      affectedRows: 0,
      rows: [schemaRow("", "utf8mb4", "utf8mb4_bin"), [{ kind: "null" }, { kind: "null" }, { kind: "null" }]],
    });

    expect(await listMySqlDatabases("connection-1")).toEqual([]);
  });

  it("classifies server-managed schemas case-insensitively", () => {
    expect(isSystemDatabase("mysql")).toBe(true);
    expect(isSystemDatabase("PERFORMANCE_SCHEMA")).toBe(true);
    expect(isSystemDatabase("sys")).toBe(true);
    expect(isSystemDatabase("information_schema")).toBe(true);
    expect(isSystemDatabase("shop")).toBe(false);
    expect(isSystemDatabase("mysql_backup")).toBe(false);
  });

  it("quotes the schema as an identifier when listing tables", () => {
    expect(buildShowTablesStatement("shop")).toBe("SHOW FULL TABLES FROM `shop`;");
    // A hostile schema name stays inside one identifier token.
    expect(buildShowTablesStatement("shop`; DROP DATABASE x; --"))
      .toBe("SHOW FULL TABLES FROM `shop``; DROP DATABASE x; --`;");
  });

  it("encodes the schema as a literal when counting tables", async () => {
    executeQueryOnce.mockResolvedValue({
      columns: [],
      rows: [[{ kind: "integer", value: "42" }]],
      affectedRows: 0,
    });

    expect(await countDatabaseTables("connection-1", "sho'p")).toBe(42);
    expect(executeQueryOnce.mock.calls[0]?.[1]).toContain("TABLE_SCHEMA = 'sho''p'");
  });

  it("treats an unreadable count as zero", async () => {
    executeQueryOnce.mockResolvedValue({ columns: [], rows: [], affectedRows: 0 });

    expect(await countDatabaseTables("connection-1", "shop")).toBe(0);
  });
}

describe("mysqlDatabases", registerMySqlDatabaseTests);
