import type { CellValue } from "../../bindings/CellValue";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { QueryColumn } from "../../bindings/QueryColumn";
import {
  cellValueToPlainText,
  serializeResultAsCsv,
  serializeRowsAsInsert,
  serializeSelectionAsJson,
} from "../query/resultExport";
import type { DetachedWorkspaceLaunch } from "../workspace/detachedWorkspace";
import { tableTabId, type TableDestructiveAction } from "./TableActionMenu";
import { quoteIdentifier } from "./tableSql";

/** Export formats the table shortcuts can produce. */
export type TableExportAction = "export_csv" | "export_json" | "export_sql";

/** One result set as returned by a single-shot query. */
export interface TableQueryResult {
  columns: QueryColumn[];
  rows: CellValue[][];
}

/** A serialized export, ready to hand to the platform save dialog. */
export interface TableExportFile {
  content: string;
  fileName: string;
  mimeType: string;
  /** Format name used in the completion message. */
  label: string;
}

/**
 * Builds the metadata query that returns one table's server-authored DDL.
 * @param database - Exact schema name.
 * @param tableName - Exact table name.
 * @returns One `SHOW CREATE TABLE` statement with both identifiers quoted.
 * Side effects: none.
 */
export function buildShowCreateTableStatement(database: string, tableName: string): string {
  return `SHOW CREATE TABLE ${quoteIdentifier(database)}.${quoteIdentifier(tableName)};`;
}

/**
 * Builds the query that reads every row of one table for export.
 * @param database - Exact schema name.
 * @param tableName - Exact table name.
 * @returns One unfiltered `SELECT` statement.
 * Side effects: none.
 */
export function buildSelectAllStatement(database: string, tableName: string): string {
  return `SELECT * FROM ${quoteIdentifier(database)}.${quoteIdentifier(tableName)};`;
}

/**
 * Extracts the DDL text from a `SHOW CREATE TABLE` result.
 *
 * MySQL returns the statement in the second column for tables and in the first for some views, so
 * both positions are tried rather than assuming a fixed layout.
 *
 * @param result - Result set from `buildShowCreateTableStatement`.
 * @returns The DDL text, or an empty string when the result carries no usable cell.
 * Side effects: none.
 */
export function extractCreateTableSql(result: TableQueryResult): string {
  return cellValueToPlainText(result.rows[0]?.[1] ?? result.rows[0]?.[0]);
}

/**
 * Derives a filesystem-safe base name for one table export.
 *
 * Latin letters, digits, underscores, CJK characters, dots, and hyphens survive; everything else
 * collapses to `_`, so a schema or table name cannot produce a path separator or a hidden file. The
 * fallback also covers names that sanitize down to separators alone — `""` and `""` joined to a bare
 * `-`, which is truthy and would otherwise have produced a file called `-.csv`.
 *
 * @param database - Exact schema name.
 * @param tableName - Exact table name.
 * @returns A bounded base name, falling back to `table` when nothing usable remains.
 * Side effects: none.
 */
export function tableExportFileBase(database: string, tableName: string): string {
  const sanitized = `${database}-${tableName}`
    .replace(/[^\w\u4e00-\u9fff.-]+/gu, "_")
    .slice(0, 80);
  // A name made only of separators or dots is not a usable file name.
  return /[\w\u4e00-\u9fff]/u.test(sanitized) ? sanitized : "table";
}

/**
 * Serializes one full table result into the requested export format.
 *
 * This is the pure half of the export flow: the caller runs the query and drives the save dialog,
 * while format selection, serialization, and naming happen here.
 *
 * @param action - Requested CSV, JSON, or SQL INSERT format.
 * @param database - Exact schema name, used for the INSERT target and the file name.
 * @param tableName - Exact table name.
 * @param result - Full result set to serialize.
 * @returns The serialized file, its name, and its MIME type.
 * Side effects: none.
 */
export function buildTableExportFile(
  action: TableExportAction,
  database: string,
  tableName: string,
  result: TableQueryResult,
): TableExportFile {
  const fileBase = tableExportFileBase(database, tableName);
  if (action === "export_csv") {
    return {
      content: serializeResultAsCsv(result.columns, result.rows),
      fileName: `${fileBase}.csv`,
      mimeType: "text/csv;charset=utf-8",
      label: "CSV",
    };
  }
  if (action === "export_json") {
    // An empty result has no rectangle to select, so the empty array is emitted directly.
    const content = result.rows.length > 0 && result.columns.length > 0
      ? serializeSelectionAsJson(result.columns, result.rows, {
        startRow: 0,
        startCol: 0,
        endRow: result.rows.length - 1,
        endCol: result.columns.length - 1,
      })
      : "[]";
    return {
      content,
      fileName: `${fileBase}.json`,
      mimeType: "application/json;charset=utf-8",
      label: "JSON",
    };
  }
  return {
    content: serializeRowsAsInsert(result.columns, result.rows, {
      tableName: `${database}.${tableName}`,
      includePrimaryKey: true,
    }) || `-- ${database}.${tableName} 暂无可导出的数据\n`,
    fileName: `${fileBase}.sql`,
    mimeType: "application/sql;charset=utf-8",
    label: "SQL INSERT",
  };
}

