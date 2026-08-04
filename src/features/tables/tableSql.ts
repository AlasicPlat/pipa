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
 * Encodes UTF-8 text as a SQL-mode-independent MySQL expression.
 * @param value - Untrusted text that must remain data.
 * @returns A MySQL UTF-8 conversion expression containing hexadecimal bytes only.
 * Side effects: none.
 */
export function mysqlUtf8Expression(value: string): string {
  return `CONVERT(X'${bytesToHex(new TextEncoder().encode(value))}' USING utf8mb4)`;
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
    pieces.push(`COMMENT ${hexStringLiteral(column.comment)}`);
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

/** Formats typed values for display only, using hex expressions for every text family. */
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
      return `FROM_BASE64(${mysqlUtf8Expression(value.value)})`;
    case "text":
    case "json":
    case "date_time":
      return mysqlUtf8Expression(value.value);
  }
}

/** Keeps recognized MySQL default expressions raw and hex-encodes ordinary values. */
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
  return hexStringLiteral(value);
}

/** Returns whether a server default is the SQL-mode-independent current timestamp token. */
function isCurrentTimestampExpression(value: string | null): boolean {
  return value !== null && /^CURRENT_TIMESTAMP(?:\(\d*\))?$/iu.test(value.trim());
}

/** Reconstructs a read-only server expression, preserving the special timestamp shorthand. */
function expressionDefault(value: string): string {
  return isCurrentTimestampExpression(value) ? value.trim().toUpperCase() : `(${value})`;
}

/** Encodes UTF-8 as a MySQL hexadecimal string literal accepted by DDL literal positions. */
function hexStringLiteral(value: string): string {
  return `X'${bytesToHex(new TextEncoder().encode(value))}'`;
}

/** Converts bytes into uppercase hexadecimal without depending on locale or SQL mode. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("");
}
