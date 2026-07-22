import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { QueryWorkspace } from "./QueryWorkspace";

const sessionController = vi.hoisted(() => ({
  state: {
    queryId: "query-1",
    connectionId: "connection-1",
    sql: "select 1",
    columns: [],
    rows: [],
    running: true,
    cancelRequested: true,
    incomplete: false,
    affectedRows: null,
    error: null,
  },
  run: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("./useQuerySession", () => ({ useQuerySession: () => sessionController }));
vi.mock("./QueryEditor", () => ({ QueryEditor: () => <div aria-label="SQL 编辑器" /> }));
vi.mock("./ResultGrid", () => ({ ResultGrid: () => <div aria-label="查询结果" /> }));

const PROFILE: ConnectionProfile = {
  id: "connection-1",
  name: "本地开发库",
  engine: "my_sql",
  environment: "development",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  database: "pipa",
  tlsMode: "preferred",
};

/**
 * Verifies running feedback remains intentionally small after cancellation is requested.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders a query workspace with a mocked active session.
 */
function assertMinimalQueryLoading(): void {
  render(<QueryWorkspace profile={PROFILE} />);

  expect(screen.getByText("查询中…")).toBeVisible();
  expect(screen.getByRole("button", { name: "取消" })).toBeVisible();
  expect(screen.queryByText(/耗时|行数|连接中|执行阶段|正在认证/)).not.toBeInTheDocument();
}

describe("QueryWorkspace", () => {
  it("keeps cancel visible without diagnostic loading copy", assertMinimalQueryLoading);
});
