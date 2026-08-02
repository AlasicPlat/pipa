import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellValue } from "../bindings/CellValue";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import type { QueryColumn } from "../bindings/QueryColumn";
import {
  reloadShortcutBindings,
  resetAllShortcutBindings,
  updateShortcutBinding,
} from "../features/commands/shortcutRegistry";
import { executeQueryOnce } from "../features/query/executeQueryOnce";
import {
  deleteConnection,
  listWorkspaceWindowLabels,
  listConnections,
  loadWorkspace,
  reconnectConnection,
  renameConnection,
  saveWorkspace,
  setExecuteQueryAccelerator,
  transferWorkspaceTab,
} from "../lib/tauriClient";
import { App } from "./App";

const desktopRuntime = vi.hoisted(() => ({
  createWindow: vi.fn(),
  registerClose: vi.fn(),
  restoreWindow: vi.fn(),
  tauri: false,
  windowLabel: "main",
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  isTauri: () => desktopRuntime.tauri,
}));

vi.mock("../features/workspace/detachedWorkspace", () => ({
  MAIN_WORKSPACE_WINDOW_LABEL: "main",
  createDetachedWorkspaceWindow: desktopRuntime.createWindow,
  isScreenPointOutsideWindow: ({ x, y }: { x: number; y: number }) => (
    x < window.screenX
    || y < window.screenY
    || x > window.screenX + window.outerWidth
    || y > window.screenY + window.outerHeight
  ),
  readWorkspaceWindowContext: () => ({ descriptor: null, windowLabel: desktopRuntime.windowLabel }),
  registerDetachedWorkspaceCloseHandler: desktopRuntime.registerClose,
  restoreDetachedQueryWindow: desktopRuntime.restoreWindow,
}));

vi.mock("../features/binlog/BinlogWorkspace", () => ({
  BinlogWorkspace: () => <section aria-label="Binlog 分析工作区">Binlog integration fixture</section>,
}));

vi.mock("../lib/tauriClient", () => ({
  deleteConnection: vi.fn(),
  listWorkspaceWindowLabels: vi.fn(),
  listConnections: vi.fn(),
  loadWorkspace: vi.fn(),
  recordQueryHistory: vi.fn(),
  reconnectConnection: vi.fn(),
  renameConnection: vi.fn(),
  saveMySqlConnection: vi.fn(),
  saveRedisConnection: vi.fn(),
  saveWorkspace: vi.fn(),
  setExecuteQueryAccelerator: vi.fn(),
  testMySqlConnection: vi.fn(),
  testRedisConnection: vi.fn(),
  transferWorkspaceTab: vi.fn(),
}));

const clipboardState = vi.hoisted(() => ({ writeText: vi.fn() }));
const querySessionFixture = vi.hoisted(() => ({
  cancel: vi.fn(),
  columns: [] as QueryColumn[],
  rows: [] as CellValue[][],
  run: vi.fn(),
  running: false,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: clipboardState.writeText,
}));

vi.mock("../features/query/useQuerySession", () => ({
  useQuerySession: () => ({
    state: {
      queryId: null,
      connectionId: null,
      sql: "",
      columns: querySessionFixture.columns,
      rows: querySessionFixture.rows,
      running: querySessionFixture.running,
      cancelRequested: false,
      incomplete: false,
      affectedRows: null,
      error: null,
    },
    run: querySessionFixture.run,
    cancel: querySessionFixture.cancel,
  }),
}));

vi.mock("../features/query/executeQueryOnce", () => ({
  executeQueryOnce: vi.fn().mockResolvedValue({
    columns: [
      { name: "cursor", databaseType: "REDIS CURSOR", nullable: null },
      { name: "key", databaseType: "REDIS VALUE", nullable: null },
    ],
    rows: [[{ kind: "integer", value: "0" }, { kind: "null" }]],
    affectedRows: 0,
  }),
}));

vi.mock("@monaco-editor/react", () => ({
  default: () => <div aria-label="SQL 编辑器" />,
}));

const DEVELOPMENT_PROFILE: ConnectionProfile = {
  id: "connection-development",
  name: "开发主库",
  engine: "my_sql",
  environment: "development",
  host: "127.0.0.1",
  port: 3306,
  username: "developer",
  database: "pipa_dev",
  tlsMode: "preferred",
};

const PRODUCTION_PROFILE: ConnectionProfile = {
  ...DEVELOPMENT_PROFILE,
  id: "connection-production",
  name: "生产主库",
  environment: "production",
  host: "mysql.production.internal",
  database: "pipa",
};

const MONGODB_PROFILE: ConnectionProfile = {
  ...DEVELOPMENT_PROFILE,
  id: "connection-mongodb",
  name: "文档开发库",
  engine: "mongo_db",
  port: 27017,
  database: "documents",
};

