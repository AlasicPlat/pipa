import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";
import type { TableMutation } from "../../bindings/TableMutation";
import type { TableMutationField } from "../../bindings/TableMutationField";
import type { TableMutationValue } from "../../bindings/TableMutationValue";

export interface TableColumnDefinition {
  sourceName: string | null;
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  defaultExpression: boolean;
  comment: string;
  primary: boolean;
  extra: string;
  characterSet: string | null;
  collation: string | null;
  generationExpression: string;
}

export type EditableCellValue = string | null;

export interface StagedExistingRow {
  originalRow: readonly CellValue[];
  values: ReadonlyMap<string, EditableCellValue>;
}

interface DmlSqlInput {
  database: string;
  table: string;
  queryColumns: QueryColumn[];
  schema: TableColumnDefinition[];
  updatedRows: ReadonlyMap<string, StagedExistingRow>;
  deletedRows: ReadonlyMap<string, readonly CellValue[]>;
  insertedRows: ReadonlyArray<ReadonlyMap<string, EditableCellValue>>;
}

export interface TableMutationPlan {
  mutations: TableMutation[];
  statements: string[];
  errors: string[];
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
 * 将不可信文本编码为 MySQL 字符串字面量。
 * @param value - 需要作为数据处理的文本。
 * @returns 使用双写引号和反斜杠转义的字符串字面量。
 * Side effects: none.
 */
export function mysqlStringLiteral(value: string): string {
  return `'${value.replace(/\\/gu, "\\\\").replace(/'/gu, "''")}'`;
}

/**
 * Converts one transport cell into its exact editable text representation.
 * @param cell - Optional transport-safe database cell.
 * @returns Editable text or null for SQL NULL; JSON and binary remain raw text/base64.
 * Side effects: none.
 */
export function cellValueToEditable(cell: CellValue | undefined): EditableCellValue {
  if (!cell || cell.kind === "null") {
    return null;
  }
  if (cell.kind === "boolean") {
    return cell.value ? "1" : "0";
  }
  return String(cell.value);
}

/**
 * Builds a stable identity from original primary-key transport values.
 * @param row - Original server row.
 * @param queryColumns - Ordered result columns.
 * @param primaryColumnNames - Ordered primary-key column names.
 * @returns Stable JSON identity, or an empty string when a key column is unavailable.
 * Side effects: none.
 */
export function tableRowIdentity(
  row: readonly CellValue[],
  queryColumns: readonly QueryColumn[],
  primaryColumnNames: readonly string[],
): string {
  if (primaryColumnNames.length === 0) {
    return "";
  }
  const indexes = new Map(queryColumns.map((column, index) => [column.name, index]));
  const identity = primaryColumnNames.map((name) => {
    const index = indexes.get(name);
    return index === undefined ? null : [name, row[index] ?? { kind: "null" }];
  });
  return identity.some((part) => part === null) ? "" : JSON.stringify(identity);
}

/**
 * Returns whether the visual editor can safely reconstruct this existing column definition.
 * @param column - Server-backed column definition.
 * @returns False when metadata cannot be reconstructed losslessly and explicit SQL is required.
 * Side effects: none.
 */
export function isStructureColumnEditable(column: TableColumnDefinition): boolean {
  const normalizedType = column.type.trim().toLowerCase();
  if (
    /^(?:geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/u.test(normalizedType) ||
    column.generationExpression.length > 0 ||
    (column.defaultValue !== null && /^(?:bit|binary|varbinary)\b/u.test(normalizedType)) ||
    (column.defaultExpression && !isCurrentTimestampExpression(column.defaultValue))
  ) {
    return false;
  }
  const knownExtra = column.extra
    .replace(/\bDEFAULT_GENERATED\b/giu, "")
    .replace(/\bAUTO_INCREMENT\b/giu, "")
    .replace(/\b(?:VIRTUAL|STORED) GENERATED\b/giu, "")
    .replace(/\bINVISIBLE\b/giu, "")
    .replace(/\bon update CURRENT_TIMESTAMP(?:\(\d*\))?(?![A-Z0-9_])/giu, "")
    .trim();
  return knownExtra.length === 0 && columnTypeValidationError(column.type) === null;
}

/** Base types offered by the visual structure editor typeahead. */
export const MYSQL_VISUAL_BASE_TYPES = [
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "float",
  "double",
  "real",
  "bit",
  "boolean",
  "bool",
  "date",
  "time",
  "datetime",
  "timestamp",
  "year",
  "char",
  "varchar",
  "binary",
  "varbinary",
  "tinyblob",
  "blob",
  "mediumblob",
  "longblob",
  "tinytext",
  "text",
  "mediumtext",
  "longtext",
  "json",
] as const;

/**
 * Validates the deliberately constrained type grammar accepted by the visual DDL editor.
 * @param databaseType - User-visible MySQL type declaration.
 * @returns A localized error for raw/complex grammar, otherwise null.
 * Side effects: none.
 */
export function columnTypeValidationError(databaseType: string): string | null {
  const safeType = /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|boolean|bool|date|time|datetime|timestamp|year|char|varchar|binary|varbinary|tinyblob|blob|mediumblob|longblob|tinytext|text|mediumtext|longtext|json|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s+unsigned)?(?:\s+zerofill)?$/iu;
  return safeType.test(databaseType.trim())
    ? null
    : "字段类型包含可视化编辑器不支持的复杂语法，请使用显式 ALTER TABLE";
}

/**
 * Suggests visual MySQL base types for typeahead matching.
 * @param query - Partial type text such as `in` or `bi`.
 * @param limit - Maximum number of suggestions to return.
 * @returns Prefix matches first, then substring matches.
 * Side effects: none.
 */
export function suggestMysqlBaseTypes(query: string, limit = 8): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return MYSQL_VISUAL_BASE_TYPES.slice(0, limit);
  }
  const prefixMatches = MYSQL_VISUAL_BASE_TYPES.filter((type) => type.startsWith(normalized));
  const substringMatches = MYSQL_VISUAL_BASE_TYPES.filter(
    (type) => !type.startsWith(normalized) && type.includes(normalized),
  );
  return [...prefixMatches, ...substringMatches].slice(0, limit);
}

/** Parsed parts of a visual MySQL column type declaration. */
export interface ParsedMysqlColumnType {
  baseType: string;
  lengthArgs: string | null;
  unsigned: boolean;
  zerofill: boolean;
}

