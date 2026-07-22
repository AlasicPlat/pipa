import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";

export interface TableColumnDefinition {
  sourceName: string | null;
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  comment: string;
  primary: boolean;
  extra: string;
}

export type EditableCellValue = string | null;

interface DmlSqlInput {
  database: string;
  table: string;
  queryColumns: QueryColumn[];
  rows: CellValue[][];
  schema: TableColumnDefinition[];
  updatedRows: ReadonlyMap<number, ReadonlyMap<string, EditableCellValue>>;
  deletedRows: ReadonlySet<number>;
  insertedRows: ReadonlyArray<ReadonlyMap<string, EditableCellValue>>;
}

/**
 * Escapes a MySQL identifier without allowing user-controlled SQL structure.
 * @param identifier - Database, table, or column identifier.
 * @returns A backtick-quoted MySQL identifier.
 * Side effects: none.
 */
export function quoteIdentifier(identifier: string): string {
  return `\`${identifier.split("`").join("``")}\``;
}

/**
 * Converts one transport cell into its lossless editable text representation.
 * @param cell - Optional transport-safe database cell.
 * @returns Editable text or null for SQL NULL.
 * Side effects: none.
 */
export function cellValueToEditable(cell: CellValue | undefined): EditableCellValue {
  if (!cell || cell.kind === "null") {
    return null;
  }
  if (cell.kind === "boolean") {
    return cell.value ? "1" : "0";
  }
  if (cell.kind === "json") {
    return JSON.stringify(cell.value);
  }
  if (cell.kind === "binary") {
    return cell.value;
  }
  return String(cell.value);
}

/**
 * Produces ALTER TABLE statements by comparing source columns with the visual draft.
 * @param database - Owning database name.
 * @param table - Target table name.
 * @param originalColumns - Latest server-backed schema snapshot.
 * @param draftColumns - User-edited visual schema.
 * @returns Ordered native MySQL DDL statements.
 * Side effects: none.
 */
export function buildDdlStatements(
  database: string,
  table: string,
  originalColumns: readonly TableColumnDefinition[],
  draftColumns: readonly TableColumnDefinition[],
): string[] {
  const target = `${quoteIdentifier(database)}.${quoteIdentifier(table)}`;
  const retainedSourceNames = new Set(
    draftColumns.flatMap((column) => (column.sourceName === null ? [] : [column.sourceName])),
  );
  const statements = originalColumns
    .filter((column) => !retainedSourceNames.has(column.name))
    .map((column) => `ALTER TABLE ${target} DROP COLUMN ${quoteIdentifier(column.name)};`);

  for (const column of draftColumns) {
    if (column.sourceName === null) {
      statements.push(`ALTER TABLE ${target} ADD COLUMN ${columnSql(column)};`);
      continue;
    }
    const original = originalColumns.find((item) => item.name === column.sourceName);
    if (original && !sameColumn(original, column)) {
      statements.push(
        `ALTER TABLE ${target} CHANGE COLUMN ${quoteIdentifier(column.sourceName)} ${columnSql(column)};`,
      );
    }
  }
  return statements;
}

/**
 * Produces primary-key-scoped SQL for the staged data change set.
 * @param input - Target, result snapshot, schema, and local row changes.
 * @returns Ordered native MySQL DML statements without transaction wrappers.
 * Side effects: none.
 */
export function buildDmlStatements({
  database,
  table,
  queryColumns,
  rows,
  schema,
  updatedRows,
  deletedRows,
  insertedRows,
}: DmlSqlInput): string[] {
  const primaryColumns = schema.filter((column) => column.primary);
  const target = `${quoteIdentifier(database)}.${quoteIdentifier(table)}`;
  const typeByName = new Map(schema.map((column) => [column.name, column.type]));
  const columnIndexByName = new Map(queryColumns.map((column, index) => [column.name, index]));
  const statements: string[] = [];

  for (const [rowIndex, updates] of updatedRows) {
    if (deletedRows.has(rowIndex) || primaryColumns.length === 0) {
      continue;
    }
    const assignments = [...updates]
      .filter(([columnName, value]) => {
        const columnIndex = columnIndexByName.get(columnName);
        return cellValueToEditable(rows[rowIndex]?.[columnIndex ?? -1]) !== value;
      })
      .map(
        ([columnName, value]) =>
          `${quoteIdentifier(columnName)} = ${sqlLiteral(value, typeByName.get(columnName) ?? "")}`,
      );
    if (assignments.length > 0) {
      statements.push(
        `UPDATE ${target} SET ${assignments.join(", ")} WHERE ${primaryPredicate(
          primaryColumns,
          rows[rowIndex] ?? [],
          columnIndexByName,
        )};`,
      );
    }
  }

  for (const rowIndex of deletedRows) {
    if (primaryColumns.length > 0) {
      statements.push(
        `DELETE FROM ${target} WHERE ${primaryPredicate(
          primaryColumns,
          rows[rowIndex] ?? [],
          columnIndexByName,
        )};`,
      );
    }
  }

  for (const insertedRow of insertedRows) {
    const values = queryColumns.map((column) => insertedRow.get(column.name) ?? null);
    statements.push(
      `INSERT INTO ${target} (${queryColumns.map((column) => quoteIdentifier(column.name)).join(", ")}) VALUES (${values
        .map((value, index) => sqlLiteral(value, typeByName.get(queryColumns[index]?.name ?? "") ?? ""))
        .join(", ")});`,
    );
  }

  return statements;
}