/**
 * Builds the descriptor that opens one table in its own native window.
 * @param profile - Connection that owns the table.
 * @param database - Schema that owns the table.
 * @param tableName - Exact table name.
 * @returns A descriptor carrying the tab identity and its display title.
 * Side effects: none.
 */
export function buildDetachedTableDescriptor(
  profile: ConnectionProfile,
  database: string,
  tableName: string,
): DetachedWorkspaceLaunch {
  return {
    kind: "table",
    id: tableTabId(profile.id, database, tableName),
    connectionId: profile.id,
    database,
    tableName,
    title: `${profile.name} · ${database}.${tableName}`,
  };
}

/** One pinned-table toggle: the next set and what the toggle did. */
export interface PinnedTableToggle {
  keys: Set<string>;
  pinned: boolean;
}

/**
 * Toggles one table's pinned state.
 *
 * Returns the next set instead of mutating, and reports the resulting state, so the caller can
 * persist and announce the change outside its state updater. Doing that work inside an updater ran it
 * twice under React StrictMode's double invocation.
 *
 * @param current - Currently pinned table keys.
 * @param key - Connection-bound table identity to toggle.
 * @returns The next set and whether the table ended up pinned.
 * Side effects: none.
 */
export function togglePinnedTableKey(
  current: ReadonlySet<string>,
  key: string,
): PinnedTableToggle {
  const keys = new Set(current);
  if (keys.has(key)) {
    keys.delete(key);
    return { keys, pinned: false };
  }
  keys.add(key);
  return { keys, pinned: true };
}

/**
 * Builds the statement for one confirmed destructive table action.
 * @param action - Whether the table is dropped or emptied.
 * @param database - Schema that owns the table.
 * @param tableName - Exact database-reported table name.
 * @returns One terminated DDL/DML statement.
 */
export function buildDestructiveTableStatement(
  action: TableDestructiveAction,
  database: string,
  tableName: string,
): string {
  const qualifiedTable = `${quoteIdentifier(database)}.${quoteIdentifier(tableName)}`;
  return action === "drop"
    ? `DROP TABLE ${qualifiedTable};`
    : `TRUNCATE TABLE ${qualifiedTable};`;
}

/** The statements one rename or duplicate needs, in execution order. */
export interface TableNameActionStatements {
  /** `RENAME TABLE` for a rename, or `CREATE TABLE … LIKE` for a duplicate. */
  primary: string;
  /** `INSERT INTO … SELECT` when a duplicate must also copy rows, otherwise `null`. */
  copyRows: string | null;
}

/**
 * Builds the statements for one rename or duplicate.
 *
 * A duplicate is two statements rather than one, because MySQL has no single statement that copies
 * both structure and rows; the caller must therefore handle a partial success where the structure
 * exists but the copy failed.
 * @param action - Whether the table is renamed or duplicated.
 * @param database - Schema that owns both the source and the destination.
 * @param tableName - Exact source table name.
 * @param nextTableName - Validated destination table name.
 * @param copyData - Whether a duplicate should also copy rows.
 * @returns The ordered statements to execute.
 */
export function buildTableNameActionStatements(
  action: "rename" | "duplicate",
  database: string,
  tableName: string,
  nextTableName: string,
  copyData: boolean,
): TableNameActionStatements {
  const source = `${quoteIdentifier(database)}.${quoteIdentifier(tableName)}`;
  const destination = `${quoteIdentifier(database)}.${quoteIdentifier(nextTableName)}`;
  return action === "rename"
    ? { primary: `RENAME TABLE ${source} TO ${destination};`, copyRows: null }
    : {
      primary: `CREATE TABLE ${destination} LIKE ${source};`,
      copyRows: copyData ? `INSERT INTO ${destination} SELECT * FROM ${source};` : null,
    };
}

/**
 * Validates one rename or duplicate destination before any statement runs.
 * @param action - Whether the table is renamed or duplicated.
 * @param tableName - Exact source table name.
 * @param nextTableName - Trimmed destination name drafted in the dialog.
 * @param hasDirtyWorkspace - Whether the source table has uncommitted local edits.
 * @returns A message to show in the dialog, or `null` when the request is valid.
 */
