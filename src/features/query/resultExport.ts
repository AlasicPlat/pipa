import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";
import { mysqlUtf8Expression, quoteIdentifier } from "../tables/tableSql";

/** Inclusive rectangular selection within a result grid. */
export interface ResultSelectionRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Converts a transport-safe cell into a plain clipboard/export string.
 * @param cell - Generated discriminated database value, or `undefined` for a missing column.
 * @returns Stable text for TSV/CSV; binary stays as a non-decoded placeholder.
 * Side effects: none.
 */
export function cellValueToPlainText(cell: CellValue | undefined): string {
  if (!cell || cell.kind === "null") {
    return "NULL";
  }

  switch (cell.kind) {
    case "boolean":
      return cell.value ? "true" : "false";
    case "integer":
    case "decimal":
    case "text":
    case "date_time":
      return cell.value;
    case "float":
      return String(cell.value);
    case "json":
      return cell.value;
    case "binary":
      return "[Binary]";
  }
}

/**
 * Converts a cell into a JSON-serializable value, keeping large integers as strings.
 * @param cell - Optional result cell.
 * @returns A JSON-safe value; binary stays as its transport string.
 * Side effects: none.
 */
export function cellValueToJsonValue(cell: CellValue | undefined): unknown {
  if (!cell || cell.kind === "null") {
    return null;
  }
  switch (cell.kind) {
    case "boolean":
    case "float":
    case "json":
      return cell.value;
    case "integer":
    case "decimal":
    case "text":
    case "date_time":
    case "binary":
      return cell.value;
  }
}

/**
 * Formats a cell for the full-value viewer (pretty JSON when applicable).
 * @param cell - Optional result cell.
 * @returns Human-readable full cell text.
 * Side effects: none.
 */
export function cellValueToViewerText(cell: CellValue | undefined): string {
  if (!cell || cell.kind === "null") {
    return "NULL";
  }
  if (cell.kind === "json") {
    return formatJsonText(cell.value);
  }
  if (cell.kind === "binary") {
    return cell.value;
  }
  return cellValueToPlainText(cell);
}

/** Pretty-prints JSON punctuation without parsing or rounding numeric tokens. */
function formatJsonText(value: string): string {
  let result = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      result += character;
    } else if (character === "{" || character === "[") {
      depth += 1;
      result += `${character}\n${"  ".repeat(depth)}`;
    } else if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
      result = `${result.trimEnd()}\n${"  ".repeat(depth)}${character}`;
    } else if (character === ",") {
      result += `,\n${"  ".repeat(depth)}`;
    } else if (character === ":") {
      result += ": ";
    } else if (!/\s/u.test(character)) {
      result += character;
    }
  }
  return result;
}

/**
 * Escapes one CSV field using RFC 4180 quoting rules.
 * @param value - Raw field text.
 * @returns A CSV-safe field that may be wrapped in double quotes.
 * Side effects: none.
 */
function escapeCsvField(value: string): string {
  if (!/[",\n\r]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/gu, "\"\"")}"`;
}

/**
 * Escapes a Markdown table cell, collapsing newlines.
 * @param value - Raw cell text.
 * @returns Pipe-safe Markdown cell text.
 * Side effects: none.
 */
function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

/**
 * Formats a MySQL temporal transport value as a readable, SQL-mode-independent literal.
 * @param value - DATE, TIME, DATETIME, or TIMESTAMP text returned by the MySQL adapter.
 * @returns A quoted temporal value; unexpected text keeps the hex-encoded safe fallback.
 * Side effects: none.
 */
function mysqlTemporalLiteral(value: string): string {
  const normalizedValue = value.replace(
    /^(\d{4}-\d{2}-\d{2})T(?=\d{2}:\d{2}:\d{2})/u,
    "$1 ",
  );
  const validTemporalValue = /^(?:\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)?|-?\d{1,3}:\d{2}:\d{2}(?:\.\d{1,6})?)$/u;
  return validTemporalValue.test(normalizedValue)
    ? `'${normalizedValue}'`
    : mysqlUtf8Expression(value);
}

/**
 * Formats a transport cell as a MySQL literal for INSERT / IN lists.
 * @param cell - Optional result cell.
 * @param databaseType - Native column type from the result schema.
 * @returns A safe SQL literal.
 * Side effects: none.
 */
