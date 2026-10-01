import { describe, expect, it } from "vitest";
import type { CellValue } from "../../bindings/CellValue";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { QueryColumn } from "../../bindings/QueryColumn";
import {
  addTableToCatalog,
  buildDestructiveTableStatement,
  buildDetachedTableDescriptor,
  buildSelectAllStatement,
  buildShowCreateTableStatement,
  buildTableExportFile,
  buildTableNameActionStatements,
  extractCreateTableSql,
  removePinnedTableKey,
  removeTableFromCatalog,
  renamePinnedTableKey,
  renameTableInCatalog,
  tableExportFileBase,
  tableNameActionValidationError,
  togglePinnedTableKey,
} from "./tableActions";

const COLUMNS: QueryColumn[] = [
  { name: "id", databaseType: "bigint unsigned", nullable: false },
  { name: "label", databaseType: "varchar(50)", nullable: true },
];

const ROWS: CellValue[][] = [
  [{ kind: "integer", value: "1" }, { kind: "text", value: "first" }],
  [{ kind: "integer", value: "2" }, { kind: "null" }],
];

const PROFILE: ConnectionProfile = {
  id: "connection-1",
  name: "开发主库",
  engine: "my_sql",
  environment: "development",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  database: "shop",
  tlsMode: "disabled",
};

/** Verifies both generated statements quote their identifiers. */
function assertStatementsQuoteIdentifiers(): void {
  expect(buildShowCreateTableStatement("sh`op", "ord`ers"))
    .toBe("SHOW CREATE TABLE `sh``op`.`ord``ers`;");
  expect(buildSelectAllStatement("shop", "orders"))
    .toBe("SELECT * FROM `shop`.`orders`;");
}

/** Verifies the DDL is read from either column MySQL may return it in. */
function assertCreateTableSqlExtraction(): void {
  expect(extractCreateTableSql({
    columns: COLUMNS,
    rows: [[{ kind: "text", value: "orders" }, { kind: "text", value: "CREATE TABLE `orders` (…)" }]],
  })).toBe("CREATE TABLE `orders` (…)");

  // Some views place the statement in the first column instead.
  expect(extractCreateTableSql({
    columns: COLUMNS,
    rows: [[{ kind: "text", value: "CREATE VIEW `v` AS SELECT 1" }]],
  })).toBe("CREATE VIEW `v` AS SELECT 1");

  // An empty result must not throw.
  expect(extractCreateTableSql({ columns: [], rows: [] })).toBe("NULL");
}

/** Verifies export file names cannot escape into a path or a hidden file. */
function assertExportFileBaseSanitizing(): void {
  expect(tableExportFileBase("shop", "orders")).toBe("shop-orders");
  // Path separators and spaces collapse to underscores.
  expect(tableExportFileBase("a/b", "c d")).toBe("a_b-c_d");
  expect(tableExportFileBase("../etc", "passwd")).toBe(".._etc-passwd");
  // CJK names survive, because they are valid in file names.
  expect(tableExportFileBase("商店", "订单")).toBe("商店-订单");
  // A name with nothing usable falls back rather than producing an empty or separator-only name.
  expect(tableExportFileBase("", "")).toBe("table");
  expect(tableExportFileBase("..", "")).toBe("table");
  // Path separators become underscores, which is safe though not meaningful.
  expect(tableExportFileBase("/", "/")).toBe("_-_");
  expect(tableExportFileBase("x".repeat(60), "y".repeat(60))).toHaveLength(80);
}

