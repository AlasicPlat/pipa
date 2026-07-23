import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";

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
      return JSON.stringify(cell.value);
    case "binary":
      return "[Binary]";
  }
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

/**
 * Triggers a browser/Tauri download for the provided CSV text.
 * @param csv - Serialized CSV document.
 * @param fileName - Suggested download file name.
 * @returns Nothing (`void`).
 * Side effects: creates a temporary object URL and clicks a download anchor.
 */
export function downloadCsv(csv: string, fileName: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
