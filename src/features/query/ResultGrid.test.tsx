import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";
import { ResultGrid } from "./ResultGrid";

const virtualizerState = vi.hoisted(() => ({ called: false }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => {
    virtualizerState.called = true;
    const items = Array.from({ length: options.count }, (_, index) => ({
      index,
      key: `row-${index}`,
      size: 34,
      start: index * 34,
    }));
    return {
      getTotalSize: () => options.count * 34,
      getVirtualItems: () => items,
      scrollToIndex: vi.fn(),
    };
  },
}));

const COLUMNS: QueryColumn[] = [
  { name: "id", databaseType: "BIGINT", nullable: false },
  { name: "integer", databaseType: "BIGINT", nullable: false },
  { name: "decimal", databaseType: "DECIMAL", nullable: false },
  { name: "json", databaseType: "JSON", nullable: true },
  { name: "binary", databaseType: "BLOB", nullable: true },
  { name: "missing", databaseType: "TEXT", nullable: true },
];
const ROW: CellValue[] = [
  { kind: "integer", value: "1" },
  { kind: "integer", value: "9007199254740993" },
  { kind: "decimal", value: "12.3400" },
  { kind: "json", value: "{\"compact\":true}" },
  { kind: "binary", value: "AAEC" },
  { kind: "null" },
];
const ROW_TWO: CellValue[] = [
  { kind: "integer", value: "2" },
  { kind: "integer", value: "3" },
  { kind: "decimal", value: "0.5" },
  { kind: "null" },
  { kind: "null" },
  { kind: "text", value: "note" },
];
const ROW_THREE: CellValue[] = [
  { kind: "integer", value: "3" },
  { kind: "integer", value: "7" },
  { kind: "decimal", value: "1.25" },
  { kind: "null" },
  { kind: "null" },
  { kind: "text", value: "third" },
];

/**
 * Verifies virtualization and transport-safe presentation of database values.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the virtual result grid in jsdom.
 */
function assertLosslessVirtualRows(): void {
  render(<ResultGrid columns={COLUMNS} rows={[ROW]} running={false} incomplete={false} />);

  expect(virtualizerState.called).toBe(true);
  expect(screen.getByText("9007199254740993")).toBeVisible();
  expect(screen.getByText("12.3400")).toBeVisible();
  expect(screen.getByText('{"compact":true}')).toBeVisible();
  expect(screen.getByText("Binary")).toBeVisible();
  expect(screen.getByText("NULL")).toHaveClass("result-cell--null");
}

/**
 * Verifies deliberately minimal streaming feedback at the result boundary.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the running result grid in jsdom.
 */
function assertMinimalStreamingFeedback(): void {
  render(<ResultGrid columns={COLUMNS} rows={[ROW]} running incomplete={false} />);

  expect(screen.getByText("正在加载更多…")).toBeVisible();
  expect(screen.queryByText(/行|耗时|阶段|连接中/)).not.toBeInTheDocument();
}

/**
 * Verifies select-all then copy shortcuts operate on the in-memory result set.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: focuses the result grid and dispatches keyboard shortcuts.
 */
function assertSelectAllThenCopyShortcut(): void {
  const onCopyAll = vi.fn();
  render(
    <ResultGrid
      columns={COLUMNS}
      rows={[ROW]}
      running={false}
      incomplete={false}
      onCopyAll={onCopyAll}
    />,
  );
  const grid = screen.getByRole("grid", { name: "查询结果" });
  grid.focus();
  fireEvent.keyDown(grid, { key: "a", metaKey: true });
  expect(grid).toHaveClass("result-grid--selected");
  fireEvent.keyDown(grid, { key: "c", metaKey: true });
  expect(onCopyAll).toHaveBeenCalledTimes(1);
}

/**
 * Verifies clicking a result cell focuses the grid so Mod+A selects all rows.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: mouse-downs a cell then dispatches the select-all shortcut on document.
 */
function assertSelectAllAfterCellClick(): void {
  render(
    <section className="query-results">
      <ResultGrid columns={COLUMNS} rows={[ROW, ROW_TWO]} running={false} incomplete={false} />
    </section>,
  );
  const cell = screen.getByText("9007199254740993");
  fireEvent.mouseDown(cell);
  const grid = screen.getByRole("grid", { name: "查询结果" });
  expect(grid).toHaveFocus();
  fireEvent.keyDown(grid, { key: "a", metaKey: true });
  expect(grid).toHaveClass("result-grid--selected");
  expect(grid).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("columnheader", { name: /id/i })).not.toHaveClass("is-selected");
  expect(screen.getByText("9007199254740993")).toHaveClass("is-selected");
}

/**
 * Verifies Mod+A from results chrome (not the grid itself) still selects all rows.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: focuses a sibling control in `.query-results` and dispatches Mod+A.
 */
