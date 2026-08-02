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

/** Verifies a busy query can switch only to and from the read-only utility workspace. */
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
  expect(screen.getByRole("tab", { name: /orders/ })).toBeDisabled();

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

describe("WorkspaceTabs", () => {
  afterEach(cleanup);
  it("shares query and table workspace actions", assertSharedWorkspaceActions);
  it("allows utility switching while a query is busy", assertBusyQueryAllowsUtilitySwitching);
  it("requests detachment when a safe tab is dragged outside", assertDraggingOutsideRequestsDetach);
});