export function cellValueToSqlLiteral(cell: CellValue | undefined, databaseType: string): string {
  if (!cell || cell.kind === "null") {
    return "NULL";
  }

  switch (cell.kind) {
    case "boolean":
      return cell.value ? "1" : "0";
    case "integer":
    case "decimal":
      return cell.value;
    case "float": {
      const normalizedType = databaseType.toLowerCase();
      if (/^(float|double|real|decimal|numeric)/u.test(normalizedType)) {
        return String(cell.value);
      }
      return mysqlUtf8Expression(String(cell.value));
    }
    case "json":
      return mysqlUtf8Expression(cell.value);
    case "binary":
      // Result transport stores binary as base64; emit a MySQL-native constructor.
      return `FROM_BASE64(${mysqlUtf8Expression(cell.value)})`;
    case "date_time":
      return mysqlTemporalLiteral(cell.value);
    case "text": {
      const normalizedType = databaseType.toLowerCase();
      if (
        /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit)/u.test(
          normalizedType,
        ) &&
        /^-?(?:\d+|\d*\.\d+)$/u.test(cell.value.trim())
      ) {
        return cell.value.trim();
      }
      return mysqlUtf8Expression(cell.value);
    }
  }
}

/**
 * Normalizes a selection rectangle so start <= end on both axes.
 * @param selection - Possibly unordered selection anchors.
 * @returns Inclusive bounds with sorted corners.
 * Side effects: none.
 */
export function normalizeSelection(selection: ResultSelectionRect): ResultSelectionRect {
  return {
    startRow: Math.min(selection.startRow, selection.endRow),
    startCol: Math.min(selection.startCol, selection.endCol),
    endRow: Math.max(selection.startRow, selection.endRow),
    endCol: Math.max(selection.startCol, selection.endCol),
  };
}

/**
 * Returns a short Chinese label describing the active selection.
 * @param selection - Normalized selection, or null when empty.
 * @param allSelected - Whether the entire loaded result set is selected.
 * @param columnCount - Total columns in the grid.
 * @param discreteRowCount - Count of non-contiguous full rows selected via Mod+click.
 * @returns Status text such as `已选 3 个单元格`, or null when nothing is selected.
 * Side effects: none.
 */
export function describeSelection(
  selection: ResultSelectionRect | null,
  allSelected: boolean,
  columnCount: number,
  discreteRowCount = 0,
): string | null {
  if (discreteRowCount > 0) {
    return discreteRowCount === 1 ? "已选 1 行" : `已选 ${discreteRowCount} 行`;
  }
  if (!selection) {
    return null;
  }
  const bounds = normalizeSelection(selection);
  const rowCount = bounds.endRow - bounds.startRow + 1;
  const selectedColumns = bounds.endCol - bounds.startCol + 1;
  const cellCount = rowCount * selectedColumns;
  if (allSelected) {
    return `已选全部 ${rowCount} 行`;
  }
  if (selectedColumns === columnCount && columnCount > 0) {
    return rowCount === 1 ? "已选 1 行" : `已选 ${rowCount} 行`;
  }
  if (rowCount > 1 && selectedColumns === 1) {
    return `已选 ${rowCount} 个单元格（1 列）`;
  }
  if (cellCount === 1) {
    return "已选 1 个单元格";
  }
  return `已选 ${cellCount} 个单元格`;
}

/**
 * Returns column indexes treated as primary-key `id` columns for INSERT copy.
 * Query result metadata has no PK flag, so only exact `id` names are recognized.
 * @param columns - Result schema.
 * @returns Zero-based indexes of columns named `id` (case-insensitive).
 * Side effects: none.
 */
export function primaryKeyColumnIndexes(columns: readonly QueryColumn[]): number[] {
  return columns.flatMap((column, index) => (column.name.toLowerCase() === "id" ? [index] : []));
}

/**
 * Formats a possibly qualified table name as a backtick-quoted MySQL target.
 * @param tableName - Bare table, `db.table`, or already-quoted fragments.
 * @returns Identifier suitable for `INSERT INTO …`.
 * Side effects: none.
 */
export function formatInsertTableTarget(tableName: string): string {
  const parts = tableName
    .split(".")
    .map((part) => part.trim().replace(/^`+|`+$/gu, ""))
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return quoteIdentifier("your_table");
  }
  return parts.map((part) => quoteIdentifier(part)).join(".");
}

/**
 * Best-effort extraction of the first FROM target in a SQL script.
 * @param sql - Editor SQL that produced the result set.
 * @returns `db.table` / `table`, or `your_table` when parsing fails.
 * Side effects: none.
 */