function assertSelectAllFromResultsPaneChrome(): void {
  render(
    <section className="query-results">
      <button type="button">导出</button>
      <ResultGrid columns={COLUMNS} rows={[ROW, ROW_TWO]} running={false} incomplete={false} />
    </section>,
  );
  const exportButton = screen.getByRole("button", { name: "导出" });
  exportButton.focus();
  fireEvent.keyDown(exportButton, { key: "a", metaKey: true, bubbles: true });
  const grid = screen.getByRole("grid", { name: "查询结果" });
  expect(grid).toHaveClass("result-grid--selected");
  expect(grid).toHaveFocus();
}

/**
 * Verifies clicking a cell then Mod+C copies only that cell's plain text.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the grid and dispatches mouse/keyboard events.
 */
function assertCopySelectedCellOnly(): void {
  const onCopyText = vi.fn();
  render(
    <ResultGrid
      columns={COLUMNS}
      rows={[ROW, ROW_TWO]}
      running={false}
      incomplete={false}
      onCopyText={onCopyText}
    />,
  );
  const cell = screen.getByText("9007199254740993");
  fireEvent.mouseDown(cell);
  expect(cell).toHaveClass("is-selected");

  const grid = screen.getByRole("grid", { name: "查询结果" });
  grid.focus();
  fireEvent.keyDown(grid, { key: "c", metaKey: true });
  expect(onCopyText).toHaveBeenCalledWith("9007199254740993", "已复制选中内容");
}

/**
 * Verifies right-click copy can include selected field names/aliases.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: opens the result context menu and invokes copy callbacks.
 */
function assertCopySelectionWithFieldNames(): void {
  const onCopyText = vi.fn();
  const aliasedColumns: QueryColumn[] = [
    { name: "order_id", databaseType: "BIGINT", nullable: false },
    { name: "amount", databaseType: "BIGINT", nullable: false },
    { name: "decimal", databaseType: "DECIMAL", nullable: false },
    { name: "json", databaseType: "JSON", nullable: true },
    { name: "binary", databaseType: "BLOB", nullable: true },
    { name: "missing", databaseType: "TEXT", nullable: true },
  ];
  render(
    <ResultGrid
      columns={aliasedColumns}
      rows={[ROW, ROW_TWO]}
      running={false}
      incomplete={false}
      onCopyText={onCopyText}
    />,
  );
  fireEvent.mouseDown(screen.getByText("9007199254740993"));
  fireEvent.contextMenu(screen.getByText("9007199254740993"));
  fireEvent.click(screen.getByRole("menuitem", { name: "复制选中内容（含字段名）" }));

  expect(onCopyText).toHaveBeenCalledWith("amount\n9007199254740993", "已复制 1 个单元格（含字段名）");
}

/**
 * Verifies right-click copy-as-INSERT can omit the primary-key id column.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: opens the result context menu and invokes copy callbacks.
 */
function assertCopyRowAsInsertWithoutId(): void {
  const onCopyText = vi.fn();
  render(
    <ResultGrid
      columns={COLUMNS}
      rows={[ROW, ROW_TWO]}
      running={false}
      incomplete={false}
      tableName="demo.orders"
      onCopyText={onCopyText}
    />,
  );
  const cell = screen.getByText("9007199254740993");
  fireEvent.contextMenu(cell);
  fireEvent.click(screen.getByRole("menuitem", { name: "复制为 INSERT（不含主键 id）" }));

  expect(onCopyText).toHaveBeenCalledTimes(1);
  const [sql, feedback] = onCopyText.mock.calls[0] as [string, string];
  expect(feedback).toBe("已复制 1 行 INSERT（不含 id）");
  expect(sql).toContain("INSERT INTO `demo`.`orders`");
  expect(sql).not.toMatch(/`id`/);
  expect(sql).toContain("`integer`");
  expect(sql).toContain("9007199254740993");
}

/**
 * Verifies search filtering keeps matching rows and highlights matching cells.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders a filtered result grid in jsdom.
 */
function assertSearchFiltersRows(): void {
  render(
    <ResultGrid
      columns={COLUMNS}
      rows={[ROW, ROW_TWO]}
      running={false}
      incomplete={false}
      searchQuery="9007199254740993"
    />,
  );
  expect(screen.getByText("9007199254740993")).toHaveClass("is-search-match");
  expect(screen.queryByText("note")).not.toBeInTheDocument();
  expect(screen.getByText(/显示 1 \/ 2 行/)).toBeVisible();
}

/**
 * Verifies header click cycles sort indicators.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: clicks a column header in jsdom.
 */
function assertHeaderSortCycle(): void {
  render(
    <ResultGrid columns={COLUMNS} rows={[ROW, ROW_TWO]} running={false} incomplete={false} />,
  );
  const headerName = /integer/i;
  fireEvent.mouseDown(screen.getByRole("columnheader", { name: headerName }));
  expect(screen.getByRole("columnheader", { name: headerName })).toHaveAttribute("aria-sort", "ascending");
  fireEvent.mouseDown(screen.getByRole("columnheader", { name: headerName }));
  expect(screen.getByRole("columnheader", { name: headerName })).toHaveAttribute("aria-sort", "descending");
  fireEvent.mouseDown(screen.getByRole("columnheader", { name: headerName }));
  expect(screen.getByRole("columnheader", { name: headerName })).toHaveAttribute("aria-sort", "none");
}

