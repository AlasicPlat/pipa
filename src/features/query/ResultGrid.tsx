import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";
import { isNativeTextSelectTarget } from "../commands/scopedSelectAll";
import { matchesShortcut, useShortcutSettings } from "../commands/shortcutRegistry";
import {
  cellValueToViewerText,
  describeSelection,
  normalizeSelection,
  primaryKeyColumnIndexes,
  serializeRowsAsInsert,
  serializeSelectionAsCsv,
  serializeSelectionAsInList,
  serializeSelectionAsJson,
  serializeSelectionAsMarkdown,
  serializeSelectionAsTsv,
  serializeSelectionColumnNames,
  type ResultSelectionRect,
} from "./resultExport";
import {
  buildResultView,
  cellMatchesSearch,
  countSearchMatches,
  cycleColumnSort,
  type ResultSortState,
} from "./resultView";

const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 80;

interface ResultGridProps {
  columns: QueryColumn[];
  rows: CellValue[][];
  running: boolean;
  incomplete: boolean;
  /** Case-insensitive result search; matching rows stay visible and cells highlight. */
  searchQuery?: string;
  /** Inferred or placeholder table name used when copying rows as INSERT. */
  tableName?: string;
  onCopyAll?: () => void;
  onCopyText?: (text: string, feedback: string) => void;
  /** Reports a short selection status for the results header. */
  onSelectionChange?: (label: string | null) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
}

interface CellViewerState {
  rowIndex: number;
  columnIndex: number;
}

/**
 * Converts a transport-safe cell value into compact display content.
 * @param cell - Generated discriminated database value.
 * @returns Visible cell content; exact integers and decimals remain strings.
 * Side effects: none.
 */
function renderCellValue(cell: CellValue | undefined): ReactNode {
  if (!cell || cell.kind === "null") {
    return <span className="result-cell--null">NULL</span>;
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
      return <span className="result-cell--binary">Binary</span>;
  }
}

/**
 * Returns whether a cell sits inside the active selection rectangle.
 * @param selection - Normalized inclusive selection, or null when empty.
 * @param rowIndex - View-row under test.
 * @param columnIndex - Column under test.
 * @returns True when the cell is selected.
 * Side effects: none.
 */
function isCellInSelection(
  selection: ResultSelectionRect | null,
  rowIndex: number,
  columnIndex: number,
): boolean {
  if (!selection) {
    return false;
  }
  return (
    rowIndex >= selection.startRow &&
    rowIndex <= selection.endRow &&
    columnIndex >= selection.startCol &&
    columnIndex <= selection.endCol
  );
}

/**
 * Returns distinct view-row indexes covered by a selection rectangle.
 * @param selection - Inclusive selection bounds.
 * @returns Sorted unique view-row indexes.
 * Side effects: none.
 */
function rowIndexesFromSelection(selection: ResultSelectionRect): number[] {
  const bounds = normalizeSelection(selection);
  const indexes: number[] = [];
  for (let rowIndex = bounds.startRow; rowIndex <= bounds.endRow; rowIndex += 1) {
    indexes.push(rowIndex);
  }
  return indexes;
}

/**
 * Keeps a context menu inside the viewport.
 * @param x - Pointer client X.
 * @param y - Pointer client Y.
 * @returns Clamped fixed coordinates.
 * Side effects: none.
 */
function clampMenuPosition(x: number, y: number): ContextMenuState {
  const menuWidth = 248;
  const menuHeight = 420;
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
  };
}

/**
 * Renders ordered result rows through row virtualization for stable large-result scrolling.
 * @param props - Schema, rows, search, and copy hooks.
 * @returns An accessible virtual result grid with sort, resize, search, and copy formats.
 * Side effects: measures and observes the result viewport through TanStack Virtual.
 */