export function inferTableNameFromSql(sql: string): string {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/--[^\n]*/gu, " ")
    .replace(/#[^\n]*/gu, " ");
  const match =
    /\bfrom\s+(`[^`]+`|[A-Za-z_][\w$]*)(?:\s*\.\s*(`[^`]+`|[A-Za-z_][\w$]*))?/iu.exec(stripped);
  if (!match) {
    return "your_table";
  }
  const left = match[1]?.replace(/`/gu, "") ?? "your_table";
  const right = match[2]?.replace(/`/gu, "");
  return right ? `${left}.${right}` : left;
}

/**
 * Resolves an INSERT target, qualifying a bare table with the connection database when possible.
 * @param sql - Editor SQL that produced the result set.
 * @param database - Active connection database, if any.
 * @returns `db.table` / `table`, or `your_table` when parsing fails.
 * Side effects: none.
 */
export function resolveExportTableName(sql: string, database?: string | null): string {
  const inferred = inferTableNameFromSql(sql);
  if (inferred === "your_table" || inferred.includes(".")) {
    return inferred;
  }
  const schema = database?.trim();
  return schema ? `${schema}.${inferred}` : inferred;
}

export interface SerializeSelectionAsTsvOptions {
  /** When true, prepend selected column names (SQL aliases when present). */
  includeHeaders?: boolean;
}

/**
 * Serializes a rectangular cell selection as TSV.
 * @param columns - Result schema; `name` is the alias when the query used `AS`.
 * @param rows - Loaded result rows.
 * @param selection - Inclusive cell rectangle to copy.
 * @param options - Whether to include a header row of field names/aliases.
 * @returns Clipboard text for the selected cells, optionally with headers.
 * Side effects: none.
 */