/** Verifies each export format serializes its own shape and extension. */
function assertExportFormats(): void {
  const result = { columns: COLUMNS, rows: ROWS };

  const csv = buildTableExportFile("export_csv", "shop", "orders", result);
  expect(csv.fileName).toBe("shop-orders.csv");
  expect(csv.mimeType).toBe("text/csv;charset=utf-8");
  expect(csv.label).toBe("CSV");
  expect(csv.content.split("\n")[0]).toBe("id,label");

  const json = buildTableExportFile("export_json", "shop", "orders", result);
  expect(json.fileName).toBe("shop-orders.json");
  expect(JSON.parse(json.content)).toEqual([
    { id: "1", label: "first" },
    { id: "2", label: null },
  ]);

  const sql = buildTableExportFile("export_sql", "shop", "orders", result);
  expect(sql.fileName).toBe("shop-orders.sql");
  expect(sql.content).toContain("INSERT INTO `shop`.`orders`");
  expect(sql.content).toContain("(1, 'first')");
}

/** Verifies an empty table still produces a valid file in every format. */
function assertEmptyResultExports(): void {
  const empty = { columns: COLUMNS, rows: [] };
  expect(buildTableExportFile("export_json", "shop", "orders", empty).content).toBe("[]");
  // An INSERT with no rows would be invalid SQL, so a comment is emitted instead.
  expect(buildTableExportFile("export_sql", "shop", "orders", empty).content)
    .toBe("-- shop.orders 暂无可导出的数据\n");
  // CSV keeps its header row, which is still useful on its own.
  expect(buildTableExportFile("export_csv", "shop", "orders", empty).content).toBe("id,label");
}

/** Verifies the detached descriptor carries the schema-qualified identity and title. */
function assertDetachedDescriptor(): void {
  const descriptor = buildDetachedTableDescriptor(PROFILE, "shop", "orders");
  expect(descriptor).toEqual({
    kind: "table",
    id: "connection-1\u0000shop\u0000orders",
    connectionId: "connection-1",
    database: "shop",
    tableName: "orders",
    title: "开发主库 · shop.orders",
  });
}

/** Verifies the pin toggle returns a new set and never mutates the previous one. */
function assertPinToggleIsPure(): void {
  const original = new Set(["a"]);

  const added = togglePinnedTableKey(original, "b");
  expect(added.pinned).toBe(true);
  expect([...added.keys].sort()).toEqual(["a", "b"]);
  // The input set must be untouched, so callers can persist exactly what they set.
  expect([...original]).toEqual(["a"]);

  const removed = togglePinnedTableKey(added.keys, "a");
  expect(removed.pinned).toBe(false);
  expect([...removed.keys]).toEqual(["b"]);
  expect(removed.keys).not.toBe(added.keys);
}