const REDIS_PROFILE: ConnectionProfile = {
  ...DEVELOPMENT_PROFILE,
  id: "connection-redis",
  name: "本地缓存",
  engine: "redis",
  port: 6379,
  database: "0",
  tlsMode: "disabled",
};

/**
 * Verifies that the Pipa root exposes the required workspace landmarks.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the App component into the jsdom test document.
 */
function assertPipaWorkspaceLandmarks(): void {
  render(<App />);
  expect(screen.getByRole("application", { name: "Pipa 数据库工作台" })).toBeVisible();
  expect(screen.getByRole("navigation", { name: "数据库连接" })).toBeVisible();
  expect(screen.getByRole("main", { name: "查询工作区" })).toBeVisible();
}

/** Verifies navigator selection never silently rebinds the restored query-tab context. */
async function assertRestoredTabConnectionIsImmutable(): Promise<void> {
  render(<App />);
  const productionRow = await screen.findByRole("button", { name: /生产主库/ });
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();

  fireEvent.click(productionRow);
  await waitFor(() => expect(productionRow).toHaveAttribute("aria-selected", "true"));

  expect(screen.getByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "生产主库 查询工作区" })).not.toBeInTheDocument();
}

/** Verifies a selected MySQL connection creates a new bound tab without rebinding old tabs. */
async function assertNewQueryUsesSelectedConnectionWithoutRebinding(): Promise<void> {
  render(<App />);
  const productionRow = await screen.findByRole("button", { name: /生产主库/ });
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();

  fireEvent.click(productionRow);
  await waitFor(() => expect(productionRow).toHaveAttribute("aria-selected", "true"));
  fireEvent.click(
    screen.getByRole("button", {
      name: "在当前已选 MySQL 连接 生产主库 中新建查询",
    }),
  );

  expect(await screen.findByRole("region", { name: "生产主库 查询工作区" })).toBeVisible();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(screen.getByRole("tab", { name: "生产主库 · 查询 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  fireEvent.click(screen.getByRole("tab", { name: "恢复的查询" }));
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "生产主库 查询工作区" })).not.toBeInTheDocument();
}

/** Verifies a non-MySQL navigator selection cannot create a misleading SQL query tab. */
async function assertNonMySqlSelectionCannotCreateQuery(): Promise<void> {
  render(<App />);
  const mongodbRow = await screen.findByRole("button", { name: /文档开发库/ });
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();

  fireEvent.click(mongodbRow);
  await waitFor(() => expect(mongodbRow).toHaveAttribute("aria-selected", "true"));
  expect(
    screen.getByRole("button", { name: "请选择 MySQL 连接后新建查询" }),
  ).toBeDisabled();
  fireEvent.keyDown(document, { key: "t", ctrlKey: true });

  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
}

/** Verifies unsupported engines do not inherit actionable MySQL guidance on the empty screen. */
async function assertUnsupportedSelectionHidesMySqlGuidance(): Promise<void> {
  vi.mocked(loadWorkspace).mockResolvedValueOnce([]);
  render(<App />);
  const mongodbRow = await screen.findByRole("button", { name: /文档开发库/ });

  fireEvent.click(mongodbRow);

  expect(await screen.findByRole("heading", { name: "文档开发库" })).toBeVisible();
  expect(screen.getByText(/当前请改用 MySQL 或 Redis 连接继续/)).toBeVisible();
  expect(screen.queryByText("编写并执行 SQL")).not.toBeInTheDocument();
  expect(screen.queryByText("展开后加载数据表，点击即可进入表工作区。")).not.toBeInTheDocument();
}

/** Verifies restore failure is actionable and retry restores the original immutable tab. */
async function assertRecoveryFailureRequiresSuccessfulRetry(): Promise<void> {
  vi.mocked(loadWorkspace)
    .mockRejectedValueOnce(new Error("locked"))
    .mockResolvedValueOnce([
      {
        id: "restored-tab",
        connectionId: DEVELOPMENT_PROFILE.id,
        title: "恢复的查询",
        sqlText: "SELECT * FROM inventory;",
        position: 0,
      },
    ]);
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "无法恢复上次工作区" }),
  ).toBeVisible();
  expect(saveWorkspace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重新恢复" }));

  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  const productionRow = screen.getByRole("button", { name: /生产主库/ });
  fireEvent.click(productionRow);
  await waitFor(() => expect(productionRow).toHaveAttribute("aria-selected", "true"));
  expect(screen.getByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "生产主库 查询工作区" })).not.toBeInTheDocument();
  expect(saveWorkspace).not.toHaveBeenCalled();
}