const UNSIGNED_BASE_TYPES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "float",
  "double",
  "real",
]);

const LENGTH_BASE_TYPES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "float",
  "double",
  "real",
  "bit",
  "year",
  "char",
  "varchar",
  "binary",
  "varbinary",
  "time",
  "datetime",
  "timestamp",
]);

/**
 * Returns whether a MySQL base type can carry the UNSIGNED attribute.
 * @param baseType - Bare type name without length or attributes.
 * @returns True for numeric types that accept UNSIGNED.
 * Side effects: none.
 */
export function typeSupportsUnsigned(baseType: string): boolean {
  return UNSIGNED_BASE_TYPES.has(baseType.trim().toLowerCase());
}

/**
 * Returns whether a MySQL base type commonly accepts a length/precision clause.
 * @param baseType - Bare type name without length or attributes.
 * @returns True when a length column should be editable.
 * Side effects: none.
 */
export function typeSupportsLength(baseType: string): boolean {
  return LENGTH_BASE_TYPES.has(baseType.trim().toLowerCase());
}

/**
 * Returns whether a MySQL type declaration can carry CHARACTER SET / COLLATE.
 * @param databaseType - Full type string such as `varchar(50)`.
 * @returns True for character/text/enum/set types used by DDL generation.
 * Side effects: none.
 */
export function typeSupportsCharset(databaseType: string): boolean {
  return /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/iu.test(databaseType.trim());
}

/**
 * Splits a MySQL COLUMN_TYPE-style declaration into editable parts.
 * @param databaseType - Full type string such as `bigint(20) unsigned`.
 * @returns Parsed parts, or null when the declaration is not a simple visual type.
 * Side effects: none.
 */
export function parseMysqlColumnType(databaseType: string): ParsedMysqlColumnType | null {
  const trimmed = databaseType.trim();
  const match = trimmed.match(
    /^([a-zA-Z]+)(?:\s*\(\s*(\d+(?:\s*,\s*\d+)?)\s*\))?((?:\s+unsigned)?)((?:\s+zerofill)?)$/iu,
  );
  if (!match) {
    return null;
  }
  return {
    baseType: match[1].toLowerCase(),
    lengthArgs: match[2] ? match[2].replace(/\s+/gu, "") : null,
    unsigned: Boolean(match[3]),
    zerofill: Boolean(match[4]),
  };
}

/**
 * Rebuilds a MySQL type declaration from visual editor parts.
 * @param parts - Base type, optional length args, and attribute flags.
 * @returns A lowercase declaration suitable for DDL generation.
 * Side effects: none.
 */
export function formatMysqlColumnType(parts: ParsedMysqlColumnType): string {
  const baseType = parts.baseType.trim().toLowerCase() || "varchar";
  const lengthArgs = parts.lengthArgs?.replace(/\s+/gu, "") ?? "";
  const supportsUnsigned = typeSupportsUnsigned(baseType);
  const pieces = [baseType];
  if (lengthArgs && typeSupportsLength(baseType)) {
    pieces[0] = `${baseType}(${lengthArgs})`;
  }
  if (supportsUnsigned && parts.unsigned) {
    pieces.push("unsigned");
  }
  if (supportsUnsigned && parts.zerofill) {
    pieces.push("zerofill");
  }
  return pieces.join(" ");
}

/**
 * Validates whether an ordinary visual default can be represented without type-specific SQL.
 * @param column - Draft column whose default control is being evaluated.
 * @returns A localized error for advanced defaults, otherwise null.
 * Side effects: none.
 */
export function columnDefaultValidationError(column: TableColumnDefinition): string | null {
  if (column.defaultValue === null || column.defaultExpression || column.generationExpression) {
    return null;
  }
  const baseType = column.type.trim().toLowerCase().match(/^[a-z]+/u)?.[0] ?? "";
  return [
    "bit",
    "binary",
    "varbinary",
    "tinyblob",
    "blob",
    "mediumblob",
    "longblob",
    "tinytext",
    "text",
    "mediumtext",
    "longtext",
    "json",
    "geometry",
    "point",
    "linestring",
    "polygon",
    "multipoint",
    "multilinestring",
    "multipolygon",
    "geometrycollection",
  ].includes(baseType)
    ? "该类型的默认值需要显式类型表达式，请移除默认值并使用原始 ALTER TABLE"
    : null;
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
      if (columnTypeValidationError(column.type) === null) {
        statements.push(`ALTER TABLE ${target} ADD COLUMN ${columnSql(column)};`);
      }
      continue;
    }
    const original = originalColumns.find((item) => item.name === column.sourceName);
    if (
      original &&
      isStructureColumnEditable(original) &&
      columnTypeValidationError(column.type) === null &&
      !sameColumn(original, column)
    ) {
      statements.push(
        `ALTER TABLE ${target} CHANGE COLUMN ${quoteIdentifier(column.sourceName)} ${columnSql(column)};`,
      );
    }
  }
  return statements;
}

/**
 * Builds DDL that updates only the table-level COMMENT option.
 * @param database - Schema name.
 * @param table - Table name.
 * @param comment - New table comment text (empty clears the comment).
 * @returns A single ALTER TABLE statement.
 * Side effects: none.
 */
export function buildAlterTableCommentStatement(database: string, table: string, comment: string): string {
  return `ALTER TABLE ${quoteIdentifier(database)}.${quoteIdentifier(table)} COMMENT = ${mysqlStringLiteral(comment)};`;
}

/**
 * Extracts the table-level COMMENT from SHOW CREATE TABLE output.
 * @param createSql - Native CREATE TABLE text returned by MySQL.
 * @returns Decoded table comment, or an empty string when absent.
 * Side effects: none.
 */
export function parseCreateTableComment(createSql: string): string {
  const options = extractCreateTableOptions(createSql);
  if (!options) {
    return "";
  }
  const match = options.match(/\bCOMMENT\s*=\s*'((?:''|[^'])*)'/iu);
  return match ? decodeMysqlQuotedString(match[1]) : "";
}