export function ResultGrid({
  columns,
  rows,
  running,
  incomplete,
  searchQuery = "",
  tableName = "your_table",
  onCopyAll,
  onCopyText,
  onSelectionChange,
}: ResultGridProps) {
  const shortcuts = useShortcutSettings();
  const gridRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const menuItemRef = useRef<HTMLButtonElement>(null);
  const resizeSessionRef = useRef<{ columnIndex: number; startX: number; startWidth: number } | null>(
    null,
  );
  const [allSelected, setAllSelected] = useState(false);
  const [selection, setSelection] = useState<ResultSelectionRect | null>(null);
  const [anchor, setAnchor] = useState<{ row: number; col: number } | null>(null);
  const [focusCell, setFocusCell] = useState<{ row: number; col: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [cellViewer, setCellViewer] = useState<CellViewerState | null>(null);
  const [sort, setSort] = useState<ResultSortState | null>(null);
  const [columnWidths, setColumnWidths] = useState<number[]>(() =>
    columns.map(() => DEFAULT_COLUMN_WIDTH),
  );

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const viewRows = useMemo(
    () => buildResultView(rows, { search: searchQuery, sort }),
    [rows, searchQuery, sort],
  );
  const displayRows = useMemo(() => viewRows.map((row) => row.cells), [viewRows]);
  const searchMatchCount = useMemo(
    () => countSearchMatches(viewRows, columns, normalizedSearch),
    [viewRows, columns, normalizedSearch],
  );

  const virtualizer = useVirtualizer({
    count: viewRows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 34,
    overscan: 10,
  });

  const widths = columns.map((_, index) => columnWidths[index] ?? DEFAULT_COLUMN_WIDTH);
  const gridTemplateColumns = widths.map((width) => `${width}px`).join(" ");
  const gridMinWidth = Math.max(
    widths.reduce((sum, width) => sum + width, 0),
    560,
  );
  const normalizedSelection = selection ? normalizeSelection(selection) : null;
  const hasIdColumn = primaryKeyColumnIndexes(columns).length > 0;
  const lastColumnIndex = Math.max(columns.length - 1, 0);
  const lastRowIndex = Math.max(viewRows.length - 1, 0);
  const activeSelection =
    normalizedSelection ??
    (allSelected && viewRows.length > 0
      ? {
          startRow: 0,
          startCol: 0,
          endRow: lastRowIndex,
          endCol: lastColumnIndex,
        }
      : null);

  useEffect(() => {
    setColumnWidths(columns.map(() => DEFAULT_COLUMN_WIDTH));
    setSort(null);
    setAllSelected(false);
    setSelection(null);
    setAnchor(null);
    setFocusCell(null);
    setContextMenu(null);
    setCellViewer(null);
  }, [columns]);

  useEffect(() => {
    setAllSelected(false);
    setSelection(null);
    setAnchor(null);
    setFocusCell(null);
    setContextMenu(null);
  }, [searchQuery, sort]);

  useEffect(() => {
    if (rows.length > 0) {
      return;
    }
    setAllSelected(false);
    setSelection(null);
    setAnchor(null);
    setFocusCell(null);
    setContextMenu(null);
    setCellViewer(null);
  }, [rows.length]);

  /**
   * Selects every currently visible result cell (search/sort aware).
   * @returns Nothing (`void`).
   * Side effects: updates selection state and focuses the result grid.
   */
  function selectAllVisibleRows(): void {
    if (viewRows.length === 0) {
      return;
    }
    setAllSelected(true);
    setSelection({
      startRow: 0,
      startCol: 0,
      endRow: lastRowIndex,
      endCol: lastColumnIndex,
    });
    setAnchor({ row: 0, col: 0 });
    setFocusCell({ row: 0, col: 0 });
    gridRef.current?.focus();
  }

  useEffect(() => {
    /** Selects all result rows when Mod+A lands anywhere inside the results pane. */
    function handleDocumentSelectAll(event: globalThis.KeyboardEvent): void {
      if (viewRows.length === 0 || cellViewer) {
        return;
      }
      if (!matchesShortcut(event, shortcuts.bindings.selectRows)) {
        return;
      }
      const focusTarget = event.target instanceof Element ? event.target : document.activeElement;
      if (isNativeTextSelectTarget(focusTarget)) {
        return;
      }
      const grid = gridRef.current;
      if (!grid) {
        return;
      }
      const resultsRegion = grid.closest(".query-results");
      const inResultsRegion =
        focusTarget instanceof Element &&
        (grid.contains(focusTarget) || Boolean(resultsRegion?.contains(focusTarget)));
      if (!inResultsRegion) {
        return;
      }
      event.preventDefault();
      selectAllVisibleRows();
    }

    document.addEventListener("keydown", handleDocumentSelectAll, true);
    return () => document.removeEventListener("keydown", handleDocumentSelectAll, true);
  }, [
    cellViewer,
    lastColumnIndex,
    lastRowIndex,
    shortcuts.bindings.selectRows,
    viewRows.length,
  ]);

  useEffect(() => {
    onSelectionChange?.(describeSelection(normalizedSelection, allSelected, columns.length));
  }, [allSelected, columns.length, normalizedSelection, onSelectionChange]);

  useEffect(() => () => onSelectionChange?.(null), [onSelectionChange]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    menuItemRef.current?.focus();

    /** Closes the context menu when the pointer lands outside it. */
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".result-grid-context-menu")) {
        setContextMenu(null);
      }
    }

    /** Closes the context menu on Escape without clearing the grid selection. */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    /** Updates the dragged column width while the pointer moves. */
    function handlePointerMove(event: PointerEvent): void {
      const session = resizeSessionRef.current;
      if (!session) {
        return;
      }
      const nextWidth = Math.max(MIN_COLUMN_WIDTH, session.startWidth + (event.clientX - session.startX));
      setColumnWidths((current) => {
        const widthsForColumns = columns.map((_, index) => current[index] ?? DEFAULT_COLUMN_WIDTH);
        widthsForColumns[session.columnIndex] = nextWidth;
        return widthsForColumns;
      });
    }

    /** Ends an active column-resize gesture. */
    function handlePointerUp(): void {
      resizeSessionRef.current = null;
    }

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };
  }, [columns]);

  /**
   * Scrolls a focused view-row into the virtualized viewport.
   * @param rowIndex - Target view-row.
   * @returns Nothing (`void`).
   * Side effects: asks TanStack Virtual to scroll the row into view.
   */
  function ensureRowVisible(rowIndex: number): void {
    virtualizer.scrollToIndex(rowIndex, { align: "auto" });
  }

  /**
   * Applies a new rectangular selection and optional focus/anchor cells.
   * @param next - Inclusive selection rectangle in view-row space.
   * @param nextAnchor - Selection anchor; defaults to the selection start.
   * @param nextFocus - Keyboard focus cell; defaults to the selection end.
   * @returns Nothing (`void`).
   * Side effects: updates selection state.
   */
  function applySelection(
    next: ResultSelectionRect,
    nextAnchor?: { row: number; col: number },
    nextFocus?: { row: number; col: number },
  ): void {
    setAllSelected(false);
    setSelection(next);
    setAnchor(nextAnchor ?? { row: next.startRow, col: next.startCol });
    setFocusCell(nextFocus ?? { row: next.endRow, col: next.endCol });
  }

  /**
   * Copies the current selection as TSV, optionally with field names/aliases.
   * @param includeHeaders - When true, prepend selected column names (`AS` aliases).
   * @returns Nothing (`void`).
   * Side effects: may invoke parent clipboard handlers and closes the context menu.
   */
  function copyCurrentSelection(includeHeaders = false): void {
    setContextMenu(null);
    if (allSelected && includeHeaders && !normalizedSearch && !sort) {
      onCopyAll?.();
      return;
    }
    if (!activeSelection || !onCopyText) {
      return;
    }
    const text = serializeSelectionAsTsv(columns, displayRows, activeSelection, { includeHeaders });
    const cellCount =
      (activeSelection.endRow - activeSelection.startRow + 1) *
      (activeSelection.endCol - activeSelection.startCol + 1);
    const suffix = includeHeaders ? "（含字段名）" : "";
    onCopyText(
      text,
      cellCount === 1 && !includeHeaders ? "已复制选中内容" : `已复制 ${cellCount} 个单元格${suffix}`,
    );
  }

  /**
   * Copies the selection using a named serializer and feedback label.
   * @param format - Clipboard format key.
   * @returns Nothing (`void`).
   * Side effects: writes clipboard text through the parent handler.
   */
  function copySelectionAs(format: "csv" | "json" | "markdown" | "in" | "names"): void {
    setContextMenu(null);
    if (!activeSelection || !onCopyText) {
      return;
    }
    switch (format) {
      case "csv":
        onCopyText(
          serializeSelectionAsCsv(columns, displayRows, activeSelection, { includeHeaders: true }),
          "已复制为 CSV",
        );
        return;
      case "json":
        onCopyText(serializeSelectionAsJson(columns, displayRows, activeSelection), "已复制为 JSON");
        return;
      case "markdown":
        onCopyText(
          serializeSelectionAsMarkdown(columns, displayRows, activeSelection),
          "已复制为 Markdown",
        );
        return;
      case "in":
        onCopyText(serializeSelectionAsInList(columns, displayRows, activeSelection), "已复制为 IN (...)");
        return;
      case "names":
        onCopyText(serializeSelectionColumnNames(columns, activeSelection), "已复制字段名");
    }
  }

  /**
   * Copies rows covered by the current selection as INSERT statements.
   * @param includePrimaryKey - Whether columns named `id` are included.
   * @returns Nothing (`void`).
   * Side effects: may invoke the parent clipboard handler and closes the menu.
   */
  function copySelectionAsInsert(includePrimaryKey: boolean): void {
    setContextMenu(null);
    if (!onCopyText || columns.length === 0 || displayRows.length === 0 || !activeSelection) {
      return;
    }
    const rowIndexes = rowIndexesFromSelection(activeSelection);
    const sql = serializeRowsAsInsert(columns, displayRows, {
      tableName,
      includePrimaryKey,
      rowIndexes,
    });
    if (!sql) {
      onCopyText("", "没有可复制的列");
      return;
    }
    const suffix = includePrimaryKey ? "" : "（不含 id）";
    onCopyText(sql, `已复制 ${rowIndexes.length} 行 INSERT${suffix}`);
  }

  /** Expands the current focus cell into a full row selection. */
  function selectCurrentRow(): void {
    setContextMenu(null);
    const rowIndex = focusCell?.row ?? activeSelection?.startRow ?? 0;
    applySelection(
      { startRow: rowIndex, startCol: 0, endRow: rowIndex, endCol: lastColumnIndex },
      { row: rowIndex, col: 0 },
      { row: rowIndex, col: lastColumnIndex },
    );
  }

  /** Expands the current focus cell into a full column selection of visible rows. */
  function selectCurrentColumn(): void {
    setContextMenu(null);
    if (viewRows.length === 0) {
      return;
    }
    const columnIndex = focusCell?.col ?? activeSelection?.startCol ?? 0;
    applySelection(
      { startRow: 0, startCol: columnIndex, endRow: lastRowIndex, endCol: columnIndex },
      { row: 0, col: columnIndex },
      { row: lastRowIndex, col: columnIndex },
    );
  }

  /** Opens the read-only cell viewer for the focus/context cell. */
  function openCellViewer(): void {
    setContextMenu(null);
    const rowIndex = focusCell?.row ?? activeSelection?.startRow;
    const columnIndex = focusCell?.col ?? activeSelection?.startCol;
    if (rowIndex === undefined || columnIndex === undefined) {
      return;
    }
    setCellViewer({ rowIndex, columnIndex });
  }

  /**
   * Selects one cell, a rectangular range (Shift), or a whole row (Mod/Ctrl).
   * @param event - Mouse event from a result cell.
   * @param rowIndex - Clicked view-row.
   * @param columnIndex - Clicked column.
   * @returns Nothing (`void`).
   * Side effects: updates selection state.
   */
  function handleCellMouseDown(
    event: ReactMouseEvent<HTMLSpanElement>,
    rowIndex: number,
    columnIndex: number,
  ): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    gridRef.current?.focus();
    setContextMenu(null);

    if (event.metaKey || event.ctrlKey) {
      applySelection(
        { startRow: rowIndex, startCol: 0, endRow: rowIndex, endCol: lastColumnIndex },
        { row: rowIndex, col: 0 },
        { row: rowIndex, col: columnIndex },
      );
      return;
    }

    if (event.shiftKey && anchor) {
      applySelection(
        {
          startRow: anchor.row,
          startCol: anchor.col,
          endRow: rowIndex,
          endCol: columnIndex,
        },
        anchor,
        { row: rowIndex, col: columnIndex },
      );
      return;
    }

    applySelection(
      {
        startRow: rowIndex,
        startCol: columnIndex,
        endRow: rowIndex,
        endCol: columnIndex,
      },
      { row: rowIndex, col: columnIndex },
      { row: rowIndex, col: columnIndex },
    );
  }

  /** Copies the focused cell immediately — preferred over opening a detail dialog. */
  function handleCellDoubleClick(rowIndex: number, columnIndex: number): void {
    applySelection(
      {
        startRow: rowIndex,
        startCol: columnIndex,
        endRow: rowIndex,
        endCol: columnIndex,
      },
      { row: rowIndex, col: columnIndex },
      { row: rowIndex, col: columnIndex },
    );
    if (!onCopyText) {
      return;
    }
    const text = serializeSelectionAsTsv(
      columns,
      displayRows,
      { startRow: rowIndex, startCol: columnIndex, endRow: rowIndex, endCol: columnIndex },
    );
    onCopyText(text, "已复制选中内容");
  }

  /**
   * Sorts on header click; Mod/Ctrl+click selects the column; drag handle resizes.
   * @param event - Mouse event from a column header.
   * @param columnIndex - Clicked column.
   * @returns Nothing (`void`).
   * Side effects: updates sort or selection state.
   */
  function handleHeaderMouseDown(
    event: ReactMouseEvent<HTMLSpanElement>,
    columnIndex: number,
  ): void {
    if (event.button !== 0 || viewRows.length === 0) {
      return;
    }
    if ((event.target as HTMLElement).closest(".result-grid__resize-handle")) {
      return;
    }
    event.preventDefault();
    gridRef.current?.focus();
    setContextMenu(null);
    if (event.metaKey || event.ctrlKey) {
      applySelection(
        { startRow: 0, startCol: columnIndex, endRow: lastRowIndex, endCol: columnIndex },
        { row: 0, col: columnIndex },
        { row: 0, col: columnIndex },
      );
      return;
    }
    if (event.shiftKey && anchor) {
      applySelection(
        {
          startRow: 0,
          startCol: anchor.col,
          endRow: lastRowIndex,
          endCol: columnIndex,
        },
        { row: 0, col: anchor.col },
        { row: 0, col: columnIndex },
      );
      return;
    }
    setSort((current) => cycleColumnSort(current, columnIndex));
  }

  /** Starts dragging a column resize handle. */
  function handleResizePointerDown(
    event: ReactMouseEvent<HTMLSpanElement>,
    columnIndex: number,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    resizeSessionRef.current = {
      columnIndex,
      startX: event.clientX,
      startWidth: widths[columnIndex] ?? DEFAULT_COLUMN_WIDTH,
    };
  }

  /**
   * Opens the result context menu, ensuring the target cell/row is selected first.
   * @param event - Context-menu event from a result cell.
   * @param rowIndex - Right-clicked view-row.
   * @param columnIndex - Right-clicked column.
   * @returns Nothing (`void`).
   * Side effects: updates selection when the click is outside the current range.
   */
  function handleCellContextMenu(
    event: ReactMouseEvent<HTMLSpanElement>,
    rowIndex: number,
    columnIndex: number,
  ): void {
    event.preventDefault();
    gridRef.current?.focus();
    const alreadySelected =
      allSelected || isCellInSelection(normalizedSelection, rowIndex, columnIndex);
    if (!alreadySelected) {
      applySelection(
        {
          startRow: rowIndex,
          startCol: columnIndex,
          endRow: rowIndex,
          endCol: columnIndex,
        },
        { row: rowIndex, col: columnIndex },
        { row: rowIndex, col: columnIndex },
      );
    } else {
      setFocusCell({ row: rowIndex, col: columnIndex });
    }
    setContextMenu(clampMenuPosition(event.clientX, event.clientY));
  }

  /**
   * Handles select-all, navigation, clear, and copy shortcuts.
   * @param event - Bubbled keyboard event from the focusable result table.
   * @returns Nothing (`void`).
   * Side effects: updates selection/focus and may invoke parent copy handlers.
   */
  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (viewRows.length === 0 || cellViewer) {
      return;
    }
    if (matchesShortcut(event, shortcuts.bindings.selectRows)) {
      event.preventDefault();
      selectAllVisibleRows();
      return;
    }
    if (event.key === "Escape") {
      if (contextMenu) {
        event.preventDefault();
        setContextMenu(null);
        return;
      }
      if (allSelected || selection) {
        event.preventDefault();
        setAllSelected(false);
        setSelection(null);
        setAnchor(null);
        setFocusCell(null);
      }
      return;
    }
    if (matchesShortcut(event, shortcuts.bindings.viewResultCell)) {
      if (focusCell || activeSelection) {
        event.preventDefault();
        openCellViewer();
      }
      return;
    }
    if (event.shiftKey && event.key === "F10") {
      event.preventDefault();
      const rowIndex = focusCell?.row ?? activeSelection?.startRow ?? 0;
      const columnIndex = focusCell?.col ?? activeSelection?.startCol ?? 0;
      setFocusCell({ row: rowIndex, col: columnIndex });
      const rect = viewportRef.current?.getBoundingClientRect();
      setContextMenu(clampMenuPosition((rect?.left ?? 0) + 24, (rect?.top ?? 0) + 48));
      return;
    }
    if (matchesShortcut(event, shortcuts.bindings.copyResultSelection) && (allSelected || selection)) {
      event.preventDefault();
      if (allSelected && !normalizedSearch && !sort) {
        onCopyAll?.();
        return;
      }
      copyCurrentSelection(false);
      return;
    }

    const arrowKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
    if (!(arrowKeys as readonly string[]).includes(event.key)) {
      return;
    }
    event.preventDefault();
    const current = focusCell ??
      (activeSelection
        ? { row: activeSelection.endRow, col: activeSelection.endCol }
        : { row: 0, col: 0 });
    const deltaRow = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    const deltaCol = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const nextRow = Math.max(0, Math.min(lastRowIndex, current.row + deltaRow));
    const nextCol = Math.max(0, Math.min(lastColumnIndex, current.col + deltaCol));
    ensureRowVisible(nextRow);
    if (event.shiftKey) {
      const base = anchor ?? current;
      applySelection(
        {
          startRow: base.row,
          startCol: base.col,
          endRow: nextRow,
          endCol: nextCol,
        },
        base,
        { row: nextRow, col: nextCol },
      );
      return;
    }
    applySelection(
      {
        startRow: nextRow,
        startCol: nextCol,
        endRow: nextRow,
        endCol: nextCol,
      },
      { row: nextRow, col: nextCol },
      { row: nextRow, col: nextCol },
    );
  }

  const viewerColumn = cellViewer ? columns[cellViewer.columnIndex] : null;
  const viewerText = cellViewer
    ? cellValueToViewerText(displayRows[cellViewer.rowIndex]?.[cellViewer.columnIndex])
    : "";

  return (
    <div
      ref={gridRef}
      className={`result-grid${allSelected ? " result-grid--selected" : ""}`}
      role="grid"
      aria-label="查询结果"
      aria-selected={allSelected || undefined}
      onKeyDown={handleGridKeyDown}
      tabIndex={0}
    >
      <div className="result-grid__viewport" ref={viewportRef}>
        <div
          className="result-grid__header"
          role="row"
          style={{ gridTemplateColumns, minWidth: gridMinWidth }}
        >
          {columns.map((column, index) => {
            // Cmd+A selects data rows only — do not paint the header as selected.
            const columnSelected =
              !allSelected &&
              normalizedSelection !== null &&
              index >= normalizedSelection.startCol &&
              index <= normalizedSelection.endCol &&
              normalizedSelection.startRow === 0 &&
              normalizedSelection.endRow === lastRowIndex &&
              viewRows.length > 0;
            const sorted = sort?.columnIndex === index ? sort.direction : null;
            return (
              <span
                className={`result-grid__column${columnSelected ? " is-selected" : ""}${sorted ? " is-sorted" : ""}`}
                key={`${column.name}-${index}`}
                role="columnheader"
                aria-selected={columnSelected || undefined}
                aria-sort={
                  sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                }
                title="单击排序 · ⌘/Ctrl+单击选中整列 · 拖拽右缘调整列宽"
                onMouseDown={(event) => handleHeaderMouseDown(event, index)}
              >
                <span className="result-grid__column-title">
                  {column.name}
                  {sorted ? <em aria-hidden="true">{sorted === "asc" ? " ↑" : " ↓"}</em> : null}
                </span>
                <small>{column.databaseType}</small>
                <span
                  aria-hidden="true"
                  className="result-grid__resize-handle"
                  onMouseDown={(event) => handleResizePointerDown(event, index)}
                />
              </span>
            );
          })}
        </div>
        <div
          className="result-grid__rows"
          role="rowgroup"
          style={{ height: virtualizer.getTotalSize(), minWidth: gridMinWidth }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const rowFullySelected =
              allSelected ||
              (normalizedSelection !== null &&
                virtualRow.index >= normalizedSelection.startRow &&
                virtualRow.index <= normalizedSelection.endRow &&
                normalizedSelection.startCol === 0 &&
                normalizedSelection.endCol === lastColumnIndex);
            return (
              <div
                className={`result-grid__row${rowFullySelected ? " is-selected" : ""}`}
                key={virtualRow.key}
                role="row"
                aria-selected={rowFullySelected || undefined}
                style={{
                  gridTemplateColumns,
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {columns.map((column, columnIndex) => {
                  const selected =
                    allSelected ||
                    isCellInSelection(normalizedSelection, virtualRow.index, columnIndex);
                  const focused =
                    focusCell?.row === virtualRow.index && focusCell.col === columnIndex;
                  const searchMatch = cellMatchesSearch(
                    displayRows[virtualRow.index]?.[columnIndex],
                    normalizedSearch,
                  );
                  return (
                    <span
                      className={`result-grid__cell${selected ? " is-selected" : ""}${focused ? " is-focused" : ""}${searchMatch ? " is-search-match" : ""}`}
                      key={`${column.name}-${columnIndex}`}
                      role="gridcell"
                      aria-selected={selected || undefined}
                      title={`${column.name} · 单击选中，⌘/Ctrl+C 复制，双击直接复制`}
                      onMouseDown={(event) => handleCellMouseDown(event, virtualRow.index, columnIndex)}
                      onDoubleClick={() => handleCellDoubleClick(virtualRow.index, columnIndex)}
                      onContextMenu={(event) =>
                        handleCellContextMenu(event, virtualRow.index, columnIndex)
                      }
                    >
                      {renderCellValue(displayRows[virtualRow.index]?.[columnIndex])}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
        {running && rows.length > 0 ? (
          <div className="result-grid__loading" role="status">
            <span className="loading-spinner" aria-hidden="true" />
            正在加载更多…
          </div>
        ) : null}
        {incomplete ? <p className="result-grid__notice">结果不完整</p> : null}
        {normalizedSearch && viewRows.length === 0 ? (
          <p className="result-grid__notice">无匹配结果</p>
        ) : null}
        {normalizedSearch && viewRows.length > 0 ? (
          <p className="result-grid__notice" role="status">
            显示 {viewRows.length} / {rows.length} 行 · {searchMatchCount} 个匹配
          </p>
        ) : null}
      </div>

      {contextMenu ? (
        <div
          aria-label="结果操作"
          className="result-grid-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button onClick={() => copyCurrentSelection(false)} ref={menuItemRef} role="menuitem" type="button">
            复制选中内容
          </button>
          <button
            onClick={() => copyCurrentSelection(true)}
            role="menuitem"
            title="字段名使用结果列名；SQL 别名会按别名复制"
            type="button"
          >
            复制选中内容（含字段名）
          </button>
          <button onClick={() => copySelectionAs("csv")} role="menuitem" type="button">
            复制为 CSV
          </button>
          <button onClick={() => copySelectionAs("json")} role="menuitem" type="button">
            复制为 JSON
          </button>
          <button onClick={() => copySelectionAs("markdown")} role="menuitem" type="button">
            复制为 Markdown
          </button>
          <span className="result-grid-context-menu__separator" role="separator" />
          <button onClick={() => copySelectionAsInsert(true)} role="menuitem" type="button">
            复制为 INSERT
          </button>
          <button
            disabled={!hasIdColumn}
            onClick={() => copySelectionAsInsert(false)}
            role="menuitem"
            title={hasIdColumn ? "排除名为 id 的列" : "当前结果没有 id 列"}
            type="button"
          >
            复制为 INSERT（不含主键 id）
          </button>
          <button
            onClick={() => copySelectionAs("in")}
            role="menuitem"
            title="去重后生成 WHERE … IN (...)"
            type="button"
          >
            复制为 IN (...)
          </button>
          <span className="result-grid-context-menu__separator" role="separator" />
          <button onClick={selectCurrentRow} role="menuitem" type="button">
            选中整行
          </button>
          <button onClick={selectCurrentColumn} role="menuitem" type="button">
            选中整列
          </button>
          <button onClick={() => copySelectionAs("names")} role="menuitem" type="button">
            复制字段名
          </button>
          <button onClick={openCellViewer} role="menuitem" title="也可按 F2" type="button">
            查看完整内容…
          </button>
        </div>
      ) : null}

      {cellViewer && viewerColumn ? (
        <div
          aria-label="单元格内容"
          aria-modal="true"
          className="result-cell-viewer"
          role="dialog"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setCellViewer(null);
            }
          }}
        >
          <div className="result-cell-viewer__panel">
            <header className="result-cell-viewer__header">
              <div>
                <strong>{viewerColumn.name}</strong>
                <span>{viewerColumn.databaseType}</span>
              </div>
              <button autoFocus onClick={() => setCellViewer(null)} type="button">
                关闭
              </button>
            </header>
            <pre className="result-cell-viewer__body">{viewerText}</pre>
            <footer className="result-cell-viewer__footer">
              <button
                onClick={() => {
                  onCopyText?.(viewerText, "已复制单元格内容");
                }}
                type="button"
              >
                复制内容
              </button>
              <button onClick={() => setCellViewer(null)} type="button">
                完成
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