export function serializeSelectionAsTsv(
  columns: QueryColumn[],
  rows: CellValue[][],
  selection: ResultSelectionRect,
  options: SerializeSelectionAsTsvOptions = {},
): string {
  const bounds = normalizeSelection(selection);
  const lines: string[] = [];
  if (options.includeHeaders) {
    const headers: string[] = [];
    for (let columnIndex = bounds.startCol; columnIndex <= bounds.endCol; columnIndex += 1) {
      headers.push((columns[columnIndex]?.name ?? "").replace(/\t/gu, " "));
    }
    lines.push(headers.join("\t"));
  }
  for (let rowIndex = bounds.startRow; rowIndex <= bounds.endRow; rowIndex += 1) {
    const cells: string[] = [];
    for (let columnIndex = bounds.startCol; columnIndex <= bounds.endCol; columnIndex += 1) {
      cells.push(cellValueToPlainText(rows[rowIndex]?.[columnIndex]).replace(/\t/gu, " "));
    }
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

/**
 * Serializes a rectangular selection as CSV, optionally with field-name headers.
 * @param columns - Result schema.
 * @param rows - Loaded result rows.
 * @param selection - Inclusive cell rectangle to copy.
 * @param options - Whether to include a header row.
 * @returns Clipboard-friendly CSV for the selection.
 * Side effects: none.
 */
export function serializeSelectionAsCsv(
  columns: QueryColumn[],
  rows: CellValue[][],
  selection: ResultSelectionRect,
  options: SerializeSelectionAsTsvOptions = {},
): string {
  const bounds = normalizeSelection(selection);
  const lines: string[] = [];
  if (options.includeHeaders) {
    const headers: string[] = [];
    for (let columnIndex = bounds.startCol; columnIndex <= bounds.endCol; columnIndex += 1) {
      headers.push(escapeCsvField(columns[columnIndex]?.name ?? ""));
    }
    lines.push(headers.join(","));
  }
  for (let rowIndex = bounds.startRow; rowIndex <= bounds.endRow; rowIndex += 1) {
    const cells: string[] = [];
    for (let columnIndex = bounds.startCol; columnIndex <= bounds.endCol; columnIndex += 1) {
      cells.push(escapeCsvField(cellValueToPlainText(rows[rowIndex]?.[columnIndex])));
    }
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

/**
 * Serializes a selection as JSON objects keyed by field name / alias.
 * @param columns - Result schema.
 * @param rows - Loaded result rows.
 * @param selection - Inclusive cell rectangle to copy.
 * @returns Pretty-printed JSON: one value, one object, or an array of objects.
 * Side effects: none.
 */
export function serializeSelectionAsJson(
  columns: QueryColumn[],
  rows: CellValue[][],
  selection: ResultSelectionRect,
): string {
  const bounds = normalizeSelection(selection);
  const columnIndexes: number[] = [];
  for (let columnIndex = bounds.startCol; columnIndex <= bounds.endCol; columnIndex += 1) {
    columnIndexes.push(columnIndex);
  }

  if (bounds.startRow === bounds.endRow && columnIndexes.length === 1) {
    const columnIndex = columnIndexes[0] ?? 0;
    return cellValueToJsonLiteral(rows[bounds.startRow]?.[columnIndex]);
  }

  const objects: string[] = [];
  for (let rowIndex = bounds.startRow; rowIndex <= bounds.endRow; rowIndex += 1) {
    const fields = columnIndexes.map((columnIndex) => {
      const name = columns[columnIndex]?.name ?? `column_${columnIndex}`;
      return `  ${JSON.stringify(name)}: ${cellValueToJsonLiteral(rows[rowIndex]?.[columnIndex])}`;
    });
    objects.push(`{\n${fields.join(",\n")}\n}`);
  }
  if (objects.length === 1) {
    return objects[0] ?? "{}";
  }
  return `[\n${objects.map((object) => object.split("\n").map((line) => `  ${line}`).join("\n")).join(",\n")}\n]`;
}

/** Converts one cell to a JSON literal while inserting validated raw JSON without reparsing it. */
function cellValueToJsonLiteral(cell: CellValue | undefined): string {
  if (cell?.kind === "json") {
    return cell.value;
  }
  return JSON.stringify(cellValueToJsonValue(cell)) ?? "null";
}

/**
 * Serializes a selection as a Markdown table (always includes header aliases).
 * @param columns - Result schema.
 * @param rows - Loaded result rows.
 * @param selection - Inclusive cell rectangle to copy.
 * @returns A GitHub-flavored Markdown table.
 * Side effects: none.
 */
export function serializeSelectionAsMarkdown(
  columns: QueryColumn[],
  rows: CellValue[][],
  selection: ResultSelectionRect,
): string {
  const bounds = normalizeSelection(selection);
  const headers: string[] = [];
  for (let columnIndex = bounds.startCol; columnIndex <= bounds.endCol; columnIndex += 1) {
    headers.push(escapeMarkdownCell(columns[columnIndex]?.name ?? ""));
  }
  const separator = headers.map(() => "---");
  const body: string[] = [];
  for (let rowIndex = bounds.startRow; rowIndex <= bounds.endRow; rowIndex += 1) {
    const cells: string[] = [];
    for (let columnIndex = bounds.startCol; columnIndex <= bounds.endCol; columnIndex += 1) {
      cells.push(escapeMarkdownCell(cellValueToPlainText(rows[rowIndex]?.[columnIndex])));
    }
    body.push(`| ${cells.join(" | ")} |`);
  }
  return [`| ${headers.join(" | ")} |`, `| ${separator.join(" | ")} |`, ...body].join("\n");
}

/**
 * Builds a deduplicated SQL `IN (...)` list from the selected cells.
 * @param columns - Result schema (for literal typing).
 * @param rows - Loaded result rows.
 * @param selection - Inclusive cell rectangle to copy.
 * @returns An `IN (...)` fragment ready to paste into a WHERE clause.
 * Side effects: none.
 */
export function serializeSelectionAsInList(
  columns: QueryColumn[],
  rows: CellValue[][],
  selection: ResultSelectionRect,
): string {
  const bounds = normalizeSelection(selection);
  const literals: string[] = [];
  const seen = new Set<string>();
  for (let rowIndex = bounds.startRow; rowIndex <= bounds.endRow; rowIndex += 1) {
    for (let columnIndex = bounds.startCol; columnIndex <= bounds.endCol; columnIndex += 1) {
      const literal = cellValueToSqlLiteral(
        rows[rowIndex]?.[columnIndex],
        columns[columnIndex]?.databaseType ?? "",
      );
      if (seen.has(literal)) {
        continue;
      }
      seen.add(literal);
      literals.push(literal);
    }
  }
  return `IN (${literals.join(", ")})`;
}

/**
 * Copies selected column names / aliases as a tab-separated header line.
 * @param columns - Result schema.
 * @param selection - Inclusive selection (column span is used).
 * @returns Field names for the selected columns.
 * Side effects: none.
 */
export function serializeSelectionColumnNames(
  columns: QueryColumn[],
  selection: ResultSelectionRect,
): string {
  const bounds = normalizeSelection(selection);
  const names: string[] = [];
  for (let columnIndex = bounds.startCol; columnIndex <= bounds.endCol; columnIndex += 1) {
    names.push(columns[columnIndex]?.name ?? "");
  }
  return names.join("\t");
}

/**
 * Serializes query results as tab-separated text with a header row.
 * @param columns - Result schema.
 * @param rows - Loaded result rows.
 * @returns Clipboard-friendly TSV including column names.
 * Side effects: none.
 */
export function serializeResultAsTsv(columns: QueryColumn[], rows: CellValue[][]): string {
  const header = columns.map((column) => column.name).join("\t");
  const body = rows.map((row) => (
    columns.map((_, columnIndex) => cellValueToPlainText(row[columnIndex]).replace(/\t/gu, " ")).join("\t")
  ));
  return [header, ...body].join("\n");
}

/**
 * Serializes query results as CSV text with a header row.
 * @param columns - Result schema.
 * @param rows - Loaded result rows.
 * @returns Download-friendly CSV including column names.
 * Side effects: none.
 */
export function serializeResultAsCsv(columns: QueryColumn[], rows: CellValue[][]): string {
  const header = columns.map((column) => escapeCsvField(column.name)).join(",");
  const body = rows.map((row) => (
    columns.map((_, columnIndex) => escapeCsvField(cellValueToPlainText(row[columnIndex]))).join(",")
  ));
  return [header, ...body].join("\n");
}

export interface SerializeRowsAsInsertOptions {
  tableName: string;
  includePrimaryKey: boolean;
  rowIndexes?: readonly number[];
}

/**
 * Builds a standard multi-row INSERT statement for the selected result rows.
 * @param columns - Result schema.
 * @param rows - Loaded result rows.
 * @param options - Target table, whether to keep `id` columns, and optional row indexes.
 * @returns One `INSERT INTO … VALUES (…), (…);` statement, or empty when no columns remain.
 * Side effects: none.
 */
export function serializeRowsAsInsert(
  columns: QueryColumn[],
  rows: CellValue[][],
  options: SerializeRowsAsInsertOptions,
): string {
  const pkIndexes = new Set(primaryKeyColumnIndexes(columns));
  const columnIndexes = columns
    .map((_, index) => index)
    .filter((index) => options.includePrimaryKey || !pkIndexes.has(index));
  if (columnIndexes.length === 0) {
    return "";
  }

  const target = formatInsertTableTarget(options.tableName);
  const columnList = columnIndexes.map((index) => quoteIdentifier(columns[index]?.name ?? "")).join(", ");
  const indexes = options.rowIndexes ?? rows.map((_, index) => index);
  if (indexes.length === 0) {
    return "";
  }

  const valueTuples = indexes.map((rowIndex) => {
    const values = columnIndexes
      .map((columnIndex) =>
        cellValueToSqlLiteral(rows[rowIndex]?.[columnIndex], columns[columnIndex]?.databaseType ?? ""),
      )
      .join(", ");
    return `(${values})`;
  });

  if (valueTuples.length === 1) {
    return `INSERT INTO ${target} (${columnList}) VALUES ${valueTuples[0]};`;
  }
  return `INSERT INTO ${target} (${columnList}) VALUES\n${valueTuples.join(",\n")};`;
}

export type DownloadTextFileResult = "saved" | "cancelled" | "failed";

/**
 * Triggers a browser/Tauri download for the provided CSV text.
 * @param csv - Serialized CSV document.
 * @param fileName - Suggested download file name.
 * @returns Whether the file was saved, cancelled, or failed.
 * Side effects: opens a native save dialog in Tauri, or clicks a download anchor in browsers.
 */
export async function downloadCsv(csv: string, fileName: string): Promise<DownloadTextFileResult> {
  return downloadTextFile(csv, fileName, "text/csv;charset=utf-8");
}

/**
 * Saves text content through the native save dialog (Tauri) or an anchor download (browser).
 * @param content - File body.
 * @param fileName - Suggested download file name.
 * @param mimeType - MIME type for the Blob fallback path.
 * @returns Whether the file was saved, cancelled, or failed.
 * Side effects: may open a save dialog and write through the desktop backend.
 */
export async function downloadTextFile(
  content: string,
  fileName: string,
  mimeType: string,
): Promise<DownloadTextFileResult> {
  let usedNativeSave = false;
  try {
    const { invoke, isTauri } = await import("@tauri-apps/api/core");
    if (isTauri()) {
      usedNativeSave = true;
      const { save } = await import("@tauri-apps/plugin-dialog");
      const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
      const path = await save({
        defaultPath: fileName,
        filters: extension
          ? [{ name: extension.toUpperCase(), extensions: [extension] }]
          : undefined,
      });
      if (!path) {
        return "cancelled";
      }
      await invoke<void>("write_text_file", { path, contents: content });
      return "saved";
    }
  } catch {
    if (usedNativeSave) {
      return "failed";
    }
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return "saved";
}