/** Returns the table-options suffix after the top-level CREATE TABLE `(...)` list. */
function extractCreateTableOptions(createSql: string): string {
  const start = createSql.indexOf("(");
  if (start < 0) {
    return "";
  }
  let depth = 0;
  let inString: "'" | '"' | "`" | null = null;
  for (let index = start; index < createSql.length; index += 1) {
    const char = createSql[index];
    if (inString) {
      if (char === inString) {
        if (inString === "'" && createSql[index + 1] === "'") {
          index += 1;
          continue;
        }
        inString = null;
      } else if (inString !== "`" && char === "\\" && index + 1 < createSql.length) {
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      inString = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return createSql.slice(index + 1);
      }
    }
  }
  return "";
}

/** Decodes a MySQL single-quoted string body that uses `''` escapes. */
function decodeMysqlQuotedString(value: string): string {
  return value.replace(/''/gu, "'");
}

/**
 * Converts one staged change set into typed backend mutations and a non-executable SQL preview.
 * @param input - Target, schema, immutable original rows, and local edits.
 * @returns Typed mutations, readable SQL previews, and validation errors.
 * Side effects: none.
 */
export function buildTableMutationPlan(input: DmlSqlInput): TableMutationPlan {
  const { database, table, queryColumns, schema, updatedRows, deletedRows, insertedRows } = input;
  const primaryColumns = schema.filter((column) => column.primary);
  const schemaByName = new Map(schema.map((column) => [column.name, column]));
  const columnIndexByName = new Map(queryColumns.map((column, index) => [column.name, index]));
  const mutations: TableMutation[] = [];
  const errors: string[] = [];

  for (const [identity, stagedRow] of updatedRows) {
    if (deletedRows.has(identity) || primaryColumns.length === 0) {
      continue;
    }
    const key = originalKeyFields(stagedRow.originalRow, primaryColumns, columnIndexByName, errors);
    const values: TableMutationField[] = [];
    for (const [columnName, editableValue] of stagedRow.values) {
      const column = schemaByName.get(columnName);
      const columnIndex = columnIndexByName.get(columnName);
      if (!column || columnIndex === undefined) {
        errors.push(`字段 ${columnName} 已不在当前表结构中`);
        continue;
      }
      if (cellValueToEditable(stagedRow.originalRow[columnIndex]) === editableValue) {
        continue;
      }
      const value = editableValueToMutationValue(editableValue, column);
      if (typeof value === "string") {
        errors.push(`${columnName}：${value}`);
      } else {
        values.push({ name: columnName, value });
      }
    }
    if (key && values.length > 0) {
      mutations.push({ type: "update", key, values });
    }
  }

  for (const originalRow of deletedRows.values()) {
    if (primaryColumns.length === 0) {
      continue;
    }
    const key = originalKeyFields(originalRow, primaryColumns, columnIndexByName, errors);
    if (key) {
      mutations.push({ type: "delete", key });
    }
  }

  for (const insertedRow of insertedRows) {
    const values: TableMutationField[] = [];
    for (const [columnName, editableValue] of insertedRow) {
      const column = schemaByName.get(columnName);
      if (!column) {
        errors.push(`字段 ${columnName} 已不在当前表结构中`);
        continue;
      }
      if (column.generationExpression) {
        errors.push(`${columnName}：生成列不能手动赋值`);
        continue;
      }
      const value = editableValueToMutationValue(editableValue, column);
      if (typeof value === "string") {
        errors.push(`${columnName}：${value}`);
      } else {
        values.push({ name: columnName, value });
      }
    }
    mutations.push({ type: "insert", values });
  }

  const target = `${quoteIdentifier(database)}.${quoteIdentifier(table)}`;
  return {
    mutations,
    statements: mutations.map((mutation) => mutationPreview(target, mutation)),
    errors: [...new Set(errors)],
  };
}

/**
 * Produces primary-key-scoped preview SQL for the staged data change set.
 * @param input - Target, schema, immutable original rows, and local edits.
 * @returns Ordered SQL previews without transaction wrappers.
 * Side effects: none.
 */
export function buildDmlStatements(input: DmlSqlInput): string[] {
  return buildTableMutationPlan(input).statements;
}

/** Closed allowlist of comparison operators the quick filter can emit. */
export const TABLE_FILTER_OPERATORS = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "LIKE",
  "NOT LIKE",
  "CONTAINS",
  "STARTS_WITH",
  "ENDS_WITH",
  "IN",
  "NOT IN",
  "BETWEEN",
  "IS NULL",
  "IS NOT NULL",
] as const;

export type TableFilterOperator = (typeof TABLE_FILTER_OPERATORS)[number];

/** Boolean connector applied between the previous condition and this one. */
export type TableFilterConjunction = "AND" | "OR";

export interface TableFilterCondition {
  /** Stable local identifier used as the React key for the condition row. */
  id: string;
  /** Column name that must exist in the current table schema. */
  columnName: string;
  /** Allowlisted comparison operator. */
  operator: TableFilterOperator;
  /** Untrusted user text; ignored for unary operators. */
  value: string;
  /** Connector joining this condition to the preceding one. */
  conjunction: TableFilterConjunction;
  /** Whether this condition participates in the applied WHERE clause. */
  enabled: boolean;
}

/** Human-readable labels for the operator select. */
export const TABLE_FILTER_OPERATOR_LABELS: Readonly<Record<TableFilterOperator, string>> = {
  "=": "等于 (=)",
  "!=": "不等于 (!=)",
  ">": "大于 (>)",
  ">=": "大于等于 (>=)",
  "<": "小于 (<)",
  "<=": "小于等于 (<=)",
  LIKE: "匹配 (LIKE)",
  "NOT LIKE": "不匹配 (NOT LIKE)",
  CONTAINS: "包含",
  STARTS_WITH: "开头是",
  ENDS_WITH: "结尾是",
  IN: "属于 (IN)",
  "NOT IN": "不属于 (NOT IN)",
  BETWEEN: "区间 (BETWEEN)",
  "IS NULL": "为空 (IS NULL)",
  "IS NOT NULL": "不为空 (IS NOT NULL)",
};

const UNARY_FILTER_OPERATORS: ReadonlySet<TableFilterOperator> = new Set<TableFilterOperator>([
  "IS NULL",
  "IS NOT NULL",
]);

const NUMERIC_FILTER_BASE_TYPES: ReadonlySet<string> = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "float",
  "double",
  "real",
  "year",
  "bit",
]);

