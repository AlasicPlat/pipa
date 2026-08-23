import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "./WorkspaceTabs";

const QUERY_TAB = {
  id: "query-1",
  connectionId: "connection-1",
  title: "查询 1",
  sqlText: "SELECT 1;",
  position: 0,
};
const TABLE_TAB = {
  id: "connection-1:orders",
  connectionId: "connection-1",
  tableName: "orders",
  title: "本地开发 · orders",
};
const UTILITY_TAB = {
  id: "binlog-analysis",
  kind: "binlog" as const,
  title: "Binlog 分析",
};

/** Verifies SQL and table tabs share selection, close, and create controls. */
function assertSharedWorkspaceActions(): void {
  const actions = {
    closeQuery: vi.fn(),
    closeTable: vi.fn(),
    closeUtility: vi.fn(),
    createQuery: vi.fn(),
    selectQuery: vi.fn(),
    selectTable: vi.fn(),
    selectUtility: vi.fn(),
  };
  render(
    <WorkspaceTabs
      activeQueryTabId={QUERY_TAB.id}
      activeTableTabId={TABLE_TAB.id}
      activeUtilityTabId={null}
      busyQueryTabId={null}
      dirtyTableTabIds={new Set([TABLE_TAB.id])}
      newQueryConnectionName="本地开发"
      onCloseQuery={actions.closeQuery}
      onCloseTable={actions.closeTable}
      onCloseUtility={actions.closeUtility}
      onCreateQuery={actions.createQuery}
      onSelectQuery={actions.selectQuery}
      onSelectTable={actions.selectTable}
      onSelectUtility={actions.selectUtility}
      queryTabs={[QUERY_TAB]}
      tableTabs={[TABLE_TAB]}
      utilityTabs={[]}
    />,
  );

  expect(screen.getAllByRole("tab")).toHaveLength(2);
  fireEvent.click(screen.getByRole("tab", { name: /查询 1/ }));
  expect(screen.getByRole("tab", { name: /orders，有未提交修改/ })).toHaveAccessibleName(/有未提交修改/);
  fireEvent.click(screen.getByRole("tab", { name: /orders/ }));
  fireEvent.click(screen.getByRole("button", { name: "关闭表 orders" }));
  fireEvent.click(screen.getByRole("button", { name: /在当前已选 MySQL 连接/ }));

  expect(actions.selectQuery).toHaveBeenCalledWith(QUERY_TAB.id);
  expect(actions.selectTable).toHaveBeenCalledWith(TABLE_TAB.id);
  expect(actions.closeTable).toHaveBeenCalledWith(TABLE_TAB.id);
  expect(actions.createQuery).toHaveBeenCalledTimes(1);
}

/** Verifies a busy query still allows tab navigation while its own close stays guarded. */
function assertBusyQueryAllowsUtilitySwitching(): void {
  const actions = {
    closeQuery: vi.fn(),
    closeTable: vi.fn(),
    closeUtility: vi.fn(),
    createQuery: vi.fn(),
    selectQuery: vi.fn(),
    selectTable: vi.fn(),
    selectUtility: vi.fn(),
  };
  render(
    <WorkspaceTabs
      activeQueryTabId={QUERY_TAB.id}
      activeTableTabId={null}
      activeUtilityTabId={UTILITY_TAB.id}
      busyQueryTabId={QUERY_TAB.id}
      dirtyTableTabIds={new Set()}
      newQueryConnectionName="本地开发"
      onCloseQuery={actions.closeQuery}
      onCloseTable={actions.closeTable}
      onCloseUtility={actions.closeUtility}
      onCreateQuery={actions.createQuery}
      onSelectQuery={actions.selectQuery}
      onSelectTable={actions.selectTable}
      onSelectUtility={actions.selectUtility}
      queryTabs={[QUERY_TAB]}
      tableTabs={[TABLE_TAB]}
      utilityTabs={[UTILITY_TAB]}
    />,
  );

  const queryTab = screen.getByRole("tab", { name: "查询 1" });
  const utilityTab = screen.getByRole("tab", { name: "Binlog 分析" });
  expect(queryTab).not.toBeDisabled();
  expect(utilityTab).not.toBeDisabled();
  expect(utilityTab).toHaveAttribute("aria-controls", "workspace-panel-binlog-analysis");
  // A running query stays mounted while hidden, so navigation is never blocked.
  expect(screen.getByRole("tab", { name: /orders/ })).not.toBeDisabled();
  // Closing the running query is still refused until it settles.
  expect(screen.getByRole("button", { name: "关闭 查询 1" })).toBeDisabled();

  fireEvent.click(queryTab);
  fireEvent.click(utilityTab);
  fireEvent.click(screen.getByRole("button", { name: "关闭 Binlog 分析" }));

  expect(actions.selectQuery).toHaveBeenCalledWith(QUERY_TAB.id);
  expect(actions.selectUtility).toHaveBeenCalledWith(UTILITY_TAB.id);
  expect(actions.closeUtility).toHaveBeenCalledWith(UTILITY_TAB.id);
}