/**
 * Formats one complete MySQL column definition for ADD or CHANGE.
 * @param column - Visual column definition.
 * @returns Native MySQL column SQL.
 * Side effects: none.
 */
function columnSql(column: TableColumnDefinition): string {
  const pieces = [
    quoteIdentifier(column.name),
    column.type.trim() || "VARCHAR(255)",
    column.nullable ? "NULL" : "NOT NULL",
  ];
  if (column.defaultValue !== null) {
    pieces.push(`DEFAULT ${defaultLiteral(column.defaultValue, column.type)}`);
  }
  if (column.extra.trim()) {
    pieces.push(column.extra.trim());
  }
  if (column.comment) {
    pieces.push(`COMMENT ${quotedString(column.comment)}`);
  }
  return pieces.join(" ");
}

/**
 * Compares only fields managed or preserved by the visual structure editor.
 * @param left - Server-backed column definition.
 * @param right - Current visual draft.
 * @returns Whether generated SQL would be unchanged.
 * Side effects: none.
 */
function sameColumn(left: TableColumnDefinition, right: TableColumnDefinition): boolean {
  return (
    left.name === right.name &&
    left.type === right.type &&
    left.nullable === right.nullable &&
    left.defaultValue === right.defaultValue &&
    left.comment === right.comment &&
    left.extra === right.extra
  );
}

/**
 * Builds an exact primary-key predicate from the row's original values.
 * @param primaryColumns - Schema columns participating in the primary key.
 * @param row - Original database row.
 * @param columnIndexByName - Result-set position lookup.
 * @returns A native MySQL predicate joined with AND.
 * Side effects: none.
 */
function primaryPredicate(
  primaryColumns: readonly TableColumnDefinition[],
  row: readonly CellValue[],
  columnIndexByName: ReadonlyMap<string, number>,
): string {
  return primaryColumns
    .map((column) => {
      const value = cellValueToEditable(row[columnIndexByName.get(column.name) ?? -1]);
      return value === null
        ? `${quoteIdentifier(column.name)} IS NULL`
        : `${quoteIdentifier(column.name)} = ${sqlLiteral(value, column.type)}`;
    })
    .join(" AND ");
}

/**
 * Formats an edited value according to its MySQL column type.
 * @param value - Staged cell value.
 * @param databaseType - Database-native type name.
 * @returns A safe SQL literal.
 * Side effects: none.
 */
function sqlLiteral(value: EditableCellValue, databaseType: string): string {
  if (value === null) {
    return "NULL";
  }
  const normalizedType = databaseType.toLowerCase();
  if (
    /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit)/.test(
      normalizedType,
    ) &&
    /^-?(?:\d+|\d*\.\d+)$/.test(value.trim())
  ) {
    return value.trim();
  }
  return quotedString(value);
}

/**
 * Keeps recognized MySQL default expressions raw and quotes ordinary values.
 * @param value - Visual default-value input.
 * @param databaseType - Database-native type name.
 * @returns A native MySQL default expression.
 * Side effects: none.
 */
function defaultLiteral(value: string, databaseType: string): string {
  const trimmed = value.trim();
  if (/^(?:NULL|CURRENT_TIMESTAMP(?:\(\d+\))?)$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return sqlLiteral(value, databaseType);
}

/**
 * Quotes a MySQL string literal using SQL-standard doubled apostrophes.
 * @param value - Untrusted literal text.
 * @returns A safely quoted SQL string literal.
 * Side effects: none.
 */
function quotedString(value: string): string {
  return `'${value.split("'").join("''")}'`;
}