const TEMPORAL_FILTER_BASE_TYPES: ReadonlySet<string> = new Set([
  "date",
  "time",
  "datetime",
  "timestamp",
]);

const UNFILTERABLE_BASE_TYPES: ReadonlySet<string> = new Set([
  "geometry",
  "point",
  "linestring",
  "polygon",
  "multipoint",
  "multilinestring",
  "multipolygon",
  "geometrycollection",
  "tinyblob",
  "blob",
  "mediumblob",
  "longblob",
  "binary",
  "varbinary",
]);

const ORDERED_FILTER_OPERATORS: readonly TableFilterOperator[] = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "BETWEEN",
  "IN",
  "NOT IN",
  "IS NULL",
  "IS NOT NULL",
];

const TEXT_FILTER_OPERATORS: readonly TableFilterOperator[] = [
  "=",
  "!=",
  "CONTAINS",
  "STARTS_WITH",
  "ENDS_WITH",
  "LIKE",
  "NOT LIKE",
  "IN",
  "NOT IN",
  "IS NULL",
  "IS NOT NULL",
];

const EQUALITY_FILTER_OPERATORS: readonly TableFilterOperator[] = [
  "=",
  "!=",
  "IN",
  "NOT IN",
  "IS NULL",
  "IS NOT NULL",
];

/** Extracts the bare MySQL base type used to classify filter behaviour. */
function filterBaseType(databaseType: string): string {
  return databaseType.trim().toLowerCase().match(/^[a-z]+/u)?.[0] ?? "";
}

/**
 * Returns whether an operator needs no value operand.
 * @param operator - Allowlisted filter operator.
 * @returns True for `IS NULL` and `IS NOT NULL`.
 * Side effects: none.
 */
export function isUnaryFilterOperator(operator: TableFilterOperator): boolean {
  return UNARY_FILTER_OPERATORS.has(operator);
}

/**
 * Returns whether the quick filter can build a predicate for this column type.
 * @param databaseType - Full MySQL COLUMN_TYPE declaration.
 * @returns False for binary and spatial types that need explicit SQL functions.
 * Side effects: none.
 */
export function isFilterableColumnType(databaseType: string): boolean {
  return !UNFILTERABLE_BASE_TYPES.has(filterBaseType(databaseType));
}

/**
 * Chooses the operators that are meaningful for one MySQL column type.
 * @param databaseType - Full MySQL COLUMN_TYPE declaration such as `varchar(50)`.
 * @returns An ordered operator allowlist for the column's select control.
 * Side effects: none.
 */
export function filterOperatorsForColumnType(databaseType: string): readonly TableFilterOperator[] {
  const baseType = filterBaseType(databaseType);
  if (!isFilterableColumnType(databaseType)) {
    return [];
  }
  if (NUMERIC_FILTER_BASE_TYPES.has(baseType) || TEMPORAL_FILTER_BASE_TYPES.has(baseType)) {
    return ORDERED_FILTER_OPERATORS;
  }
  if (baseType === "json" || baseType === "enum" || baseType === "set") {
    return baseType === "json" ? EQUALITY_FILTER_OPERATORS : TEXT_FILTER_OPERATORS;
  }
  return TEXT_FILTER_OPERATORS;
}

/**
 * Returns the placeholder that explains the expected value format for an operator.
 * @param operator - Allowlisted filter operator.
 * @returns Localized hint text, or an empty string for unary operators.
 * Side effects: none.
 */
export function filterValuePlaceholder(operator: TableFilterOperator): string {
  switch (operator) {
    case "IS NULL":
    case "IS NOT NULL":
      return "";
    case "IN":
    case "NOT IN":
      return "多个值用英文逗号分隔";
    case "BETWEEN":
      return "起始值,结束值";
    case "LIKE":
    case "NOT LIKE":
      return "支持 % 与 _ 通配符";
    default:
      return "筛选值";
  }
}

/** Splits a comma-separated list while allowing `\,` to escape a literal comma. */
function splitFilterList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  items.push(current);
  return items;
}

/** Escapes LIKE wildcards so substring operators match user text literally. */
function escapeLikeWildcards(value: string): string {
  return value.replace(/([%_\\])/gu, "\\$1");
}

/**
 * Encodes one filter operand as a MySQL literal that matches its column type.
 * @param value - Untrusted user text.
 * @param column - Column definition selected from the live table schema.
 * @returns A safe literal, or a localized validation error message.
 * Side effects: none.
 */
function filterValueLiteral(value: string, column: TableColumnDefinition): string | { error: string } {
  const baseType = filterBaseType(column.type);
  const trimmed = value.trim();
  if (NUMERIC_FILTER_BASE_TYPES.has(baseType)) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed)) {
      return { error: `${column.name} 需要数值` };
    }
    return trimmed;
  }
  if (TEMPORAL_FILTER_BASE_TYPES.has(baseType)) {
    if (trimmed === "") {
      return { error: `${column.name} 需要时间值` };
    }
    return mysqlStringLiteral(trimmed);
  }
  return mysqlStringLiteral(value);
}

/**
 * Builds one AND/OR-joined predicate for a single enabled condition.
 * @param condition - Draft condition supplied by the filter bar.
 * @param column - Matching column definition from the live table schema.
 * @returns SQL predicate text, or a localized validation error.
 * Side effects: none.
 */