/** Verifies dragging a safe tab beyond the native window requests one detached workspace. */
function assertDraggingOutsideRequestsDetach(): void {
  const onDetach = vi.fn();
  const onSelectQuery = vi.fn();
  render(
    <WorkspaceTabs
      activeQueryTabId={QUERY_TAB.id}
      activeTableTabId={null}
      activeUtilityTabId={null}
      busyQueryTabId={null}
      dirtyTableTabIds={new Set([TABLE_TAB.id])}
      newQueryConnectionName="本地开发"
      onCloseQuery={vi.fn()}
      onCloseTable={vi.fn()}
      onCloseUtility={vi.fn()}
      onCreateQuery={vi.fn()}
      onDetach={onDetach}
      onSelectQuery={onSelectQuery}
      onSelectTable={vi.fn()}
      onSelectUtility={vi.fn()}
      queryTabs={[QUERY_TAB]}
      tableTabs={[TABLE_TAB]}
      utilityTabs={[]}
    />,
  );

  const queryTab = screen.getByRole("tab", { name: QUERY_TAB.title });
  const tableTab = screen.getByRole("tab", { name: /orders，有未提交修改/ });
  expect(queryTab).toHaveAttribute("draggable", "true");
  expect(tableTab).toHaveAttribute("draggable", "false");
  const setData = vi.fn();
  fireEvent.dragStart(queryTab, {
    dataTransfer: { effectAllowed: "none", setData },
  });
  expect(setData).toHaveBeenCalledWith("text/plain", QUERY_TAB.id);
  expect(onSelectQuery).not.toHaveBeenCalled();
  expect(queryTab.parentElement).toHaveClass("is-dragging");
  const outsideX = window.screenX + window.outerWidth + 20;
  const dragEnd = createEvent.dragEnd(queryTab);
  Object.defineProperties(dragEnd, {
    screenX: { value: outsideX },
    screenY: { value: 200 },
  });
  fireEvent(queryTab, dragEnd);
  expect(queryTab.parentElement).not.toHaveClass("is-dragging");
  expect(onDetach).toHaveBeenCalledWith({
    kind: "query",
    point: { x: outsideX, y: 200 },
    tabId: QUERY_TAB.id,
  });
}

const SECOND_QUERY_TAB = {
  id: "query-2",
  connectionId: "connection-1",
  title: "查询 2",
  sqlText: "SELECT 2;",
  position: 1,
};

/** Renders the strip with two query tabs and the supplied optional handlers. */
function renderReorderableTabs(overrides: {
  busyQueryTabId?: string | null;
  onReorderQuery?: (tabId: string, targetIndex: number) => void;
  onDetach?: (request: unknown) => void;
  onCloseQuery?: (tabId: string) => void;
}): void {
  render(
    <WorkspaceTabs
      activeQueryTabId={QUERY_TAB.id}
      activeTableTabId={null}
      activeUtilityTabId={null}
      busyQueryTabId={overrides.busyQueryTabId ?? null}
      dirtyTableTabIds={new Set()}
      newQueryConnectionName="本地开发"
      onCloseQuery={overrides.onCloseQuery ?? vi.fn()}
      onCloseTable={vi.fn()}
      onCloseUtility={vi.fn()}
      onCreateQuery={vi.fn()}
      onReorderQuery={overrides.onReorderQuery}
      onSelectQuery={vi.fn()}
      onSelectTable={vi.fn()}
      onSelectUtility={vi.fn()}
      queryTabs={[QUERY_TAB, SECOND_QUERY_TAB]}
      tableTabs={[]}
      utilityTabs={[]}
    />,
  );
}