export function tableNameActionValidationError(
  action: "rename" | "duplicate",
  tableName: string,
  nextTableName: string,
  hasDirtyWorkspace: boolean,
): string | null {
  if (!nextTableName || nextTableName.length > 64) {
    return "表名不能为空，且不能超过 64 个字符。";
  }
  if (nextTableName === tableName) {
    return action === "rename" ? "请输入不同的新表名。" : "复制表不能与原表同名。";
  }
  /*
   * A rename would leave the open workspace editing a table that no longer exists under that name,
   * so its pending edits could never be committed. Duplicating is safe: the source is untouched.
   */
  if (action === "rename" && hasDirtyWorkspace) {
    return "请先提交或撤销该表的本地修改，再重命名。";
  }
  return null;
}

/** Table names per connection, then per schema. */
export type TableCatalog = Readonly<Record<string, Record<string, string[]>>>;

/**
 * Removes one dropped table from the cached catalog.
 *
 * Returns the same reference when the table was never cached, so callers can pass this straight to a
 * state updater without forcing a render.
 * @param catalog - Current cached catalog.
 * @param connectionId - Connection that owned the table.
 * @param database - Schema that owned the table.
 * @param tableName - Exact dropped table name.
 * @returns The updated catalog, or `catalog` when nothing changed.
 */
export function removeTableFromCatalog(
  catalog: TableCatalog,
  connectionId: string,
  database: string,
  tableName: string,
): TableCatalog {
  const cached = catalog[connectionId]?.[database];
  if (!cached?.includes(tableName)) {
    return catalog;
  }
  return {
    ...catalog,
    [connectionId]: {
      ...catalog[connectionId],
      [database]: cached.filter((cachedName) => cachedName !== tableName),
    },
  };
}

/**
 * Renames one table in the cached catalog, preserving its position.
 * @param catalog - Current cached catalog.
 * @param connectionId - Connection that owns the table.
 * @param database - Schema that owns the table.
 * @param tableName - Exact previous table name.
 * @param nextTableName - Exact new table name.
 * @returns The updated catalog, or `catalog` when the table was not cached.
 */
export function renameTableInCatalog(
  catalog: TableCatalog,
  connectionId: string,
  database: string,
  tableName: string,
  nextTableName: string,
): TableCatalog {
  const cached = catalog[connectionId]?.[database];
  if (!cached?.includes(tableName)) {
    return catalog;
  }
  return {
    ...catalog,
    [connectionId]: {
      ...catalog[connectionId],
      [database]: cached.map(
        (cachedName) => (cachedName === tableName ? nextTableName : cachedName),
      ),
    },
  };
}

/**
 * Adds one newly created table to the cached catalog without duplicating it.
 * @param catalog - Current cached catalog.
 * @param connectionId - Connection that owns the table.
 * @param database - Schema that owns the table.
 * @param tableName - Exact new table name.
 * @returns The updated catalog, or `catalog` when the name was already cached.
 */
export function addTableToCatalog(
  catalog: TableCatalog,
  connectionId: string,
  database: string,
  tableName: string,
): TableCatalog {
  const cached = catalog[connectionId]?.[database] ?? [];
  if (cached.includes(tableName)) {
    return catalog;
  }
  return {
    ...catalog,
    [connectionId]: {
      ...catalog[connectionId],
      [database]: [...cached, tableName],
    },
  };
}

/** One pinned-key edit: the next set and whether anything actually changed. */
export interface PinnedTableKeyEdit {
  /** The resulting set; identical in content to the input when `changed` is false. */
  keys: Set<string>;
  /** Whether the edit altered the set, and therefore needs persisting. */
  changed: boolean;
}

/**
 * Drops one table's pin, if it had one.
 *
 * Reports whether anything changed so the caller can skip both the render and the write to local
 * preferences when the removed table was never pinned.
 * @param current - Currently pinned table keys.
 * @param key - Connection-bound identity of the removed table.
 * @returns The next set and whether it differs from the input.
 */
export function removePinnedTableKey(
  current: ReadonlySet<string>,
  key: string,
): PinnedTableKeyEdit {
  if (!current.has(key)) {
    return { keys: new Set(current), changed: false };
  }
  const keys = new Set(current);
  keys.delete(key);
  return { keys, changed: true };
}

/**
 * Moves one table's pin to its new identity after a rename.
 * @param current - Currently pinned table keys.
 * @param previousKey - Identity the table had before the rename.
 * @param nextKey - Identity the table has now.
 * @returns The next set and whether it differs from the input.
 */
export function renamePinnedTableKey(
  current: ReadonlySet<string>,
  previousKey: string,
  nextKey: string,
): PinnedTableKeyEdit {
  if (!current.has(previousKey)) {
    return { keys: new Set(current), changed: false };
  }
  const keys = new Set(current);
  keys.delete(previousKey);
  keys.add(nextKey);
  return { keys, changed: true };
}