function filterPredicate(
  condition: TableFilterCondition,
  column: TableColumnDefinition,
): string | { error: string } {
  const identifier = quoteIdentifier(column.name);
  if (isUnaryFilterOperator(condition.operator)) {
    return `${identifier} ${condition.operator}`;
  }
  if (condition.operator === "IN" || condition.operator === "NOT IN") {
    const items = splitFilterList(condition.value)
      .map((item) => item.trim())
      .filter((item) => item !== "");
    if (items.length === 0) {
      return { error: `${column.name} 的 ${condition.operator} 需要至少一个值` };
    }
    const literals: string[] = [];
    for (const item of items) {
      const literal = filterValueLiteral(item, column);
      if (typeof literal !== "string") {
        return literal;
      }
      literals.push(literal);
    }
    return `${identifier} ${condition.operator} (${literals.join(", ")})`;
  }
  if (condition.operator === "BETWEEN") {
    const bounds = splitFilterList(condition.value);
    if (bounds.length !== 2 || bounds.some((bound) => bound.trim() === "")) {
      return { error: `${column.name} 的 BETWEEN 需要用逗号分隔的两个值` };
    }
    const lower = filterValueLiteral(bounds[0], column);
    const upper = filterValueLiteral(bounds[1], column);
    if (typeof lower !== "string") {
      return lower;
    }
    if (typeof upper !== "string") {
      return upper;
    }
    return `${identifier} BETWEEN ${lower} AND ${upper}`;
  }
  if (
    condition.operator === "CONTAINS" ||
    condition.operator === "STARTS_WITH" ||
    condition.operator === "ENDS_WITH"
  ) {
    if (condition.value === "") {
      return { error: `${column.name} 需要筛选值` };
    }
    const escaped = escapeLikeWildcards(condition.value);
    const pattern = condition.operator === "CONTAINS"
      ? `%${escaped}%`
      : condition.operator === "STARTS_WITH"
        ? `${escaped}%`
        : `%${escaped}`;
    return `${identifier} LIKE ${mysqlStringLiteral(pattern)} ESCAPE '\\\\'`;
  }
  if (condition.operator === "LIKE" || condition.operator === "NOT LIKE") {
    if (condition.value === "") {
      return { error: `${column.name} 需要筛选值` };
    }
    return `${identifier} ${condition.operator} ${mysqlStringLiteral(condition.value)}`;
  }
  const literal = filterValueLiteral(condition.value, column);
  if (typeof literal !== "string") {
    return literal;
  }
  return `${identifier} ${condition.operator} ${literal}`;
}

export interface TableFilterClause {
  /** Complete clause beginning with ` WHERE`, or an empty string when inactive. */
  where: string;
  /** Localized validation errors that block submission. */
  errors: string[];
  /** Number of conditions contributing to the clause. */
  activeCount: number;
}

/**
 * Compiles quick-filter conditions into one MySQL WHERE clause.
 * @param conditions - Ordered conditions from the filter bar.
 * @param schema - Live table schema that authorizes every referenced column.
 * @returns The clause, its validation errors, and the applied condition count.
 * Side effects: none. Column names are matched against the schema and quoted, operators come from a
 * closed allowlist, and every operand is encoded as a literal, so user text can never alter structure.
 */
export function buildTableFilterClause(
  conditions: readonly TableFilterCondition[],
  schema: readonly TableColumnDefinition[],
): TableFilterClause {
  const columnsByName = new Map(schema.map((column) => [column.name, column]));
  const errors: string[] = [];
  const parts: { predicate: string; conjunction: TableFilterConjunction }[] = [];
  for (const condition of conditions) {
    // A half-written row is incomplete rather than wrong, so it is ignored without an error.
    const incomplete = !isUnaryFilterOperator(condition.operator) && condition.value.trim() === "";
    if (!condition.enabled || condition.columnName === "" || incomplete) {
      continue;
    }
    const column = columnsByName.get(condition.columnName);
    if (!column) {
      errors.push(`字段 ${condition.columnName} 不在当前表结构中`);
      continue;
    }
    if (!TABLE_FILTER_OPERATORS.includes(condition.operator)) {
      errors.push(`字段 ${column.name} 使用了不支持的比较符`);
      continue;
    }
    if (!filterOperatorsForColumnType(column.type).includes(condition.operator)) {
      errors.push(`${column.name}（${column.type}）不支持该比较符`);
      continue;
    }
    const predicate = filterPredicate(condition, column);
    if (typeof predicate !== "string") {
      errors.push(predicate.error);
      continue;
    }
    parts.push({ predicate, conjunction: condition.conjunction });
  }
  if (errors.length > 0 || parts.length === 0) {
    return { where: "", errors: [...new Set(errors)], activeCount: 0 };
  }
  // Mixed AND/OR is grouped strictly left to right so the executed clause matches the visual order
  // instead of silently following MySQL's AND-before-OR precedence.
  const mixed = new Set(parts.slice(1).map((part) => part.conjunction)).size > 1;
  let clause = parts[0].predicate;
  for (const [index, part] of parts.slice(1).entries()) {
    const grouped = mixed && index > 0;
    clause = grouped
      ? `(${clause}) ${part.conjunction} ${part.predicate}`
      : `${clause} ${part.conjunction} ${part.predicate}`;
  }
  return { where: ` WHERE ${clause}`, errors: [], activeCount: parts.length };
}

/**
 * Produces the human-readable summary shown on the collapsed filter bar.
 * @param conditions - Ordered conditions from the filter bar.
 * @returns A compact description of enabled conditions, or an empty string.
 * Side effects: none.
 */
export function describeTableFilter(conditions: readonly TableFilterCondition[]): string {
  const active = conditions.filter((condition) => condition.enabled &&
    condition.columnName !== "" &&
    (isUnaryFilterOperator(condition.operator) || condition.value.trim() !== ""));
  return active
    .map((condition, index) => {
      const label = isUnaryFilterOperator(condition.operator)
        ? `${condition.columnName} ${condition.operator}`
        : `${condition.columnName} ${TABLE_FILTER_OPERATOR_LABELS[condition.operator].replace(/\s*\(.*\)$/u, "")} ${condition.value}`;
      return index === 0 ? label : `${condition.conjunction} ${label}`;
    })
    .join(" ");
}

/**
 * Formats one complete MySQL column definition for ADD or CHANGE.
 * @param column - Visual column definition.
 * @returns Native MySQL column SQL with preserved charset, collation, and generation metadata.
 * Side effects: none.
 */
function columnSql(column: TableColumnDefinition): string {
  const pieces = [quoteIdentifier(column.name), column.type.trim() || "VARCHAR(255)"];
  const characterType = /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/iu.test(
    column.type.trim(),
  );
  if (characterType && column.characterSet) {
    pieces.push(`CHARACTER SET ${quoteIdentifier(column.characterSet)}`);
  }
  if (characterType && column.collation) {
    pieces.push(`COLLATE ${quoteIdentifier(column.collation)}`);
  }
  if (column.generationExpression) {
    const storage = /\bSTORED GENERATED\b/iu.test(column.extra) ? "STORED" : "VIRTUAL";
    pieces.push(`GENERATED ALWAYS AS (${column.generationExpression}) ${storage}`);
  }
  pieces.push(column.nullable ? "NULL" : "NOT NULL");
  if (!column.generationExpression && column.defaultValue !== null) {
    pieces.push(
      `DEFAULT ${column.defaultExpression
        ? expressionDefault(column.defaultValue)
        : defaultLiteral(column.defaultValue, column.type)}`,
    );
  }
  pieces.push(...preservedExtraClauses(column.extra));
  if (column.comment) {
    pieces.push(`COMMENT ${mysqlStringLiteral(column.comment)}`);
  }
  return pieces.join(" ");
}