/** Verifies dropping a tab onto a sibling slot reorders within the same group. */
function assertDroppingOnSiblingReorders(): void {
  const onReorderQuery = vi.fn();
  renderReorderableTabs({ onReorderQuery });

  const firstTab = screen.getByRole("tab", { name: "查询 1" });
  const secondSlot = screen.getByRole("tab", { name: "查询 2" }).parentElement;
  if (!secondSlot) throw new Error("expected the second tab to have a slot wrapper");

  fireEvent.dragStart(firstTab, { dataTransfer: { effectAllowed: "none", setData: vi.fn() } });
  fireEvent.dragOver(secondSlot, { dataTransfer: { dropEffect: "none" } });
  expect(secondSlot).toHaveClass("is-drop-target");

  fireEvent.drop(secondSlot, { dataTransfer: { dropEffect: "move" } });
  expect(onReorderQuery).toHaveBeenCalledWith(QUERY_TAB.id, 1);
  expect(secondSlot).not.toHaveClass("is-drop-target");
}

/** Verifies the context menu closes every sibling tab but the invoking one. */
function assertContextMenuClosesOtherTabs(): void {
  const onCloseQuery = vi.fn();
  renderReorderableTabs({ onCloseQuery });

  fireEvent.contextMenu(screen.getByRole("tab", { name: "查询 1" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "关闭其他" }));

  expect(onCloseQuery).toHaveBeenCalledTimes(1);
  expect(onCloseQuery).toHaveBeenCalledWith(SECOND_QUERY_TAB.id);
}

/** 验证批量关闭和右键关闭都不会卸载仍在执行 SQL 的查询标签。 */
function assertContextMenuPreservesBusyQuery(): void {
  const onCloseQuery = vi.fn();
  renderReorderableTabs({ busyQueryTabId: QUERY_TAB.id, onCloseQuery });

  fireEvent.contextMenu(screen.getByRole("tab", { name: "查询 2" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "关闭其他" }));
  expect(onCloseQuery).not.toHaveBeenCalled();

  fireEvent.contextMenu(screen.getByRole("tab", { name: "查询 1" }));
  expect(screen.getByRole("menuitem", { name: "关闭" })).toBeDisabled();
}

/** Verifies the menu offers a no-drag path to detach one workspace. */
function assertContextMenuDetaches(): void {
  const onDetach = vi.fn();
  render(
    <WorkspaceTabs
      activeQueryTabId={QUERY_TAB.id}
      activeTableTabId={null}
      activeUtilityTabId={null}
      busyQueryTabId={null}
      dirtyTableTabIds={new Set()}
      newQueryConnectionName="本地开发"
      onCloseQuery={vi.fn()}
      onCloseTable={vi.fn()}
      onCloseUtility={vi.fn()}
      onCreateQuery={vi.fn()}
      onDetach={onDetach}
      onSelectQuery={vi.fn()}
      onSelectTable={vi.fn()}
      onSelectUtility={vi.fn()}
      queryTabs={[QUERY_TAB]}
      tableTabs={[]}
      utilityTabs={[]}
    />,
  );

  fireEvent.contextMenu(screen.getByRole("tab", { name: "查询 1" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "在新窗口中打开" }));

  expect(onDetach).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "query", tabId: QUERY_TAB.id }),
  );
}

/** Verifies Escape dismisses the tab action menu. */
function assertEscapeClosesTabMenu(): void {
  renderReorderableTabs({});

  fireEvent.contextMenu(screen.getByRole("tab", { name: "查询 1" }));
  expect(screen.getByRole("menu", { name: "工作区标签操作" })).toBeInTheDocument();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "工作区标签操作" })).not.toBeInTheDocument();
}

describe("WorkspaceTabs", () => {
  afterEach(cleanup);
  it("shares query and table workspace actions", assertSharedWorkspaceActions);
  it("allows utility switching while a query is busy", assertBusyQueryAllowsUtilitySwitching);
  it("requests detachment when a safe tab is dragged outside", assertDraggingOutsideRequestsDetach);
  it("reorders a tab dropped onto a sibling slot", assertDroppingOnSiblingReorders);
  it("closes sibling tabs from the context menu", assertContextMenuClosesOtherTabs);
  it("preserves a busy query during context-menu close actions", assertContextMenuPreservesBusyQuery);
  it("detaches a workspace from the context menu", assertContextMenuDetaches);
  it("closes the tab menu on Escape", assertEscapeClosesTabMenu);
});