/** Verifies the global add action routes through database type selection. */
async function assertGlobalAddSupportsRedis(): Promise<void> {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "添加连接" }));
  expect(screen.getByRole("heading", { name: "选择数据库类型" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /键浏览、类型查看与原生命令/ }));
  expect(screen.getByRole("heading", { name: "添加 Redis 连接" })).toBeVisible();
  expect(screen.getByLabelText("端口")).toHaveValue(6379);
  expect(screen.getByLabelText("默认数据库")).toHaveValue(null);
}

/** Verifies a saved Redis connection opens the key browser and retains the native workbench. */
async function assertRedisConnectionCreatesCommandWorkspace(): Promise<void> {
  render(<App />);
  const redisRow = await screen.findByRole("button", { name: /本地缓存/ });
  fireEvent.click(redisRow);
  fireEvent.click(screen.getByRole("button", {
    name: "在当前已选 Redis 连接 本地缓存 中新建工作区",
  }));

  expect(await screen.findByRole("tab", { name: "本地缓存 · Redis 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("region", { name: "Redis 工作区" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "键浏览器" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("searchbox", { name: "搜索 Redis 键" })).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "命令工作台" }));
  expect(screen.getByRole("region", { name: "本地缓存 查询工作区" })).toBeVisible();
  expect(screen.getByLabelText("Redis 常用命令")).toBeVisible();
}

/** Verifies database expansion switches both the sidebar scan and the Redis workspace context. */
async function assertRedisDatabaseSelectionScopesWorkspace(): Promise<void> {
  vi.mocked(executeQueryOnce).mockImplementation(async (_connectionId, command) => (
    command === "INFO keyspace"
      ? {
          columns: [{ name: "value", databaseType: "REDIS VALUE", nullable: null }],
          rows: [[{
            kind: "text",
            value: "# Keyspace\r\ndb0:keys=1,expires=0,avg_ttl=0\r\ndb2:keys=3,expires=0,avg_ttl=0\r\n",
          }]],
          affectedRows: 0,
        }
      : {
          columns: [
            { name: "cursor", databaseType: "REDIS CURSOR", nullable: null },
            { name: "key", databaseType: "REDIS VALUE", nullable: null },
          ],
          rows: [[{ kind: "integer", value: "0" }, { kind: "text", value: "cache:user:1" }]],
          affectedRows: 0,
        }
  ));
  render(<App />);
  const redisRow = await screen.findByRole("button", { name: /本地缓存/ });

  fireEvent.doubleClick(redisRow);
  const database = await screen.findByRole("treeitem", { name: /DB 2/u });
  fireEvent.doubleClick(database);
  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    REDIS_PROFILE.id,
    'SCAN 0 MATCH "*" COUNT 500',
    "2",
  ));
  expect(screen.getAllByRole("tab")).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", {
    name: "在当前已选 Redis 连接 本地缓存 中新建工作区",
  }));
  expect(await screen.findByRole("region", { name: "Redis 工作区" })).toBeVisible();
  expect(screen.getByRole("spinbutton", { name: "切换 Redis 数据库" })).toHaveValue(2);
  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    REDIS_PROFILE.id,
    'SCAN 0 MATCH "*" COUNT 200',
    "2",
  ));

  const databaseInput = screen.getByRole("spinbutton", { name: "切换 Redis 数据库" });
  fireEvent.change(databaseInput, { target: { value: "3" } });
  fireEvent.blur(databaseInput);
  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    REDIS_PROFILE.id,
    'SCAN 0 MATCH "*" COUNT 200',
    "3",
  ));
  expect(redisRow).toHaveTextContent("DB 3");
}

/** Verifies the context-menu delete flow confirms before removing backend and UI state. */
async function assertConfirmedConnectionDeletion(): Promise<void> {
  render(<App />);
  const productionRow = await screen.findByRole("button", { name: /生产主库/ });

  fireEvent.contextMenu(productionRow, { clientX: 120, clientY: 140 });
  fireEvent.click(screen.getByRole("menuitem", { name: "删除连接…" }));
  expect(screen.getByRole("alertdialog", { name: "删除“生产主库”？" })).toBeVisible();
  expect(deleteConnection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "永久删除生产连接" }));

  await waitFor(() => expect(deleteConnection).toHaveBeenCalledWith(PRODUCTION_PROFILE.id));
  await waitFor(() => expect(screen.queryByRole("button", { name: /生产主库/ })).not.toBeInTheDocument());
  expect(screen.getByRole("status")).toHaveTextContent("已删除连接“生产主库”及其本地数据");
}