/** Confirms TRUNCATE and DROP are built with quoted, schema-qualified names. */
function assertDestructiveStatements(): void {
  expect(buildDestructiveTableStatement("drop", "we`ird", "ta`ble"))
    .toBe("DROP TABLE `we``ird`.`ta``ble`;");
  expect(buildDestructiveTableStatement("truncate", "shop", "orders"))
    .toBe("TRUNCATE TABLE `shop`.`orders`;");
}
/** Confirms rename is one statement and duplicate is one or two. */
function assertNameActionStatements(): void {
  expect(buildTableNameActionStatements("rename", "shop", "orders", "orders_v2", true))
    .toEqual({ primary: "RENAME TABLE `shop`.`orders` TO `shop`.`orders_v2`;", copyRows: null });
  expect(buildTableNameActionStatements("duplicate", "shop", "orders", "orders_copy", false))
    .toEqual({
      primary: "CREATE TABLE `shop`.`orders_copy` LIKE `shop`.`orders`;",
      copyRows: null,
    });
  expect(buildTableNameActionStatements("duplicate", "shop", "orders", "orders_copy", true).copyRows)
    .toBe("INSERT INTO `shop`.`orders_copy` SELECT * FROM `shop`.`orders`;");
}
/** Confirms empty, overlong, unchanged, and dirty-workspace destinations are refused. */
function assertNameActionValidation(): void {
  expect(tableNameActionValidationError("rename", "orders", "", false))
    .toBe("表名不能为空，且不能超过 64 个字符。");
  expect(tableNameActionValidationError("rename", "orders", "o".repeat(65), false))
    .toBe("表名不能为空，且不能超过 64 个字符。");
  expect(tableNameActionValidationError("rename", "orders", "orders", false))
    .toBe("请输入不同的新表名。");
  expect(tableNameActionValidationError("duplicate", "orders", "orders", false))
    .toBe("复制表不能与原表同名。");
  // A rename would orphan the pending edits; duplicating leaves the source untouched.
  expect(tableNameActionValidationError("rename", "orders", "orders_v2", true))
    .toBe("请先提交或撤销该表的本地修改，再重命名。");
  expect(tableNameActionValidationError("duplicate", "orders", "orders_copy", true)).toBeNull();
  expect(tableNameActionValidationError("rename", "orders", "o".repeat(64), false)).toBeNull();
}
/** Confirms catalog edits are immutable and skip renders when nothing changes. */
function assertCatalogTransitions(): void {
  const catalog = { "conn-1": { shop: ["orders", "users"] } };
  expect(removeTableFromCatalog(catalog, "conn-1", "shop", "orders"))
    .toEqual({ "conn-1": { shop: ["users"] } });
  expect(catalog["conn-1"].shop).toEqual(["orders", "users"]);
  // An unknown table, schema, or connection must return the same reference.
  expect(removeTableFromCatalog(catalog, "conn-1", "shop", "gone")).toBe(catalog);
  expect(removeTableFromCatalog(catalog, "conn-1", "other", "orders")).toBe(catalog);
  expect(removeTableFromCatalog(catalog, "conn-gone", "shop", "orders")).toBe(catalog);
  expect(renameTableInCatalog(catalog, "conn-1", "shop", "orders", "orders_v2"))
    .toEqual({ "conn-1": { shop: ["orders_v2", "users"] } });
  expect(renameTableInCatalog(catalog, "conn-1", "shop", "gone", "x")).toBe(catalog);
  expect(addTableToCatalog(catalog, "conn-1", "shop", "audits"))
    .toEqual({ "conn-1": { shop: ["orders", "users", "audits"] } });
  expect(addTableToCatalog(catalog, "conn-1", "shop", "orders")).toBe(catalog);
  expect(addTableToCatalog({}, "conn-1", "shop", "orders"))
    .toEqual({ "conn-1": { shop: ["orders"] } });
}
/** Confirms pin removals and renames report whether persistence is needed. */
function assertPinKeyEdits(): void {
  const pinned = new Set(["a", "b"]);
  const removed = removePinnedTableKey(pinned, "a");
  expect(removed.changed).toBe(true);
  expect([...removed.keys]).toEqual(["b"]);
  expect([...pinned]).toEqual(["a", "b"]);
  expect(removePinnedTableKey(pinned, "missing").changed).toBe(false);
  const renamed = renamePinnedTableKey(pinned, "a", "c");
  expect(renamed.changed).toBe(true);
  expect([...renamed.keys].sort()).toEqual(["b", "c"]);
  expect(renamePinnedTableKey(pinned, "missing", "c").changed).toBe(false);
}
/** Registers the pure table-action helper tests. */
function registerTableActionTests(): void {
  it("quotes identifiers in generated statements", assertStatementsQuoteIdentifiers);
  it("reads CREATE TABLE text from either result column", assertCreateTableSqlExtraction);
  it("sanitizes export file names", assertExportFileBaseSanitizing);
  it("serializes each export format", assertExportFormats);
  it("exports an empty table without invalid output", assertEmptyResultExports);
  it("builds the detached window descriptor", assertDetachedDescriptor);
  it("toggles pins without mutating the previous set", assertPinToggleIsPure);
  it("builds destructive table statements", assertDestructiveStatements);
  it("builds rename and duplicate statements", assertNameActionStatements);
  it("rejects invalid rename and duplicate destinations", assertNameActionValidation);
  it("removes, renames, and adds cached catalog entries", assertCatalogTransitions);
  it("reports whether a pin edit changed anything", assertPinKeyEdits);
}

describe("tableActions", registerTableActionTests);