/** Compares every field reconstructed by the visual structure editor. */
function sameColumn(left: TableColumnDefinition, right: TableColumnDefinition): boolean {
  return (
    left.name === right.name &&
    left.type === right.type &&
    left.nullable === right.nullable &&
    left.defaultValue === right.defaultValue &&
    left.defaultExpression === right.defaultExpression &&
    left.comment === right.comment &&
    left.extra === right.extra &&
    left.characterSet === right.characterSet &&
    left.collation === right.collation &&
    left.generationExpression === right.generationExpression
  );
}

/** Returns only valid column clauses represented by INFORMATION_SCHEMA.EXTRA. */
function preservedExtraClauses(extra: string): string[] {
  const clauses: string[] = [];
  if (/\bAUTO_INCREMENT\b/iu.test(extra)) {
    clauses.push("AUTO_INCREMENT");
  }
  const onUpdate = extra.match(/\bon update (CURRENT_TIMESTAMP(?:\(\d*\))?)/iu)?.[1];
  if (onUpdate) {
    clauses.push(`ON UPDATE ${onUpdate.toUpperCase()}`);
  }
  if (/\bINVISIBLE\b/iu.test(extra)) {
    clauses.push("INVISIBLE");
  }
  return clauses;
}

/** Converts original primary-key cells into typed bound fields. */
function originalKeyFields(
  row: readonly CellValue[],
  primaryColumns: readonly TableColumnDefinition[],
  columnIndexByName: ReadonlyMap<string, number>,
  errors: string[],
): TableMutationField[] | null {
  const fields: TableMutationField[] = [];
  for (const column of primaryColumns) {
    const index = columnIndexByName.get(column.name);
    if (index === undefined || !row[index]) {
      errors.push(`主键字段 ${column.name} 不在当前结果集中`);
      return null;
    }
    fields.push({ name: column.name, value: cellValueToMutationValue(row[index]) });
  }
  return fields;
}

/** Converts a transport value into the matching backend bind type without parsing JSON. */
function cellValueToMutationValue(cell: CellValue): TableMutationValue {
  switch (cell.kind) {
    case "null":
      return { kind: "null" };
    case "boolean":
      return { kind: "boolean", value: cell.value };
    case "integer":
      return { kind: "integer", value: cell.value };
    case "float":
      return { kind: "float", value: String(cell.value) };
    case "decimal":
      return { kind: "decimal", value: cell.value };
    case "text":
      return { kind: "text", value: cell.value };
    case "json":
      return { kind: "json", value: cell.value };
    case "binary":
      return { kind: "binary", value: cell.value };
    case "date_time":
      return { kind: "date_time", value: cell.value };
  }
}

/** Validates edited text and selects the exact backend bind type for its MySQL column. */
function editableValueToMutationValue(
  value: EditableCellValue,
  column: TableColumnDefinition,
): TableMutationValue | string {
  if (value === null) {
    return column.nullable ? { kind: "null" } : "该字段不允许 NULL";
  }
  if (column.generationExpression) {
    return "生成列不能手动赋值";
  }
  const typeDeclaration = column.type.trim();
  const normalizedType = typeDeclaration.toLowerCase();
  const baseType = normalizedType.match(/^[a-z]+/u)?.[0] ?? normalizedType;
  const trimmed = value.trim();

  if (["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "year"].includes(baseType)) {
    if (!/^[+-]?\d+$/u.test(trimmed)) {
      return "请输入有效整数";
    }
    const rangeError = integerRangeError(trimmed, baseType, /\bunsigned\b/u.test(normalizedType));
    return rangeError ?? { kind: "integer", value: BigInt(trimmed).toString() };
  }
  if (["decimal", "numeric"].includes(baseType)) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(trimmed)) {
      return "请输入有效精确小数";
    }
    if (/\bunsigned\b/u.test(normalizedType) && trimmed.startsWith("-")) {
      return "UNSIGNED 小数不能为负数";
    }
    const rangeError = decimalRangeError(trimmed, normalizedType);
    return rangeError ?? { kind: "decimal", value: trimmed };
  }
  if (["float", "double", "real"].includes(baseType)) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed)) {
      return "请输入有效浮点数";
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || (parsed === 0 && hasNonZeroMantissa(trimmed))) {
      return "浮点数超出可表示范围";
    }
    if (/\bunsigned\b/u.test(normalizedType) && (parsed < 0 || Object.is(parsed, -0))) {
      return "UNSIGNED 浮点数不能为负数";
    }
    const scaleError = floatingScaleError(trimmed, normalizedType);
    if (scaleError) {
      return scaleError;
    }
    const normalized = usesSinglePrecisionFloat(normalizedType, baseType) ? Math.fround(parsed) : parsed;
    if (!Number.isFinite(normalized) || (normalized === 0 && parsed !== 0)) {
      return "浮点数超出 FLOAT 可表示范围";
    }
    return { kind: "float", value: numberToExactText(normalized) };
  }
  if (baseType === "json") {
    try {
      JSON.parse(value);
      return { kind: "json", value };
    } catch {
      return "请输入有效 JSON";
    }
  }
  if (["bit", "binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"].includes(baseType)) {
    if (!isValidBase64(trimmed)) {
      return "二进制字段请输入标准 Base64";
    }
    const lengthError = binaryLengthError(trimmed, normalizedType, baseType);
    return lengthError ?? { kind: "binary", value: trimmed };
  }
  if (["geometry", "point", "linestring", "polygon", "multipoint", "multilinestring", "multipolygon", "geometrycollection"].includes(baseType)) {
    return "空间字段暂不允许可视化修改，请使用显式空间函数";
  }
  if (baseType === "enum" || baseType === "set") {
    const allowedValues = parseEnumSetValues(typeDeclaration, baseType);
    if (!allowedValues) {
      return `${baseType.toUpperCase()} 定义无法安全解析，请使用显式 SQL`;
    }
    if (baseType === "enum") {
      return allowedValues.includes(value)
        ? { kind: "text", value }
        : `值不在 ENUM 定义中`;
    }
    const selectedValues = value === "" ? [] : value.split(",");
    if (new Set(selectedValues).size !== selectedValues.length || selectedValues.some((item) => !allowedValues.includes(item))) {
      return "值不在 SET 定义中或包含重复项";
    }
    return { kind: "text", value };
  }
  if (["date", "time", "datetime", "timestamp"].includes(baseType)) {
    return isValidTemporal(trimmed, baseType, normalizedType)
      ? { kind: "date_time", value: trimmed }
      : "时间格式无效";
  }
  const textLengthError = textValueLengthError(value, normalizedType, baseType);
  if (textLengthError) {
    return textLengthError;
  }
  return { kind: "text", value };
}

