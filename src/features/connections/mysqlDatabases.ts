import { executeQueryOnce } from "../query/executeQueryOnce";
import { mysqlStringLiteral, quoteIdentifier } from "../tables/tableSql";
import type { CellValue } from "../../bindings/CellValue";

/** One schema reachable through a saved MySQL connection. */
export interface MySqlDatabaseInfo {
  name: string;
  charset: string;
  collation: string;
  /** Server-managed schema that users browse but rarely edit. */
  system: boolean;
}

/**
 * Schemas MySQL manages itself.
 *
 * These stay listed so a user can still inspect them, but they are grouped separately so a
 * connection's own databases are not buried among four fixed entries.
 */
const SYSTEM_DATABASES: ReadonlySet<string> = new Set([
  "information_schema",
  "mysql",
  "performance_schema",
  "sys",
]);

/** Reports whether one schema name is managed by the server rather than the user. */
export function isSystemDatabase(name: string): boolean {
  return SYSTEM_DATABASES.has(name.toLowerCase());
}

/**
 * Converts one streamed metadata cell into plain text without losing exact values.
 * @param cell - Optional transport-safe database cell.
 * @returns The cell's text, or an empty string for SQL NULL.
 * Side effects: none.
 */
function cellText(cell: CellValue | undefined): string {
  if (!cell || cell.kind === "null") {
    return "";
  }
  if (cell.kind === "boolean") {
    return cell.value ? "true" : "false";
  }
  if (cell.kind === "binary") {
    return "";
  }
  return String(cell.value);
}

/**
 * Lists every schema the connection's own credential can see.
 *
 * `INFORMATION_SCHEMA.SCHEMATA` is filtered by the server according to the account's grants, so
 * this returns exactly the set the user is allowed to browse — the same set the backend enforces
 * before applying table mutations.
 * @param connectionId - Saved MySQL connection to inspect.
 * @returns User schemas first in name order, then server-managed schemas.
 * Side effects: runs one metadata query; no user query history is recorded.
 */
export async function listMySqlDatabases(connectionId: string): Promise<MySqlDatabaseInfo[]> {
  const result = await executeQueryOnce(
    connectionId,
    "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME\n"
    + "FROM INFORMATION_SCHEMA.SCHEMATA\n"
    + "ORDER BY SCHEMA_NAME;",
  );
  return result.rows
    .map((row) => {
      const name = cellText(row[0]);
      return {
        name,
        charset: cellText(row[1]),
        collation: cellText(row[2]),
        system: isSystemDatabase(name),
      };
    })
    .filter((database) => database.name.length > 0)
    .sort((left, right) => (
      Number(left.system) - Number(right.system)
      || left.name.localeCompare(right.name)
    ));
}

/**
 * Counts the tables and views in one schema.
 * @param connectionId - Saved MySQL connection that owns the schema.
 * @param database - Exact schema name; sent as a bound literal, never as SQL structure.
 * @returns The object count, or 0 when the schema reports none.
 * Side effects: runs one metadata query.
 */
export async function countDatabaseTables(
  connectionId: string,
  database: string,
): Promise<number> {
  const result = await executeQueryOnce(
    connectionId,
    "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES\n"
    + `WHERE TABLE_SCHEMA = ${mysqlStringLiteral(database)};`,
  );
  const count = Number(cellText(result.rows[0]?.[0]));
  return Number.isFinite(count) ? count : 0;
}

/**
 * Builds the statement that lists one schema's tables and views.
 *
 * The schema is embedded as a quoted identifier so a single connection can browse any database it
 * can see without needing a per-query database override on the IPC boundary.
 * @param database - Exact schema name to inspect.
 * @returns One executable MySQL metadata statement.
 * Side effects: none.
 */
export function buildShowTablesStatement(database: string): string {
  return `SHOW FULL TABLES FROM ${quoteIdentifier(database)};`;
}