/**
 * Verifies IN-list copy and opening the cell viewer via F2 / context menu.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: opens the context menu and cell viewer dialog.
 */
function assertInListCopyAndCellViewer(): void {
  const onCopyText = vi.fn();
  render(
    <ResultGrid
      columns={COLUMNS}
      rows={[ROW, ROW_TWO]}
      running={false}
      incomplete={false}
      onCopyText={onCopyText}
    />,
  );
  fireEvent.mouseDown(screen.getByText("1"));
  fireEvent.contextMenu(screen.getByText("1"));
  fireEvent.click(screen.getByRole("menuitem", { name: "复制为 IN (...)" }));
  expect(onCopyText).toHaveBeenCalledWith("IN (1)", "已复制为 IN (...)");

  fireEvent.mouseDown(screen.getByText('{"compact":true}'));
  const grid = screen.getByRole("grid", { name: "查询结果" });
  grid.focus();
  fireEvent.keyDown(grid, { key: "F2" });
  expect(screen.getByRole("dialog", { name: "单元格内容" })).toBeVisible();
  expect(screen.getByText(/"compact": true/)).toBeVisible();
}

/**
 * Verifies double-click copies the cell immediately instead of opening a dialog.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: double-clicks a result cell in jsdom.
 */
function assertDoubleClickCopiesCell(): void {
  const onCopyText = vi.fn();
  render(
    <ResultGrid
      columns={COLUMNS}
      rows={[ROW, ROW_TWO]}
      running={false}
      incomplete={false}
      onCopyText={onCopyText}
    />,
  );
  fireEvent.doubleClick(screen.getByText("9007199254740993"));
  expect(onCopyText).toHaveBeenCalledWith("9007199254740993", "已复制选中内容");
  expect(screen.queryByRole("dialog", { name: "单元格内容" })).not.toBeInTheDocument();
}

/**
 * Verifies Mod/Ctrl+click can accumulate non-contiguous full-row selections.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: toggles rows in the result grid and copies the sparse selection.
 */
function assertDiscreteRowMultiSelect(): void {
  const onCopyText = vi.fn();
  const onSelectionChange = vi.fn();
  render(
    <ResultGrid
      columns={COLUMNS}
      rows={[ROW, ROW_TWO, ROW_THREE]}
      running={false}
      incomplete={false}
      onCopyText={onCopyText}
      onSelectionChange={onSelectionChange}
    />,
  );

  fireEvent.mouseDown(screen.getByText("9007199254740993"), { metaKey: true });
  fireEvent.mouseDown(screen.getByText("third"), { metaKey: true });

  expect(screen.getByText("9007199254740993")).toHaveClass("is-selected");
  expect(screen.getByText("third")).toHaveClass("is-selected");
  expect(screen.getByText("note")).not.toHaveClass("is-selected");
  expect(onSelectionChange).toHaveBeenLastCalledWith("已选 2 行");

  const grid = screen.getByRole("grid", { name: "查询结果" });
  grid.focus();
  fireEvent.keyDown(grid, { key: "c", metaKey: true });
  expect(onCopyText).toHaveBeenCalledWith(
    expect.stringMatching(/^1\t9007199254740993[\s\S]*\n3\t7\t1\.25/u),
    "已复制 12 个单元格",
  );

  fireEvent.mouseDown(screen.getByText("third"), { metaKey: true });
  expect(screen.getByText("third")).not.toHaveClass("is-selected");
  expect(onSelectionChange).toHaveBeenLastCalledWith("已选 1 行");
}

describe("ResultGrid", () => {
  afterEach(cleanup);
  it("virtualizes rows and renders lossless cell values", assertLosslessVirtualRows);
  it("shows only minimal bottom streaming feedback", assertMinimalStreamingFeedback);
  it("copies all rows after select-all", assertSelectAllThenCopyShortcut);
  it("selects all rows with Mod+A after clicking a cell", assertSelectAllAfterCellClick);
  it("selects all rows with Mod+A from the results pane chrome", assertSelectAllFromResultsPaneChrome);
  it("copies only the selected cell contents", assertCopySelectedCellOnly);
  it("copies selected content with field name aliases", assertCopySelectionWithFieldNames);
  it("copies a selected row as INSERT without primary key id", assertCopyRowAsInsertWithoutId);
  it("filters and highlights search matches", assertSearchFiltersRows);
  it("cycles column sort from the header", assertHeaderSortCycle);
  it("copies IN lists and opens the cell viewer", assertInListCopyAndCellViewer);
  it("copies a cell on double-click without opening a dialog", assertDoubleClickCopiesCell);
  it("toggles non-contiguous rows with Mod+click", assertDiscreteRowMultiSelect);
});
