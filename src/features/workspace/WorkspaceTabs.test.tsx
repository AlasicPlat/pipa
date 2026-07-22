import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/** Verifies SQL and table tabs share selection, close, and create controls. */
function assertSharedWorkspaceActions(): void {
  const actions = {
    closeQuery: vi.fn(),
    closeTable: vi.fn(),
    createQuery: vi.fn(),
    selectQuery: vi.fn(),
    selectTable: vi.fn(),
  };
  render(
    <WorkspaceTabs
      activeQueryTabId={QUERY_TAB.id}
      activeTableTabId={TABLE_TAB.id}
      busyQueryTabId={null}
      dirtyTableTabIds={new Set([TABLE_TAB.id])}
      newQueryConnectionName="本地开发"
      onCloseQuery={actions.closeQuery}
      onCloseTable={actions.closeTable}
      onCreateQuery={actions.createQuery}
      onSelectQuery={actions.selectQuery}
      onSelectTable={actions.selectTable}
      queryTabs={[QUERY_TAB]}
      tableTabs={[TABLE_TAB]}
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

describe("WorkspaceTabs", () => {
  afterEach(cleanup);
  it("shares query and table workspace actions", assertSharedWorkspaceActions);
});