/** Returns a type-specific integer range error, retaining BIGINT values as BigInt. */
function integerRangeError(value: string, baseType: string, unsigned: boolean): string | null {
  if (baseType === "year") {
    const year = BigInt(value);
    return year === 0n || (year >= 1901n && year <= 2155n) ? null : "YEAR 仅允许 0 或 1901–2155";
  }
  const bits = { tinyint: 8n, smallint: 16n, mediumint: 24n, int: 32n, integer: 32n, bigint: 64n }[baseType];
  if (bits === undefined) {
    return null;
  }
  const integer = BigInt(value);
  const minimum = unsigned ? 0n : -(2n ** (bits - 1n));
  const maximum = unsigned ? 2n ** bits - 1n : 2n ** (bits - 1n) - 1n;
  return integer < minimum || integer > maximum ? `超出 ${baseType.toUpperCase()}${unsigned ? " UNSIGNED" : ""} 范围` : null;
}

/** Validates DECIMAL(M,D) integer and fraction widths before MySQL can round or truncate them. */
function decimalRangeError(value: string, databaseType: string): string | null {
  const precision = databaseType.match(/^(?:decimal|numeric)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/u);
  if (!precision) {
    return null;
  }
  const totalDigits = Number(precision[1]);
  const fractionDigits = Number(precision[2]);
  const unsignedValue = value.replace(/^[+-]/u, "");
  const [integerPart = "", fractionPart = ""] = unsignedValue.split(".");
  const integerDigits = integerPart.replace(/^0+/u, "").length;
  if (fractionPart.length > fractionDigits || integerDigits > totalDigits - fractionDigits) {
    return `超出 DECIMAL(${totalDigits},${fractionDigits}) 范围或小数位数`;
  }
  return null;
}

/** Validates legacy FLOAT/DOUBLE(M,D) scale before the server can round it. */
function floatingScaleError(value: string, databaseType: string): string | null {
  const fixedScale = databaseType.match(/^(?:float|double|real)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/u);
  if (!fixedScale) {
    return null;
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) {
    return "FLOAT/DOUBLE(M,D) 请输入不带指数的普通小数";
  }
  const rangeError = decimalRangeError(
    value,
    `decimal(${fixedScale[1] ?? "0"},${fixedScale[2] ?? "0"})`,
  );
  return rangeError ? `超出 ${databaseType.toUpperCase()} 范围或小数位数` : null;
}

/** Resolves MySQL FLOAT(p): p <= 24 is single precision, while p >= 25 is double precision. */
function usesSinglePrecisionFloat(databaseType: string, baseType: string): boolean {
  if (baseType !== "float") {
    return false;
  }
  const precision = databaseType.match(
    /^float\s*\(\s*(\d+)\s*\)(?:\s+unsigned)?(?:\s+zerofill)?$/u,
  )?.[1];
  return precision === undefined || Number(precision) <= 24;
}

