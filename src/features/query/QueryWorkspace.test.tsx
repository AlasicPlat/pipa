import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "../../bindings/AppError";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { QuerySessionState } from "./useQuerySession";
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
  } as QuerySessionState,
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

const TAB = {
  id: "tab-1",
  connectionId: PROFILE.id,
  title: "查询 1",
  sqlText: "select 1;\nselect 2;",
  position: 0,
};

const WORKSPACE_PROPS = {
  profile: PROFILE,
  tab: TAB,
  tabs: [TAB],
  persistenceError: null,
  newQueryConnectionName: PROFILE.name,
  onCreateQuery: vi.fn(),
  onRetryPersistence: vi.fn(async () => undefined),
  onSelectTab: vi.fn(),
  onSqlChange: vi.fn(),
};

/**
 * Verifies running feedback remains intentionally small after cancellation is requested.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders a query workspace with a mocked active session.
 */
function assertMinimalQueryLoading(): void {
  render(<QueryWorkspace {...WORKSPACE_PROPS} />);

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
  render(<QueryWorkspace {...WORKSPACE_PROPS} />);

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
  render(<QueryWorkspace {...WORKSPACE_PROPS} />);

  fireEvent.click(screen.getByRole("button", { name: /执行/ }));
  expect(sessionController.run).toHaveBeenCalledWith("select 2");
}

/** Verifies a captured editor shortcut cannot start a second query while one is running. */
function assertRunningSessionIgnoresExecuteShortcut(): void {
  sessionController.state.running = true;
  render(<QueryWorkspace {...WORKSPACE_PROPS} />);
  const shortcut = new KeyboardEvent("keydown", {
    key: "r",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(shortcut);

  expect(shortcut.defaultPrevented).toBe(true);
  expect(sessionController.run).not.toHaveBeenCalled();
}

/** Verifies button and shortcut share one guarded new-query action. */
function assertNewQueryControlsShareRunningGuard(): void {
  sessionController.state.running = false;
  const view = render(<QueryWorkspace {...WORKSPACE_PROPS} />);
  const shortcut = new KeyboardEvent("keydown", {
    key: "t",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(shortcut);

  expect(shortcut.defaultPrevented).toBe(true);
  expect(WORKSPACE_PROPS.onCreateQuery).toHaveBeenCalledTimes(1);

  sessionController.state.running = true;
  view.rerender(<QueryWorkspace {...WORKSPACE_PROPS} />);
  const button = screen.getByRole("button", {
    name: `在当前已选 MySQL 连接 ${PROFILE.name} 中新建查询`,
  });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  const runningShortcut = new KeyboardEvent("keydown", {
    key: "t",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(runningShortcut);
  expect(runningShortcut.defaultPrevented).toBe(true);
  expect(WORKSPACE_PROPS.onCreateQuery).toHaveBeenCalledTimes(1);
}

/** Verifies safe guidance and redacted diagnostics are progressively disclosed. */
function assertLayeredQueryError(): void {
  const error: AppError = {
    code: "authentication",
    message: "数据库拒绝了当前账号",
    technicalDetails: "server code 1045; credential value redacted",
    retryable: false,
  };
  sessionController.state.running = false;
  sessionController.state.error = error;
  const view = render(<QueryWorkspace {...WORKSPACE_PROPS} />);

  expect(screen.getByText(error.message)).toBeVisible();
  expect(screen.getByText("请检查用户名和凭据后重新连接。")).toBeVisible();
  const details = screen.getByText("诊断详情").closest("details");
  expect(details).not.toHaveAttribute("open");
  expect(screen.getByText(error.technicalDetails ?? "")).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("test-database-password");

  sessionController.state.error = { ...error, technicalDetails: null };
  view.rerender(<QueryWorkspace {...WORKSPACE_PROPS} />);
  expect(screen.queryByText("诊断详情")).not.toBeInTheDocument();

  sessionController.state.error = {
    code: "connection",
    message: "连接已断开",
    technicalDetails: null,
    retryable: true,
  };
  view.rerender(<QueryWorkspace {...WORKSPACE_PROPS} />);
  expect(screen.getByText("请检查网络和连接状态，然后重试。")).toBeVisible();
}

/** Verifies an empty canceled query has a terminal state without changing the initial empty copy. */
function assertCanceledEmptyQueryState(): void {
  sessionController.state.running = false;
  sessionController.state.incomplete = true;
  const view = render(<QueryWorkspace {...WORKSPACE_PROPS} />);

  expect(screen.getByText("查询已取消")).toBeVisible();
  expect(screen.queryByText("执行查询后，结果会显示在这里。")).not.toBeInTheDocument();

  sessionController.state.incomplete = false;
  view.rerender(<QueryWorkspace {...WORKSPACE_PROPS} />);
  expect(screen.getByText("执行查询后，结果会显示在这里。")).toBeVisible();
  expect(screen.queryByText("查询已取消")).not.toBeInTheDocument();
}

/** Registers loading and toolbar scope regression tests. */
function registerQueryWorkspaceTests(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionController.state.running = true;
    sessionController.state.cancelRequested = true;
    sessionController.state.incomplete = false;
    sessionController.state.columns = [];
    sessionController.state.rows = [];
    sessionController.state.affectedRows = null;
    sessionController.state.error = null;
    monacoState.sql = "select 1;\nselect 2;";
    monacoState.position = { lineNumber: 2, column: 4 };
  });
  afterEach(cleanup);
  it("keeps cancel visible without diagnostic loading copy", assertMinimalQueryLoading);
  it("executes only Monaco's selected SQL from the toolbar", assertToolbarSelectionExecution);
  it("executes only Monaco's cursor statement from the toolbar", assertToolbarCursorExecution);
  it("does not start a second query from the shortcut while running", assertRunningSessionIgnoresExecuteShortcut);
  it("creates a query through one guarded button and shortcut path", assertNewQueryControlsShareRunningGuard);
  it("shows actionable query errors with closed diagnostic details", assertLayeredQueryError);
  it("shows a terminal state for an empty canceled query", assertCanceledEmptyQueryState);
}

describe("QueryWorkspace", registerQueryWorkspaceTests);
