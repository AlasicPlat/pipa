import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const monacoState = vi.hoisted(() => ({
  sql: "select 1;\nselect 2;",
  selection: {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 9,
  } as {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null,
  position: { lineNumber: 2, column: 4 },
}));

vi.mock("./useQuerySession", () => ({ useQuerySession: () => sessionController }));
vi.mock("./ResultGrid", () => ({ ResultGrid: () => <div aria-label="查询结果" /> }));
vi.mock("@monaco-editor/react", () => ({
  default: (props: { onMount: (editor: unknown, monaco: unknown) => void }) => {
    /** Converts Monaco line/column coordinates to a UTF-16 test offset. */
    function getOffsetAt(position: { lineNumber: number; column: number }): number {
      const lines = monacoState.sql.split("\n");
      return (
        lines.slice(0, position.lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) +
        position.column -
        1
      );
    }

    props.onMount(
      {
        addAction: () => undefined,
        getModel: () => ({ getOffsetAt }),
        getPosition: () => monacoState.position,
        getSelection: () => monacoState.selection,
        getValue: () => monacoState.sql,
      },
      { KeyMod: { CtrlCmd: 2048 }, KeyCode: { KEY_R: 48 } },
    );
    return <div aria-label="SQL 编辑器" />;
  },
}));

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

/**
 * Verifies the toolbar delegates to Monaco's selection-first execution path.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the workspace and clicks its visible execute control.
 */
function assertToolbarSelectionExecution(): void {
  sessionController.state.running = false;
  monacoState.selection = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 9,
  };
  render(<QueryWorkspace profile={PROFILE} />);

  fireEvent.click(screen.getByRole("button", { name: /执行/ }));
  expect(sessionController.run).toHaveBeenCalledWith("select 1");
}

/**
 * Verifies the toolbar delegates to Monaco's cursor-statement path without a selection.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the workspace and clicks its visible execute control.
 */
function assertToolbarCursorExecution(): void {
  sessionController.state.running = false;
  monacoState.selection = null;
  render(<QueryWorkspace profile={PROFILE} />);

  fireEvent.click(screen.getByRole("button", { name: /执行/ }));
  expect(sessionController.run).toHaveBeenCalledWith("select 2");
}

/** Registers loading and toolbar scope regression tests. */
function registerQueryWorkspaceTests(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionController.state.running = true;
    sessionController.state.cancelRequested = true;
    monacoState.sql = "select 1;\nselect 2;";
    monacoState.position = { lineNumber: 2, column: 4 };
  });
  afterEach(cleanup);
  it("keeps cancel visible without diagnostic loading copy", assertMinimalQueryLoading);
  it("executes only Monaco's selected SQL from the toolbar", assertToolbarSelectionExecution);
  it("executes only Monaco's cursor statement from the toolbar", assertToolbarCursorExecution);
}

describe("QueryWorkspace", registerQueryWorkspaceTests);