/** Verifies shared workspace shortcuts cycle and close the active query tab. */
async function assertWorkspaceTabShortcuts(): Promise<void> {
  render(<App />);
  const productionRow = await screen.findByRole("button", { name: /生产主库/ });
  fireEvent.click(productionRow);
  fireEvent.click(screen.getByRole("button", {
    name: "在当前已选 MySQL 连接 生产主库 中新建查询",
  }));

  expect(screen.getByRole("tab", { name: "生产主库 · 查询 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.keyDown(document, { key: "Tab", ctrlKey: true });
  expect(screen.getByRole("tab", { name: "恢复的查询" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.keyDown(document, { key: "Tab", ctrlKey: true, shiftKey: true });
  expect(screen.getByRole("tab", { name: "生产主库 · 查询 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.keyDown(document, { key: "w", metaKey: true });

  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("tab", { name: "恢复的查询" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

/** 验证切换到其他工作区后，已完成的查询结果及其视图状态仍会保留。 */
async function assertQueryResultsSurviveWorkspaceSwitch(): Promise<void> {
  querySessionFixture.columns = [
    { name: "item", databaseType: "VARCHAR", nullable: false },
  ];
  querySessionFixture.rows = [[{ kind: "text", value: "inventory" }]];
  render(<App />);
  const restoredWorkspace = await screen.findByRole("region", {
    name: "开发主库 查询工作区",
  });
  const resultSearch = screen.getByRole("searchbox", { name: "搜索结果" });
  fireEvent.change(resultSearch, { target: { value: "inventory" } });

  fireEvent.click(screen.getByRole("button", { name: /生产主库/ }));
  fireEvent.click(screen.getByRole("button", {
    name: "在当前已选 MySQL 连接 生产主库 中新建查询",
  }));
  expect(await screen.findByRole("region", { name: "生产主库 查询工作区" })).toBeVisible();
  expect(
    screen.getByRole("region", { name: "开发主库 查询工作区", hidden: true }),
  ).toBe(restoredWorkspace);

  fireEvent.click(screen.getByRole("tab", { name: "恢复的查询" }));
  await waitFor(() => {
    expect(screen.getByRole("searchbox", { name: "搜索结果" })).toHaveValue("inventory");
  });
}

/** Verifies an edited global shortcut replaces the default workspace action immediately. */
async function assertConfiguredGlobalShortcut(): Promise<void> {
  expect(updateShortcutBinding("newQuery", "Alt+N")).toBe(true);
  render(<App />);
  const productionRow = await screen.findByRole("button", { name: /生产主库/ });
  fireEvent.click(productionRow);
  fireEvent.keyDown(document, { key: "n", altKey: true });

  expect(await screen.findByRole("tab", { name: "生产主库 · 查询 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.keyDown(document, { key: "t", metaKey: true });
  expect(screen.getAllByRole("tab")).toHaveLength(2);
}

/** Verifies the visible appearance control applies and persists explicit light/dark choices. */
async function assertThemeSwitching(): Promise<void> {
  render(<App />);
  await screen.findByRole("button", { name: /生产主库/ });
  fireEvent.click(screen.getByRole("button", { name: "界面外观：跟随系统" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /暗色/ }));

  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(window.localStorage.getItem("pipa.theme-preference")).toBe("dark");
  expect(screen.getByRole("button", { name: "界面外观：暗色" })).toBeVisible();
}

/** Verifies the persistent topbar exposes shortcut editing without command-palette knowledge. */
async function assertShortcutSettingsEntry(): Promise<void> {
  render(<App />);
  await screen.findByRole("button", { name: /生产主库/ });
  fireEvent.click(screen.getByRole("button", { name: "打开快捷键设置" }));
  expect(screen.getByRole("dialog", { name: "快捷键设置" })).toBeVisible();
  expect(screen.getByRole("button", { name: "修改新建 SQL" })).toBeVisible();
}

/** Verifies the global palette discovers recent objects and searchable commands from the keyboard. */
async function assertGlobalCommandPalette(): Promise<void> {
  render(<App />);
  await screen.findByRole("button", { name: /生产主库/ });

  fireEvent.keyDown(document, { key: "p", metaKey: true, shiftKey: true });
  const palette = screen.getByRole("dialog", { name: "快速打开" });
  expect(palette).toBeVisible();
  const search = screen.getByRole("combobox", { name: /搜索连接/ });
  fireEvent.change(screen.getByRole("combobox", { name: "按连接过滤" }), {
    target: { value: PRODUCTION_PROFILE.id },
  });
  fireEvent.change(search, { target: { value: "mysql.production.internal" } });
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => expect(document.querySelector(
    `[data-connection-id="${PRODUCTION_PROFILE.id}"]`,
  )).toHaveAttribute("aria-selected", "true"));

  fireEvent.click(screen.getByRole("button", { name: /命令/ }));
  fireEvent.change(screen.getByRole("combobox", { name: /搜索连接/ }), { target: { value: "快捷键帮助" } });
  fireEvent.keyDown(screen.getByRole("combobox", { name: /搜索连接/ }), { key: "Enter" });
  expect(screen.getByRole("dialog", { name: "快捷键帮助" })).toBeVisible();
}

/** Verifies Binlog discovery reactivates one unbound utility tab and preserves its prior query. */
async function assertBinlogWorkspaceSingletonLifecycle(): Promise<void> {
  render(<App />);
  const productionRow = await screen.findByRole("button", { name: /生产主库/ });
  const visibleEntry = screen.getByRole("button", { name: "打开 Binlog 分析" });
  expect(visibleEntry).toBeVisible();

  fireEvent.click(visibleEntry);
  expect(screen.getByRole("tab", { name: "Binlog 分析" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const binlogRegion = screen.getByRole("region", { name: "Binlog 分析工作区" });
  expect(binlogRegion).toBeVisible();
  expect(screen.getAllByRole("tab")).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: "添加连接" }));
  expect(screen.getByRole("heading", { name: "选择数据库类型" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Binlog 分析工作区" })).toBe(binlogRegion);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("heading", { name: "选择数据库类型" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Binlog 分析工作区" })).toBe(binlogRegion);

  fireEvent.click(productionRow);
  await waitFor(() => expect(productionRow).toHaveAttribute("aria-selected", "true"));
  expect(screen.getByRole("region", { name: "Binlog 分析工作区" })).toBeVisible();
  expect(screen.getAllByRole("tab")).toHaveLength(2);

  fireEvent.click(screen.getByRole("tab", { name: "恢复的查询" }));
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Binlog 分析工作区", hidden: true }),
  ).not.toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /命令/ }));
  const paletteSearch = screen.getByRole("combobox", { name: /搜索连接/ });
  fireEvent.change(paletteSearch, { target: { value: "打开 Binlog 分析" } });
  fireEvent.click(screen.getByRole("option", { name: /打开 Binlog 分析/ }));

  expect(screen.getByRole("tab", { name: "Binlog 分析" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getAllByRole("tab")).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: /命令/ }));
  fireEvent.change(screen.getByRole("combobox", { name: /搜索连接/ }), {
    target: { value: "打开 Binlog 分析" },
  });
  fireEvent.click(screen.getByRole("option", { name: /打开 Binlog 分析/ }));
  expect(screen.getAllByRole("tab")).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: "关闭 Binlog 分析" }));
  expect(screen.queryByRole("tab", { name: "Binlog 分析" })).not.toBeInTheDocument();
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "恢复的查询" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

/** Verifies the global Binlog workspace can open and close without any saved connection. */
async function assertBinlogWorkspaceNeedsNoConnection(): Promise<void> {
  vi.mocked(listConnections).mockResolvedValueOnce([]);
  vi.mocked(loadWorkspace).mockResolvedValueOnce([]);
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "选择或创建一个数据库连接" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "打开 Binlog 分析" }));

  expect(screen.getByRole("tab", { name: "Binlog 分析" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("region", { name: "Binlog 分析工作区" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "关闭 Binlog 分析" }));

  expect(
    await screen.findByRole("heading", { name: "选择或创建一个数据库连接" }),
  ).toBeVisible();
}

/** Verifies a running query stays mounted and protected while Binlog remains switchable. */
async function assertBusyQueryCanSwitchToBinlog(): Promise<void> {
  querySessionFixture.running = true;
  const { rerender } = render(<App />);
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  await waitFor(() => expect(
    screen.getByRole("button", { name: "关闭 恢复的查询" }),
  ).toBeDisabled());

  fireEvent.click(screen.getByRole("button", { name: "打开 Binlog 分析" }));
  expect(screen.getByRole("region", { name: "Binlog 分析工作区" })).toBeVisible();
  expect(
    screen.getByRole("region", { name: "开发主库 查询工作区", hidden: true }),
  ).not.toBeVisible();

  const busyQueryTab = screen.getByRole("tab", { name: "恢复的查询" });
  expect(busyQueryTab).not.toBeDisabled();
  fireEvent.click(busyQueryTab);
  expect(screen.getByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Binlog 分析" }));
  expect(screen.getByRole("region", { name: "Binlog 分析工作区" })).toBeVisible();

  querySessionFixture.running = false;
  rerender(<App />);
  await waitFor(() => expect(
    screen.getByRole("button", { name: "关闭 恢复的查询" }),
  ).not.toBeDisabled());
  expect(
    screen.getByRole("region", { name: "开发主库 查询工作区", hidden: true }),
  ).not.toBeVisible();

  fireEvent.keyDown(document, { key: "w", metaKey: true });
  expect(screen.queryByRole("tab", { name: "Binlog 分析" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
}

/** Verifies the connection sidebar toggles, persists, and stays mounted while collapsed. */
async function assertSidebarCollapseToggleAndPersistence(): Promise<void> {
  const { unmount } = render(<App />);
  await screen.findByRole("button", { name: /生产主库/ });
  const shell = screen.getByRole("application", { name: "Pipa 数据库工作台" });
  const toggle = screen.getByRole("button", { name: "收起连接侧边栏" });

  expect(shell).not.toHaveClass("app-shell--sidebar-collapsed");
  fireEvent.click(toggle);
  expect(shell).toHaveClass("app-shell--sidebar-collapsed");
  expect(window.localStorage.getItem("pipa.sidebar-collapsed.v1")).toBe("1");
  expect(document.getElementById("connection-panel")).toBeTruthy();
  expect(document.querySelector(`[data-connection-id="${PRODUCTION_PROFILE.id}"]`)).toBeTruthy();

  fireEvent.keyDown(document, { key: "b", metaKey: true });
  expect(shell).not.toHaveClass("app-shell--sidebar-collapsed");
  expect(window.localStorage.getItem("pipa.sidebar-collapsed.v1")).toBe("0");

  fireEvent.keyDown(document, { key: "b", metaKey: true });
  expect(shell).toHaveClass("app-shell--sidebar-collapsed");
  unmount();

  render(<App />);
  expect(screen.getByRole("application", { name: "Pipa 数据库工作台" })).toHaveClass(
    "app-shell--sidebar-collapsed",
  );
  expect(screen.getByRole("button", { name: "展开连接侧边栏" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
}

/** Verifies the collapsed topbar context chip expands and selects the active connection. */
async function assertCollapsedContextBarRevealsConnection(): Promise<void> {
  window.localStorage.setItem("pipa.sidebar-collapsed.v1", "1");
  render(<App />);
  const shell = await screen.findByRole("application", { name: "Pipa 数据库工作台" });
  expect(shell).toHaveClass("app-shell--sidebar-collapsed");

  const contextChip = await screen.findByRole("button", {
    name: "当前连接 开发主库 · pipa_dev",
  });
  fireEvent.click(contextChip);

  await waitFor(() => expect(shell).not.toHaveClass("app-shell--sidebar-collapsed"));
  await waitFor(() => expect(document.querySelector(
    `[data-connection-id="${DEVELOPMENT_PROFILE.id}"]`,
  )).toHaveAttribute("aria-selected", "true"));
  await waitFor(() => expect(document.activeElement).toHaveAttribute(
    "data-connection-id",
    DEVELOPMENT_PROFILE.id,
  ));
}

/** Verifies opening a connection from the palette expands a collapsed sidebar. */
async function assertPaletteNavigationExpandsSidebar(): Promise<void> {
  window.localStorage.setItem("pipa.sidebar-collapsed.v1", "1");
  render(<App />);
  const shell = await screen.findByRole("application", { name: "Pipa 数据库工作台" });
  expect(shell).toHaveClass("app-shell--sidebar-collapsed");

  fireEvent.keyDown(document, { key: "p", metaKey: true, shiftKey: true });
  const search = screen.getByRole("combobox", { name: /搜索连接/ });
  fireEvent.change(search, { target: { value: "生产主库" } });
  fireEvent.keyDown(search, { key: "Enter" });

  await waitFor(() => expect(shell).not.toHaveClass("app-shell--sidebar-collapsed"));
  await waitFor(() => expect(document.querySelector(
    `[data-connection-id="${PRODUCTION_PROFILE.id}"]`,
  )).toHaveAttribute("aria-selected", "true"));
  expect(window.localStorage.getItem("pipa.sidebar-collapsed.v1")).toBe("0");
}

/** Verifies rename, safe config copy, and backend-owned reconnect stay in the connection menu. */
async function assertSecondaryConnectionActions(): Promise<void> {
  clipboardState.writeText.mockResolvedValue(undefined);
  vi.mocked(renameConnection).mockResolvedValue({ ...PRODUCTION_PROFILE, name: "线上主库" });
  vi.mocked(reconnectConnection).mockResolvedValue(undefined);
  render(<App />);
  let connectionRow = await screen.findByRole("button", { name: /生产主库/ });

  fireEvent.contextMenu(connectionRow, { clientX: 120, clientY: 140 });
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名…" }));
  const renameInput = screen.getByRole("textbox", { name: "连接名称" });
  fireEvent.change(renameInput, { target: { value: "线上主库" } });
  fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
  await waitFor(() => expect(renameConnection).toHaveBeenCalledWith(PRODUCTION_PROFILE.id, "线上主库"));
  await waitFor(() => expect(document.querySelector(
    `[data-connection-id="${PRODUCTION_PROFILE.id}"]`,
  )).toHaveTextContent("线上主库"));
  connectionRow = document.querySelector<HTMLButtonElement>(
    `[data-connection-id="${PRODUCTION_PROFILE.id}"]`,
  )!;

  fireEvent.contextMenu(connectionRow, { clientX: 120, clientY: 140 });
  fireEvent.click(screen.getByRole("menuitem", { name: "复制连接配置" }));
  await waitFor(() => expect(clipboardState.writeText).toHaveBeenCalledTimes(1));
  expect(clipboardState.writeText.mock.calls[0]?.[0]).toContain("mysql.production.internal");
  expect(clipboardState.writeText.mock.calls[0]?.[0]).not.toContain("password");

  fireEvent.contextMenu(connectionRow, { clientX: 120, clientY: 140 });
  fireEvent.click(screen.getByRole("menuitem", { name: "重新连接" }));
  await waitFor(() => expect(reconnectConnection).toHaveBeenCalledWith(PRODUCTION_PROFILE.id));
}

/** Verifies an idle query dragged outside is transferred before its new native window opens. */
async function assertQueryWorkspaceDetachesIntoNativeWindow(): Promise<void> {
  desktopRuntime.tauri = true;
  render(<App />);
  const queryTab = await screen.findByRole("tab", { name: "恢复的查询" });
  const outsideX = window.screenX + window.outerWidth + 40;
  const dragEnd = createEvent.dragEnd(queryTab);
  Object.defineProperties(dragEnd, {
    screenX: { value: outsideX },
    screenY: { value: 240 },
  });

  fireEvent(queryTab, dragEnd);

  await waitFor(() => expect(transferWorkspaceTab).toHaveBeenCalledTimes(1));
  const targetWindowLabel = vi.mocked(transferWorkspaceTab).mock.calls[0][2];
  expect(transferWorkspaceTab).toHaveBeenCalledWith(
    expect.objectContaining({ id: "restored-tab", sqlText: "SELECT * FROM inventory;" }),
    "main",
    targetWindowLabel,
  );
  expect(targetWindowLabel).toMatch(/^workspace-/u);
  await waitFor(() => expect(desktopRuntime.createWindow).toHaveBeenCalledWith(
    { kind: "query", id: "restored-tab", title: "恢复的查询" },
    { x: outsideX, y: 240 },
    targetWindowLabel,
  ));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "恢复的查询" })).not.toBeInTheDocument());
}

/** Verifies a native-window creation failure transfers the query back and leaves its tab visible. */
async function assertFailedQueryDetachRollsBack(): Promise<void> {
  desktopRuntime.tauri = true;
  desktopRuntime.createWindow.mockRejectedValueOnce(new Error("window creation denied"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(<App />);
  const queryTab = await screen.findByRole("tab", { name: "恢复的查询" });
  const dragEnd = createEvent.dragEnd(queryTab);
  Object.defineProperties(dragEnd, {
    screenX: { value: window.screenX + window.outerWidth + 40 },
    screenY: { value: 260 },
  });

  fireEvent(queryTab, dragEnd);

  await waitFor(() => expect(transferWorkspaceTab).toHaveBeenCalledTimes(2));
  const targetWindowLabel = vi.mocked(transferWorkspaceTab).mock.calls[0][2];
  expect(vi.mocked(transferWorkspaceTab).mock.calls[1]).toEqual([
    expect.objectContaining({ id: "restored-tab" }),
    targetWindowLabel,
    "main",
  ]);
  expect(screen.getByRole("tab", { name: "恢复的查询" })).toBeVisible();
  expect(await screen.findByRole("alert")).toHaveTextContent("window creation denied");
}

/** Verifies closing one detached native window removes the snapshot that drives restart restoration. */
async function assertDetachedWindowCloseClearsRestoreSnapshot(): Promise<void> {
  desktopRuntime.tauri = true;
  desktopRuntime.windowLabel = "workspace-query-1";
  render(<App />);

  await waitFor(() => expect(desktopRuntime.registerClose).toHaveBeenCalledTimes(1));
  const discardWorkspace = desktopRuntime.registerClose.mock.calls[0]?.[0] as () => Promise<void>;
  await discardWorkspace();

  expect(saveWorkspace).toHaveBeenCalledWith("workspace-query-1", []);
}

/**
 * Registers the App smoke tests with Vitest.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: registers one test case in the active Vitest suite.
 */
function registerAppTests(): void {
  beforeEach(() => {
    window.localStorage.clear();
    reloadShortcutBindings();
    vi.clearAllMocks();
    desktopRuntime.tauri = false;
    desktopRuntime.windowLabel = "main";
    desktopRuntime.createWindow.mockResolvedValue("workspace-test");
    desktopRuntime.registerClose.mockResolvedValue(() => undefined);
    desktopRuntime.restoreWindow.mockResolvedValue(undefined);
    querySessionFixture.columns = [];
    querySessionFixture.rows = [];
    querySessionFixture.running = false;
    vi.mocked(listConnections).mockResolvedValue([
      DEVELOPMENT_PROFILE,
      PRODUCTION_PROFILE,
      MONGODB_PROFILE,
      REDIS_PROFILE,
    ]);
    vi.mocked(loadWorkspace).mockResolvedValue([
      {
        id: "restored-tab",
        connectionId: DEVELOPMENT_PROFILE.id,
        title: "恢复的查询",
        sqlText: "SELECT * FROM inventory;",
        position: 0,
      },
    ]);
    vi.mocked(executeQueryOnce).mockResolvedValue({
      columns: [
        { name: "cursor", databaseType: "REDIS CURSOR", nullable: null },
        { name: "key", databaseType: "REDIS VALUE", nullable: null },
      ],
      rows: [[{ kind: "integer", value: "0" }, { kind: "null" }]],
      affectedRows: 0,
    });
    vi.mocked(deleteConnection).mockResolvedValue(undefined);
    vi.mocked(listWorkspaceWindowLabels).mockResolvedValue([]);
    vi.mocked(reconnectConnection).mockResolvedValue(undefined);
    vi.mocked(renameConnection).mockImplementation(async (connectionId, name) => ({
      ...(connectionId === PRODUCTION_PROFILE.id ? PRODUCTION_PROFILE : DEVELOPMENT_PROFILE),
      name: name.trim(),
    }));
    vi.mocked(setExecuteQueryAccelerator).mockResolvedValue(undefined);
    vi.mocked(transferWorkspaceTab).mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    resetAllShortcutBindings();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("color-scheme");
  });
  it("renders the Pipa workspace landmarks", assertPipaWorkspaceLandmarks);
  it("keeps a restored tab bound while another sidebar connection is selected", assertRestoredTabConnectionIsImmutable);
  it("creates a selected-connection tab without rebinding restored tabs", assertNewQueryUsesSelectedConnectionWithoutRebinding);
  it("does not create a SQL tab for a non-MySQL selection", assertNonMySqlSelectionCannotCreateQuery);
  it("hides MySQL guidance for unsupported connection engines", assertUnsupportedSelectionHidesMySqlGuidance);
  it("blocks workspace replacement until an explicit recovery retry succeeds", assertRecoveryFailureRequiresSuccessfulRetry);
  it("adds Redis through the global connection type picker", assertGlobalAddSupportsRedis);
  it("creates a native command workspace for Redis", assertRedisConnectionCreatesCommandWorkspace);
  it("switches Redis workspaces to the database opened in the navigator", assertRedisDatabaseSelectionScopesWorkspace);
  it("deletes a connection only after context-menu confirmation", assertConfirmedConnectionDeletion);
  it("cycles and closes shared workspace tabs with conventional shortcuts", assertWorkspaceTabShortcuts);
  it("keeps query results mounted across workspace switches", assertQueryResultsSurviveWorkspaceSwitch);
  it("uses a configured workspace shortcut and releases its previous default", assertConfiguredGlobalShortcut);
  it("switches and persists the selected interface appearance", assertThemeSwitching);
  it("opens shortcut settings from the persistent topbar entry", assertShortcutSettingsEntry);
  it("opens and searches the global command palette", assertGlobalCommandPalette);
  it("discovers and reuses one connection-independent Binlog workspace", assertBinlogWorkspaceSingletonLifecycle);
  it("opens the Binlog workspace without a saved connection", assertBinlogWorkspaceNeedsNoConnection);
  it("switches to Binlog without unmounting a busy query", assertBusyQueryCanSwitchToBinlog);
  it("collapses the connection sidebar and restores the preference", assertSidebarCollapseToggleAndPersistence);
  it("reveals the active connection from the collapsed context chip", assertCollapsedContextBarRevealsConnection);
  it("expands a collapsed sidebar when the palette opens a connection", assertPaletteNavigationExpandsSidebar);
  it("renames, copies, and reconnects from the connection context menu", assertSecondaryConnectionActions);
  it("moves an idle query into a new native window when dragged outside", assertQueryWorkspaceDetachesIntoNativeWindow);
  it("rolls a query back when native window creation fails", assertFailedQueryDetachRollsBack);
  it("removes a detached window from restart recovery when it closes", assertDetachedWindowCloseClearsRestoreSnapshot);
}

describe("App", registerAppTests);
