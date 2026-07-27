import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "../../bindings/AppError";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { resetAllShortcutBindings, updateShortcutBinding } from "../commands/shortcutRegistry";
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
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(async () => undefined),
}));
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

const PRODUCTION_REDIS_PROFILE: ConnectionProfile = {
  ...PROFILE,
  engine: "redis",
  environment: "production",
  port: 6379,
  database: "0",
  tlsMode: "disabled",
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
  theme: "light" as const,
  persistenceError: null,
  onRetryPersistence: vi.fn(async () => undefined),
  onRunningChange: vi.fn(),
  onSqlChange: vi.fn(),
};

/** Verifies Redis workspaces expose native command presets and engine-aware guidance. */
function assertRedisCommandWorkspace(): void {
  sessionController.state.running = false;
  sessionController.state.error = {
    code: "query",
    message: "Redis command failed",
    technicalDetails: "WRONGTYPE",
    retryable: false,
  };
  const onSqlChange = vi.fn();
  render(
    <QueryWorkspace
      {...WORKSPACE_PROPS}
      onSqlChange={onSqlChange}
      profile={{
        ...PROFILE,
        engine: "redis",
        port: 6379,
        database: "0",
        tlsMode: "disabled",
      }}
    />,
  );

  expect(screen.getByText("Redis")).toBeVisible();
  expect(screen.getByLabelText("Redis 常用命令")).toBeVisible();
  expect(screen.getByText("请检查 Redis 命令、参数和键的数据类型。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Hash" }));
  expect(onSqlChange).toHaveBeenCalledWith(TAB.id, "HGETALL key");
}

/** Verifies production Redis writes execute only after reviewing the exact command. */
function assertProductionRedisWriteRequiresConfirmation(): void {
  sessionController.state.running = false;
  monacoState.sql = "FLUSHALL";
  monacoState.selection = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 9,
  };
  render(<QueryWorkspace {...WORKSPACE_PROPS} profile={PRODUCTION_REDIS_PROFILE} />);

  fireEvent.click(screen.getByRole("button", { name: /执行/ }));

  expect(sessionController.run).not.toHaveBeenCalled();
  expect(screen.getByRole("alertdialog", { name: "确认执行 Redis 命令" }))
    .toHaveTextContent("FLUSHALL");
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  expect(sessionController.run).toHaveBeenCalledWith("FLUSHALL");
}

/** Verifies allowlisted production Redis reads retain one-click execution. */
function assertProductionRedisReadRunsDirectly(): void {
  sessionController.state.running = false;
  monacoState.sql = "GET cache:key";
  monacoState.selection = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 14,
  };
  render(<QueryWorkspace {...WORKSPACE_PROPS} profile={PRODUCTION_REDIS_PROFILE} />);

  fireEvent.click(screen.getByRole("button", { name: /执行/ }));

  expect(sessionController.run).toHaveBeenCalledWith("GET cache:key");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
}

/**
 * Verifies running feedback remains intentionally small after cancellation is requested.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders a query workspace with a mocked active session.
 */
function assertMinimalQueryLoading(): void {
  render(<QueryWorkspace {...WORKSPACE_PROPS} />);

  expect(screen.getByText("查询中…")).toBeVisible();
  const cancelButton = screen.getByRole("button", { name: /取消/ });
  expect(cancelButton).toBeVisible();
  expect(cancelButton).toHaveAttribute("title", "取消当前查询（Ctrl/Cmd + .）");
  expect(screen.getByText("Ctrl/Cmd + .")).toBeVisible();
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

  const executeButton = screen.getByRole("button", { name: /执行/ });
  expect(executeButton).toHaveAttribute(
    "title",
    "执行选中 SQL 或当前语句（Ctrl/Cmd + R）",
  );
  expect(screen.getByText("Ctrl/Cmd + R")).toBeVisible();
  fireEvent.click(executeButton);
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

/** Verifies the primary cancel shortcut consumes the event and cancels an active query. */
function assertRunningSessionCancelsViaShortcut(): void {
  expect(updateShortcutBinding("cancelQuery", "Alt+X")).toBe(true);
  sessionController.state.running = true;
  sessionController.state.cancelRequested = false;
  render(<QueryWorkspace {...WORKSPACE_PROPS} />);
  const shortcut = new KeyboardEvent("keydown", {
    key: "x",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(shortcut);

  expect(shortcut.defaultPrevented).toBe(true);
  expect(sessionController.cancel).toHaveBeenCalledTimes(1);
}

/** Verifies the cancel shortcut remains available to the platform when no query is active. */
function assertIdleCancelShortcutIsIgnored(): void {
  sessionController.state.running = false;
  render(<QueryWorkspace {...WORKSPACE_PROPS} />);
  const shortcut = new KeyboardEvent("keydown", {
    key: ".",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(shortcut);

  expect(shortcut.defaultPrevented).toBe(false);
  expect(sessionController.cancel).not.toHaveBeenCalled();
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
    resetAllShortcutBindings();
    sessionController.state.running = true;
    sessionController.state.cancelRequested = true;
    sessionController.state.incomplete = false;
    sessionController.state.columns = [];
    sessionController.state.rows = [];
    sessionController.state.affectedRows = null;
    sessionController.state.error = null;
    monacoState.sql = "select 1;\nselect 2;";
    monacoState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 9,
    };
    monacoState.position = { lineNumber: 2, column: 4 };
  });
  afterEach(() => {
    cleanup();
    resetAllShortcutBindings();
  });
  it("keeps cancel visible without diagnostic loading copy", assertMinimalQueryLoading);
  it("executes only Monaco's selected SQL from the toolbar", assertToolbarSelectionExecution);
  it("executes only Monaco's cursor statement from the toolbar", assertToolbarCursorExecution);
  it("does not start a second query from the shortcut while running", assertRunningSessionIgnoresExecuteShortcut);
  it("cancels a running query with its configured binding", assertRunningSessionCancelsViaShortcut);
  it("ignores the cancel shortcut while idle", assertIdleCancelShortcutIsIgnored);
  it("shows actionable query errors with closed diagnostic details", assertLayeredQueryError);
  it("shows a terminal state for an empty canceled query", assertCanceledEmptyQueryState);
  it("renders Redis native command controls and guidance", assertRedisCommandWorkspace);
  it("confirms production Redis writes before execution", assertProductionRedisWriteRequiresConfirmation);
  it("runs production Redis reads without a confirmation", assertProductionRedisReadRunsDirectly);
}

describe("QueryWorkspace", registerQueryWorkspaceTests);