/** Checks canonical padded Base64 text, allowing the empty byte sequence. */
function isValidBase64(value: string): boolean {
  return value === "" || /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

/** Validates binary byte length against fixed/variable binary and BLOB family limits. */
function binaryLengthError(value: string, databaseType: string, baseType: string): string | null {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const byteLength = value.length / 4 * 3 - padding;
  const declaredLength = databaseType.match(/^(?:bit|binary|varbinary)\s*\(\s*(\d+)\s*\)/u)?.[1];
  if (declaredLength) {
    const bitLength = Number(declaredLength);
    const maximum = baseType === "bit" ? Math.ceil(bitLength / 8) : bitLength;
    if (baseType === "bit" && byteLength !== maximum) {
      return `BIT(${bitLength}) 必须提供 ${maximum} 字节 Base64 数据`;
    }
    if (byteLength > maximum) {
      return `二进制内容超过 ${databaseType.toUpperCase()} 容量`;
    }
    if (baseType === "bit" && byteLength === maximum && bitLength % 8 !== 0) {
      const firstByte = base64FirstByte(value);
      if (firstByte !== null && firstByte >= 2 ** (bitLength % 8)) {
        return `二进制内容超出 BIT(${bitLength}) 位范围`;
      }
    }
  }
  const blobMaximum = { tinyblob: 255, blob: 65_535, mediumblob: 16_777_215 }[baseType];
  return blobMaximum !== undefined && byteLength > blobMaximum
    ? `二进制内容超过 ${baseType.toUpperCase()} 容量`
    : null;
}

/** Returns the first decoded byte from already validated standard Base64 text. */
function base64FirstByte(value: string): number | null {
  if (value.length < 2) {
    return null;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const high = alphabet.indexOf(value[0] ?? "");
  const low = alphabet.indexOf(value[1] ?? "");
  return high < 0 || low < 0 ? null : (high << 2) | (low >> 4);
}

/** Detects non-zero decimal mantissas after JavaScript numeric parsing underflows to zero. */
function hasNonZeroMantissa(value: string): boolean {
  return /[1-9]/u.test(value.split(/[eE]/u, 1)[0] ?? "");
}

/** Formats one finite JavaScript number while retaining the sign of negative zero. */
function numberToExactText(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/** Parses the quoted member list returned by MySQL for ENUM and SET column types. */
function parseEnumSetValues(databaseType: string, baseType: "enum" | "set"): string[] | null {
  const prefix = new RegExp(`^${baseType}\\s*\\(`, "iu").exec(databaseType);
  if (!prefix) {
    return null;
  }
  const values: string[] = [];
  let index = prefix[0].length;
  while (index < databaseType.length) {
    while (/\s/u.test(databaseType[index] ?? "")) {
      index += 1;
    }
    if (databaseType[index] !== "'") {
      return null;
    }
    index += 1;
    let member = "";
    let closed = false;
    while (index < databaseType.length) {
      const character = databaseType[index] ?? "";
      const next = databaseType[index + 1] ?? "";
      if (character === "'" && next === "'") {
        member += "'";
        index += 2;
      } else if (character === "'") {
        index += 1;
        closed = true;
        break;
      } else if (character === "\\" && next) {
        const escapes: Record<string, string> = {
          "0": "\0",
          b: "\b",
          n: "\n",
          r: "\r",
          t: "\t",
          Z: "\u001A",
        };
        member += escapes[next] ?? next;
        index += 2;
      } else {
        member += character;
        index += 1;
      }
    }
    if (!closed) {
      return null;
    }
    values.push(member);
    while (/\s/u.test(databaseType[index] ?? "")) {
      index += 1;
    }
    if (databaseType[index] === ",") {
      index += 1;
      continue;
    }
    if (databaseType[index] === ")" && databaseType.slice(index + 1).trim() === "") {
      return values;
    }
    return null;
  }
  return null;
}

/** Validates character and TEXT byte lengths before permissive SQL modes can truncate data. */
function textValueLengthError(value: string, databaseType: string, baseType: string): string | null {
  const declaredLength = databaseType.match(/^(?:char|varchar)\s*\(\s*(\d+)\s*\)/u)?.[1];
  if (declaredLength && Array.from(value).length > Number(declaredLength)) {
    return `内容超过 ${databaseType.toUpperCase()} 字符长度`;
  }
  const byteLength = new TextEncoder().encode(value).length;
  const textMaximum = { tinytext: 255, text: 65_535, mediumtext: 16_777_215 }[baseType];
  return textMaximum !== undefined && byteLength > textMaximum
    ? `内容超过 ${baseType.toUpperCase()} 容量`
    : null;
}

/** Accepts MySQL-compatible zero dates and fractional date/time text without timezone coercion. */
function isValidTemporal(value: string, baseType: string, databaseType: string): boolean {
  if (baseType === "date") {
    return isValidDateParts(value);
  }
  if (baseType === "time") {
    const match = value.match(/^-?(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/u);
    return Boolean(
      match &&
      Number(match[1]) <= 838 &&
      Number(match[2]) <= 59 &&
      Number(match[3]) <= 59 &&
      validFractionPrecision(match[4] ?? "", databaseType),
    );
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/u);
  return Boolean(
    match &&
    isValidDateParts(match[1] ?? "") &&
    Number(match[2]) <= 23 &&
    Number(match[3]) <= 59 &&
    Number(match[4]) <= 59 &&
    validFractionPrecision(match[5] ?? "", databaseType),
  );
}

/** Validates calendar components while retaining MySQL's explicit zero-date variants. */
function isValidDateParts(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month === 0 || day === 0) {
    return month <= 12 && day <= 31;
  }
  if (month > 12) {
    return false;
  }
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= daysInMonth;
}

/** Ensures fractional seconds do not exceed the declared MySQL FSP and get rounded silently. */
function validFractionPrecision(fraction: string, databaseType: string): boolean {
  const declared = databaseType.match(/\(\s*(\d)\s*\)/u)?.[1];
  const maximum = declared === undefined ? 0 : Number(declared);
  return fraction.length <= maximum;
}

/** Builds one readable SQL preview from the exact typed mutation shape. */
function mutationPreview(target: string, mutation: TableMutation): string {
  if (mutation.type === "update") {
    const assignments = mutation.values.map((field) => `${quoteIdentifier(field.name)} = ${mutationValueLiteral(field.value)}`);
    return `UPDATE ${target} SET ${assignments.join(", ")} WHERE ${mutationPredicate(mutation.key)};`;
  }
  if (mutation.type === "delete") {
    return `DELETE FROM ${target} WHERE ${mutationPredicate(mutation.key)};`;
  }
  if (mutation.values.length === 0) {
    return `INSERT INTO ${target} () VALUES ();`;
  }
  return `INSERT INTO ${target} (${mutation.values.map((field) => quoteIdentifier(field.name)).join(", ")}) VALUES (${mutation.values.map((field) => mutationValueLiteral(field.value)).join(", ")});`;
}

/** Builds a NULL-aware preview predicate from original typed primary-key values. */
function mutationPredicate(fields: readonly TableMutationField[]): string {
  return fields.map((field) => field.value.kind === "null"
    ? `${quoteIdentifier(field.name)} IS NULL`
    : `${quoteIdentifier(field.name)} = ${mutationValueLiteral(field.value)}`).join(" AND ");
}

/** Formats typed values for display only. */
function mutationValueLiteral(value: TableMutationValue): string {
  switch (value.kind) {
    case "null":
      return "NULL";
    case "boolean":
      return value.value ? "1" : "0";
    case "integer":
    case "float":
    case "decimal":
      return value.value;
    case "binary":
      return `FROM_BASE64(${mysqlStringLiteral(value.value)})`;
    case "text":
    case "json":
    case "date_time":
      return mysqlStringLiteral(value.value);
  }
}

/** Keeps recognized MySQL default expressions raw and quotes ordinary values. */
function defaultLiteral(value: string, databaseType: string): string {
  const trimmed = value.trim();
  if (
    /^(?:date|datetime|timestamp)\b/iu.test(databaseType.trim()) &&
    /^CURRENT_TIMESTAMP(?:\(\d*\))?$/iu.test(trimmed)
  ) {
    return trimmed.toUpperCase();
  }
  if (/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit)/iu.test(databaseType.trim()) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(trimmed)) {
    return trimmed;
  }
  return mysqlStringLiteral(value);
}

/** Returns whether a server default is the SQL-mode-independent current timestamp token. */
function isCurrentTimestampExpression(value: string | null): boolean {
  return value !== null && /^CURRENT_TIMESTAMP(?:\(\d*\))?$/iu.test(value.trim());
}

/** Reconstructs a read-only server expression, preserving the special timestamp shorthand. */
function expressionDefault(value: string): string {
  return isCurrentTimestampExpression(value) ? value.trim().toUpperCase() : `(${value})`;
}
