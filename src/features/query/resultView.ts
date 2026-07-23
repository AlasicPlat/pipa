import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";
import { cellValueToPlainText } from "./resultExport";

export type SortDirection = "asc" | "desc";

export interface ResultSortState {
  columnIndex: number;
  direction: SortDirection;
}

export interface ResultViewRow {
  sourceIndex: number;
  cells: CellValue[];
}

/**
 * Compares two cells for grid sorting, preferring numeric order when both look numeric.
 * @param left - Left cell.
 * @param right - Right cell.
 * @returns Negative/zero/positive comparison result; NULLs sort last.
 * Side effects: none.
 */
export function compareCellValues(left: CellValue | undefined, right: CellValue | undefined): number {
  const leftNull = !left || left.kind === "null";
  const rightNull = !right || right.kind === "null";
  if (leftNull && rightNull) {
    return 0;
  }
  if (leftNull) {
    return 1;
  }
  if (rightNull) {
    return -1;
  }

  const leftText = cellValueToPlainText(left);
  const rightText = cellValueToPlainText(right);
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  if (
    leftText.trim() !== "" &&
    rightText.trim() !== "" &&
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber)
  ) {
    return leftNumber - rightNumber;
  }
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Returns whether any cell in a row contains the normalized search needle.
 * @param cells - One result row.
 * @param normalizedSearch - Lowercased trimmed search text; empty matches everything.
 * @returns True when the row should remain visible.
 * Side effects: none.
 */
export function rowMatchesSearch(cells: readonly CellValue[], normalizedSearch: string): boolean {
  if (!normalizedSearch) {
    return true;
  }
  return cells.some((cell) => cellValueToPlainText(cell).toLocaleLowerCase().includes(normalizedSearch));
}

/**
 * Returns whether one cell matches the active result search.
 * @param cell - Cell under test.
 * @param normalizedSearch - Lowercased trimmed search text.
 * @returns True when the cell should be highlighted.
 * Side effects: none.
 */
export function cellMatchesSearch(cell: CellValue | undefined, normalizedSearch: string): boolean {
  if (!normalizedSearch) {
    return false;
  }
  return cellValueToPlainText(cell).toLocaleLowerCase().includes(normalizedSearch);
}

/**
 * Builds the visible result rows after optional search filtering and column sorting.
 * @param rows - Loaded result rows in stream order.
 * @param options - Active search needle and optional sort state.
 * @returns View rows retaining original source indexes for stable copy/export mapping.
 * Side effects: none.
 */
export function buildResultView(
  rows: CellValue[][],
  options: {
    search: string;
    sort: ResultSortState | null;
  },
): ResultViewRow[] {
  const normalizedSearch = options.search.trim().toLocaleLowerCase();
  let viewRows: ResultViewRow[] = rows.map((cells, sourceIndex) => ({ sourceIndex, cells }));
  if (normalizedSearch) {
    viewRows = viewRows.filter((row) => rowMatchesSearch(row.cells, normalizedSearch));
  }
  if (options.sort) {
    const { columnIndex, direction } = options.sort;
    const directionFactor = direction === "asc" ? 1 : -1;
    viewRows = [...viewRows].sort(
      (left, right) =>
        directionFactor * compareCellValues(left.cells[columnIndex], right.cells[columnIndex]),
    );
  }
  return viewRows;
}

/**
 * Cycles a column through unsorted → ascending → descending → unsorted.
 * @param current - Active sort state, or null when unsorted.
 * @param columnIndex - Clicked column.
 * @returns The next sort state.
 * Side effects: none.
 */
export function cycleColumnSort(
  current: ResultSortState | null,
  columnIndex: number,
): ResultSortState | null {
  if (!current || current.columnIndex !== columnIndex) {
    return { columnIndex, direction: "asc" };
  }
  if (current.direction === "asc") {
    return { columnIndex, direction: "desc" };
  }
  return null;
}

/**
 * Counts cells that match the current search within the visible view.
 * @param viewRows - Filtered/sorted rows.
 * @param columns - Result schema (unused; kept for call-site clarity).
 * @param normalizedSearch - Lowercased trimmed search text.
 * @returns Number of matching cells.
 * Side effects: none.
 */
export function countSearchMatches(
  viewRows: readonly ResultViewRow[],
  columns: readonly QueryColumn[],
  normalizedSearch: string,
): number {
  if (!normalizedSearch) {
    return 0;
  }
  let count = 0;
  for (const row of viewRows) {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      if (cellMatchesSearch(row.cells[columnIndex], normalizedSearch)) {
        count += 1;
      }
    }
  }
  return count;
}
