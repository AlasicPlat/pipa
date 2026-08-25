import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { downloadTextFile } from "../features/query/resultExport";
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
  mcpGetSnapshot: vi.fn(),
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
  updateConnectionProfile: vi.fn(),
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

vi.mock("../features/query/resultExport", async (importOriginal) => ({
  ...await importOriginal<typeof import("../features/query/resultExport")>(),
  downloadTextFile: vi.fn().mockResolvedValue("saved"),
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
 * Waits for the connection picker trigger, which reports the workspace's current connection.
 * @returns The picker trigger button once profiles have loaded.
 * Side effects: none beyond awaiting the render.
 */
async function findConnectionPicker(): Promise<HTMLElement> {
  return screen.findByRole("button", { name: /当前连接|选择连接/u });
}

/**
 * Switches the workspace to one saved connection through the picker.
 * @param name - Connection name as shown in the picker list.
 * @returns A promise settled after the selection is applied.
 * Side effects: opens the picker and clicks one option.
 */
async function selectConnection(name: string | RegExp): Promise<void> {
  fireEvent.click(await findConnectionPicker());
  const list = await screen.findByRole("listbox", { name: "已保存的连接" });
  fireEvent.click(within(list).getByRole("option", { name }));
}

/**
 * Opens one connection's action menu from the picker list.
 * @param name - Connection name as shown in the picker list.
 * @returns A promise settled once the menu is on screen.
 * Side effects: opens the picker and dispatches a context-menu event.
 */
async function openConnectionActions(name: string | RegExp): Promise<void> {
  fireEvent.click(await findConnectionPicker());
  const list = await screen.findByRole("listbox", { name: "已保存的连接" });
  fireEvent.contextMenu(within(list).getByRole("option", { name }), {
    clientX: 120,
    clientY: 140,
  });
}

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
  await findConnectionPicker();
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();

  await selectConnection(/生产主库/u);

  expect(screen.getByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "生产主库 查询工作区" })).not.toBeInTheDocument();
}

/** Verifies a selected MySQL connection creates a new bound tab without rebinding old tabs. */
async function assertNewQueryUsesSelectedConnectionWithoutRebinding(): Promise<void> {
  render(<App />);
  await findConnectionPicker();
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();

  await selectConnection(/生产主库/u);
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
  await findConnectionPicker();
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();

  await selectConnection(/文档开发库/u);
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
  await selectConnection(/文档开发库/u);

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
  await selectConnection(/生产主库/u);
  expect(screen.getByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "生产主库 查询工作区" })).not.toBeInTheDocument();
  expect(saveWorkspace).not.toHaveBeenCalled();
}

/** Verifies the global add action routes through database type selection. */
async function assertGlobalAddSupportsRedis(): Promise<void> {
  render(<App />);
  fireEvent.click(await findConnectionPicker());
  fireEvent.click(screen.getByRole("button", { name: "添加连接…" }));
  expect(screen.getByRole("heading", { name: "选择数据库类型" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /键浏览、类型查看与原生命令/ }));
  expect(screen.getByRole("heading", { name: "添加 Redis 连接" })).toBeVisible();
  expect(screen.getByLabelText("端口")).toHaveValue(6379);
  expect(screen.getByLabelText("默认数据库")).toHaveValue(null);
}

/** Verifies a saved Redis connection opens the key browser and retains the native workbench. */
async function assertRedisConnectionCreatesCommandWorkspace(): Promise<void> {
  render(<App />);
  await selectConnection(/本地缓存/u);
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
  await selectConnection(/本地缓存/u);
  const database = await screen.findByRole("treeitem", { name: /DB 2/u });
  fireEvent.click(database);
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
  // The navigator follows the workspace's database, so its key list is rescanned against DB 3.
  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    REDIS_PROFILE.id,
    'SCAN 0 MATCH "*" COUNT 500',
    "3",
  ));
}

/** Verifies the context-menu delete flow confirms before removing backend and UI state. */
async function assertConfirmedConnectionDeletion(): Promise<void> {
  render(<App />);
  await openConnectionActions(/生产主库/u);
  fireEvent.click(screen.getByRole("menuitem", { name: "删除连接…" }));
  expect(screen.getByRole("alertdialog", { name: "删除“生产主库”？" })).toBeVisible();
  expect(deleteConnection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "永久删除生产连接" }));

  await waitFor(() => expect(deleteConnection).toHaveBeenCalledWith(PRODUCTION_PROFILE.id));
  await waitFor(() => expect(screen.queryByRole("button", { name: /生产主库/ })).not.toBeInTheDocument());
  expect(screen.getByRole("status")).toHaveTextContent("已删除连接“生产主库”及其本地数据");
}

/** Verifies TRUNCATE and DROP remain behind the required destructive confirmations. */
async function assertConfirmedTableDestructiveActions(): Promise<void> {
  querySessionFixture.rows = [[
    { kind: "text", value: "inventory" },
    { kind: "text", value: "BASE TABLE" },
  ]];
  render(<App />);

  await screen.findAllByText("开发主库");
  await selectConnection(/开发主库/u);
  let table = screen.getByRole("treeitem", { name: "inventory" });
  fireEvent.contextMenu(table, { clientX: 120, clientY: 160 });
  fireEvent.click(screen.getByRole("menuitem", { name: "清空表…" }));
  expect(screen.getByRole("alertdialog", {
    name: "清空“inventory”的全部数据？",
  })).toBeVisible();
  expect(executeQueryOnce).not.toHaveBeenCalledWith(
    DEVELOPMENT_PROFILE.id,
    "TRUNCATE TABLE `pipa_dev`.`inventory`;",
  );
  fireEvent.click(screen.getByRole("button", { name: "清空全部数据" }));
  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    DEVELOPMENT_PROFILE.id,
    "TRUNCATE TABLE `pipa_dev`.`inventory`;",
  ));
  expect(screen.getByRole("status")).toHaveTextContent("已清空表“inventory”的全部数据");

  await selectConnection(/生产主库/u);
  table = screen.getByRole("treeitem", { name: "inventory" });
  fireEvent.contextMenu(table, { clientX: 120, clientY: 160 });
  fireEvent.click(screen.getByRole("menuitem", { name: "删除表…" }));
  const dropButton = screen.getByRole("button", { name: "永久删除表" });
  expect(dropButton).toBeEnabled();
  expect(executeQueryOnce).not.toHaveBeenCalledWith(
    PRODUCTION_PROFILE.id,
    "DROP TABLE `pipa`.`inventory`;",
  );
  fireEvent.click(dropButton);
  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    PRODUCTION_PROFILE.id,
    "DROP TABLE `pipa`.`inventory`;",
  ));
  expect(screen.getByRole("status")).toHaveTextContent("已删除表“inventory”");
}

/** Verifies rename and duplicate shortcuts issue identifier-safe MySQL statements. */
async function assertTableNameShortcuts(): Promise<void> {
  querySessionFixture.rows = [[
    { kind: "text", value: "inventory" },
    { kind: "text", value: "BASE TABLE" },
  ]];
  render(<App />);
  await screen.findAllByText("开发主库");
  await selectConnection(/开发主库/u);
  let table = screen.getByRole("treeitem", { name: "inventory" });

  fireEvent.contextMenu(table);
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名表…" }));
  const renameInput = screen.getByRole("textbox", { name: "新表名" });
  fireEvent.change(renameInput, { target: { value: "inventory_archive" } });
  fireEvent.click(screen.getByRole("button", { name: "保存新表名" }));
  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    DEVELOPMENT_PROFILE.id,
    "RENAME TABLE `pipa_dev`.`inventory` TO `pipa_dev`.`inventory_archive`;",
  ));

  table = screen.getByRole("treeitem", { name: "inventory" });
  fireEvent.contextMenu(table);
  fireEvent.click(screen.getByRole("menuitem", { name: "复制表…" }));
  const duplicateInput = screen.getByRole("textbox", { name: "复制为" });
  fireEvent.change(duplicateInput, { target: { value: "inventory_copy" } });
  expect(screen.getByRole("checkbox", { name: "同时复制表数据" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "开始复制" }));
  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    DEVELOPMENT_PROFILE.id,
    "CREATE TABLE `pipa_dev`.`inventory_copy` LIKE `pipa_dev`.`inventory`;",
  ));
  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    DEVELOPMENT_PROFILE.id,
    "INSERT INTO `pipa_dev`.`inventory_copy` SELECT * FROM `pipa_dev`.`inventory`;",
  ));
}

/** Verifies copy, pin, DDL preview/copy, and export shortcuts execute through shared app services. */
async function assertTableMetadataAndExportShortcuts(): Promise<void> {
  querySessionFixture.rows = [[
    { kind: "text", value: "inventory" },
    { kind: "text", value: "BASE TABLE" },
  ]];
  clipboardState.writeText.mockResolvedValue(undefined);
  vi.mocked(executeQueryOnce).mockImplementation(async (_connectionId, sql) => {
    if (sql.startsWith("SHOW CREATE TABLE")) {
      return {
        columns: [],
        rows: [[
          { kind: "text", value: "inventory" },
          { kind: "text", value: "CREATE TABLE `inventory` (`id` bigint NOT NULL)" },
        ]],
        affectedRows: 0,
      };
    }
    return {
      columns: [
        { name: "id", databaseType: "BIGINT", nullable: false },
        { name: "name", databaseType: "VARCHAR", nullable: true },
      ],
      rows: [[{ kind: "integer", value: "1" }, { kind: "text", value: "琴弦" }]],
      affectedRows: 0,
    };
  });
  render(<App />);
  await screen.findAllByText("开发主库");
  await selectConnection(/开发主库/u);
  let table = screen.getByRole("treeitem", { name: "inventory" });

  fireEvent.contextMenu(table);
  fireEvent.click(screen.getByRole("menuitem", { name: "复制表名" }));
  await waitFor(() => expect(clipboardState.writeText).toHaveBeenLastCalledWith("inventory"));

  fireEvent.contextMenu(table);
  fireEvent.click(screen.getByRole("menuitem", { name: "置顶表" }));
  table = screen.getByRole("treeitem", { name: /inventory/u });
  expect(table).toHaveTextContent("置顶");
  expect(window.localStorage.getItem("pipa:pinned-tables")).toContain(DEVELOPMENT_PROFILE.id);

  fireEvent.contextMenu(table);
  fireEvent.click(screen.getByRole("menuitem", { name: "显示 CREATE TABLE 语法…" }));
  const ddl = await screen.findByRole("textbox", { name: "inventory CREATE TABLE 语法" });
  expect(ddl).toHaveValue("CREATE TABLE `inventory` (`id` bigint NOT NULL)");
  fireEvent.click(screen.getByRole("button", { name: "复制语法" }));
  await waitFor(() => expect(clipboardState.writeText).toHaveBeenLastCalledWith(
    "CREATE TABLE `inventory` (`id` bigint NOT NULL)",
  ));
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));

  fireEvent.contextMenu(table);
  fireEvent.click(screen.getByRole("menuitem", { name: "导出" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "导出 CSV…" }));
  await waitFor(() => expect(downloadTextFile).toHaveBeenCalledWith(
    "id,name\n1,琴弦",
    "pipa_dev-inventory.csv",
    "text/csv;charset=utf-8",
  ));
}

/** Verifies the table-window shortcut reuses the native detached-workspace route. */
async function assertTableNewWindowShortcut(): Promise<void> {
  desktopRuntime.tauri = true;
  querySessionFixture.rows = [[
    { kind: "text", value: "inventory" },
    { kind: "text", value: "BASE TABLE" },
  ]];
  render(<App />);
  await screen.findAllByText("开发主库");
  await selectConnection(/开发主库/u);
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: "inventory" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "在新窗口中打开表" }));

  await waitFor(() => expect(desktopRuntime.createWindow).toHaveBeenCalledWith(
    {
      kind: "table",
      id: `${DEVELOPMENT_PROFILE.id}\u0000pipa_dev\u0000inventory`,
      connectionId: DEVELOPMENT_PROFILE.id,
      database: "pipa_dev",
      tableName: "inventory",
      title: "开发主库 · pipa_dev.inventory",
    },
    expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
  ));
}

/** Verifies shared workspace shortcuts cycle and close the active query tab. */
async function assertWorkspaceTabShortcuts(): Promise<void> {
  render(<App />);
  await selectConnection(/生产主库/u);
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

/** 验证 Ctrl/Cmd+数字可按标签顺序直接跳转，且 9 始终选中最后一个工作区。 */
async function assertPositionalWorkspaceJumpShortcuts(): Promise<void> {
  render(<App />);
  await selectConnection(/生产主库/u);
  fireEvent.click(screen.getByRole("button", {
    name: "在当前已选 MySQL 连接 生产主库 中新建查询",
  }));

  // 标签顺序为「恢复的查询」「生产主库 · 查询 1」。
  fireEvent.keyDown(document, { key: "1", metaKey: true });
  expect(screen.getByRole("tab", { name: "恢复的查询" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  fireEvent.keyDown(document, { key: "2", metaKey: true });
  expect(screen.getByRole("tab", { name: "生产主库 · 查询 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // 9 越界时跳到最后一个标签，而不是什么都不做。
  fireEvent.keyDown(document, { key: "1", metaKey: true });
  fireEvent.keyDown(document, { key: "9", metaKey: true });
  expect(screen.getByRole("tab", { name: "生产主库 · 查询 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

/** 验证 MCP 模态框打开时，工作区切换和关闭快捷键不会穿透到背景。 */
async function assertMcpDialogBlocksWorkspaceShortcuts(): Promise<void> {
  render(<App />);
  await selectConnection(/生产主库/u);
  fireEvent.click(screen.getByRole("button", {
    name: "在当前已选 MySQL 连接 生产主库 中新建查询",
  }));
  const activeTab = screen.getByRole("tab", { name: "生产主库 · 查询 1" });
  expect(activeTab).toHaveAttribute("aria-selected", "true");

  fireEvent.click(screen.getByRole("button", { name: "打开 MCP 控制台" }));
  expect(screen.getByRole("dialog", { name: "MCP 控制台" })).toBeVisible();
  fireEvent.keyDown(document, { key: "Tab", ctrlKey: true });
  fireEvent.keyDown(document, { key: "1", metaKey: true });
  fireEvent.keyDown(document, { key: "w", metaKey: true });

  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(activeTab).toHaveAttribute("aria-selected", "true");
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

  await selectConnection(/生产主库/u);
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
  await selectConnection(/生产主库/u);
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
  await findConnectionPicker();
  fireEvent.click(screen.getByRole("button", { name: "界面外观：跟随系统" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /暗色/ }));

  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(window.localStorage.getItem("pipa.theme-preference")).toBe("dark");
  expect(screen.getByRole("button", { name: "界面外观：暗色" })).toBeVisible();
}

/** Verifies the persistent topbar exposes shortcut editing without command-palette knowledge. */
async function assertShortcutSettingsEntry(): Promise<void> {
  render(<App />);
  await findConnectionPicker();
  fireEvent.click(screen.getByRole("button", { name: "打开快捷键设置" }));
  expect(screen.getByRole("dialog", { name: "快捷键设置" })).toBeVisible();
  expect(screen.getByRole("button", { name: "修改新建 SQL" })).toBeVisible();
}

/** Verifies the global palette discovers recent objects and searchable commands from the keyboard. */
async function assertGlobalCommandPalette(): Promise<void> {
  render(<App />);
  await findConnectionPicker();

  fireEvent.keyDown(document, { key: "p", metaKey: true, shiftKey: true });
  const palette = screen.getByRole("dialog", { name: "快速打开" });
  expect(palette).toBeVisible();
  const search = screen.getByRole("combobox", { name: /搜索连接/ });
  fireEvent.change(screen.getByRole("combobox", { name: "按连接过滤" }), {
    target: { value: PRODUCTION_PROFILE.id },
  });
  fireEvent.change(search, { target: { value: "mysql.production.internal" } });
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("button", { name: /当前连接 生产主库/u }))
    .toBeVisible());

  fireEvent.click(screen.getByRole("button", { name: /命令/ }));
  fireEvent.change(screen.getByRole("combobox", { name: /搜索连接/ }), { target: { value: "快捷键帮助" } });
  fireEvent.keyDown(screen.getByRole("combobox", { name: /搜索连接/ }), { key: "Enter" });
  expect(screen.getByRole("dialog", { name: "快捷键帮助" })).toBeVisible();
}

/** Verifies Binlog discovery reactivates one unbound utility tab and preserves its prior query. */
async function assertBinlogWorkspaceSingletonLifecycle(): Promise<void> {
  render(<App />);
  await findConnectionPicker();
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

  fireEvent.click(await findConnectionPicker());
  fireEvent.click(screen.getByRole("button", { name: "添加连接…" }));
  expect(screen.getByRole("heading", { name: "选择数据库类型" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Binlog 分析工作区" })).toBe(binlogRegion);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("heading", { name: "选择数据库类型" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Binlog 分析工作区" })).toBe(binlogRegion);

  await selectConnection(/生产主库/u);
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
  await findConnectionPicker();
  const shell = screen.getByRole("application", { name: "Pipa 数据库工作台" });
  const toggle = screen.getByRole("button", { name: "收起连接侧边栏" });

  expect(shell).not.toHaveClass("app-shell--sidebar-collapsed");
  fireEvent.click(toggle);
  expect(shell).toHaveClass("app-shell--sidebar-collapsed");
  expect(window.localStorage.getItem("pipa.sidebar-collapsed.v1")).toBe("1");
  expect(document.getElementById("connection-panel")).toBeTruthy();
  // The navigator stays mounted while collapsed, so its object list is still in the document.
  expect(document.querySelector(".connection-drawer")).toBeTruthy();
  // The workspace must survive collapse. Every shell region stays mounted and in
  // document order so the grid keeps all four of its explicitly placed tracks;
  // dropping one shifts the workspace into the collapsed zero-width column.
  expect(screen.getByRole("main", { name: "查询工作区" })).toBeVisible();
  expect([...shell.children].map((child) => child.className.split(" ")[0])).toEqual([
    "activity-rail",
    "connection-panel",
    "sidebar-resizer",
    "workspace",
  ]);

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

/**
 * Verifies the topbar picker reports the current connection even while the sidebar is collapsed.
 *
 * The picker replaces the old reveal-in-sidebar chip: it states where the user is and switches
 * connections directly, so it stays useful with no navigator on screen.
 * Parameters: none.
 * @returns A promise settled after switching connections from the collapsed shell.
 * Side effects: renders the App and drives the picker.
 */
async function assertCollapsedTopbarPickerStatesAndSwitches(): Promise<void> {
  window.localStorage.setItem("pipa.sidebar-collapsed.v1", "1");
  render(<App />);
  const shell = await screen.findByRole("application", { name: "Pipa 数据库工作台" });
  expect(shell).toHaveClass("app-shell--sidebar-collapsed");

  expect(await screen.findByRole("button", { name: /当前连接 开发主库 · pipa_dev/u }))
    .toBeVisible();

  await selectConnection(/生产主库/u);

  // Switching does not force the navigator open; the collapsed choice is the user's.
  expect(shell).toHaveClass("app-shell--sidebar-collapsed");
  await waitFor(() => expect(screen.getByRole("button", { name: /当前连接 生产主库/u }))
    .toBeVisible());
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
  await waitFor(() => expect(screen.getByRole("button", { name: /当前连接 生产主库/u }))
    .toBeVisible());
  expect(window.localStorage.getItem("pipa.sidebar-collapsed.v1")).toBe("0");
}

/** Verifies rename, safe config copy, and backend-owned reconnect stay in the connection menu. */
async function assertSecondaryConnectionActions(): Promise<void> {
  clipboardState.writeText.mockResolvedValue(undefined);
  vi.mocked(renameConnection).mockResolvedValue({ ...PRODUCTION_PROFILE, name: "线上主库" });
  vi.mocked(reconnectConnection).mockResolvedValue(undefined);
  render(<App />);
  await openConnectionActions(/生产主库/u);
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名…" }));
  const renameInput = screen.getByRole("textbox", { name: "连接名称" });
  fireEvent.change(renameInput, { target: { value: "线上主库" } });
  fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
  await waitFor(() => expect(renameConnection).toHaveBeenCalledWith(PRODUCTION_PROFILE.id, "线上主库"));
  // The rename propagates to the picker, which is now the place a connection's name is shown.
  await waitFor(() => expect(screen.getByRole("button", { name: /当前连接 线上主库/u }))
    .toBeVisible());

  await openConnectionActions(/线上主库/u);
  fireEvent.click(screen.getByRole("menuitem", { name: "复制连接配置" }));
  await waitFor(() => expect(clipboardState.writeText).toHaveBeenCalledTimes(1));
  expect(clipboardState.writeText.mock.calls[0]?.[0]).toContain("mysql.production.internal");
  expect(clipboardState.writeText.mock.calls[0]?.[0]).not.toContain("password");

  await openConnectionActions(/线上主库/u);
  fireEvent.click(screen.getByRole("menuitem", { name: "重新连接" }));
  await waitFor(() => expect(reconnectConnection).toHaveBeenCalledWith(PRODUCTION_PROFILE.id));
}

/**
 * Verifies the create-database quick action validates its name, emits allowlisted clauses only,
 * and reports the outcome without leaving the dialog open.
 * Parameters: none.
 * @returns A promise settled after the confirmed statement and its toast are asserted.
 * Side effects: renders the App and dispatches pointer, change, and keyboard events.
 */
async function assertCreateDatabaseQuickAction(): Promise<void> {
  vi.mocked(executeQueryOnce).mockResolvedValue({ columns: [], rows: [], affectedRows: 0 });
  render(<App />);
  await openConnectionActions(/生产主库/u);
  fireEvent.click(screen.getByRole("menuitem", { name: "新建数据库…" }));
  const dialog = screen.getByRole("dialog", { name: "新建数据库" });
  expect(within(dialog).getByText("生产主库")).toBeVisible();

  // An invalid name is rejected locally, so nothing reaches the query boundary.
  const nameInput = within(dialog).getByRole("textbox", { name: "数据库名" });
  fireEvent.change(nameInput, { target: { value: "app/orders" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "创建数据库" }));
  expect(within(dialog).getByRole("alert")).toHaveTextContent("数据库名不能包含 / \\ . 这三种字符。");
  expect(executeQueryOnce).not.toHaveBeenCalledWith(
    PRODUCTION_PROFILE.id,
    expect.stringContaining("CREATE DATABASE"),
    expect.anything(),
  );

  fireEvent.change(nameInput, { target: { value: "app_orders" } });
  // The collation control only appears once an explicit character set is chosen.
  expect(within(dialog).queryByRole("combobox", { name: "排序规则" })).not.toBeInTheDocument();
  fireEvent.change(within(dialog).getByRole("combobox", { name: "字符集" }), {
    target: { value: "utf8mb4" },
  });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "排序规则" }), {
    target: { value: "utf8mb4_bin" },
  });
  fireEvent.keyDown(nameInput, { key: "Enter" });

  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    PRODUCTION_PROFILE.id,
    "CREATE DATABASE `app_orders` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;",
  ));
  await waitFor(() => expect(
    screen.queryByRole("dialog", { name: "新建数据库" }),
  ).not.toBeInTheDocument());
  expect(await screen.findByRole("status")).toHaveTextContent(
    "已在连接“生产主库”中创建数据库“app_orders”。",
  );
}

/**
 * Verifies a failed CREATE DATABASE keeps the dialog open with the backend reason.
 * Parameters: none.
 * @returns A promise settled after the failure message is asserted.
 * Side effects: renders the App and rejects one mocked query.
 */
async function assertCreateDatabaseFailureKeepsDialogOpen(): Promise<void> {
  vi.mocked(executeQueryOnce).mockRejectedValue({
    code: "query",
    message: "Access denied for user",
    technicalDetails: null,
    retryable: false,
  });
  render(<App />);
  await openConnectionActions(/生产主库/u);
  fireEvent.click(screen.getByRole("menuitem", { name: "新建数据库…" }));
  const dialog = screen.getByRole("dialog", { name: "新建数据库" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "数据库名" }), {
    target: { value: "app_orders" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "创建数据库" }));

  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    PRODUCTION_PROFILE.id,
    "CREATE DATABASE `app_orders`;",
  ));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Access denied for user");
  expect(screen.getByRole("dialog", { name: "新建数据库" })).toBeVisible();
}

/**
 * Verifies the connection manager opens as its own closable workspace tab.
 *
 * It is a workspace rather than a dialog so configuration can stay open alongside queries.
 * Parameters: none.
 * @returns A promise settled after the tab is opened and closed again.
 * Side effects: renders the App and dispatches clicks.
 */
async function assertConnectionManagerWorkspace(): Promise<void> {
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "打开连接管理" }));

  const tab = await screen.findByRole("tab", { name: "连接管理" });
  expect(tab).toHaveAttribute("aria-selected", "true");
  const manager = screen.getByRole("region", { name: "连接管理" });
  // Configuration reaches the database level only; tables stay in the navigator.
  expect(within(manager).getByRole("tab", { name: /连接信息/u })).toBeVisible();
  expect(within(manager).getByRole("tab", { name: /数据库/u })).toBeVisible();
  expect(within(manager).getByRole("option", { name: /生产主库/u })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "关闭 连接管理" }));
  await waitFor(() => expect(
    screen.queryByRole("tab", { name: "连接管理" }),
  ).not.toBeInTheDocument());
}

/**
 * Verifies connection management is reachable in one click, without hunting for a gesture.
 *
 * The navigator carries a permanent entry, and the picker's row control opens the manager already
 * focused on that connection, so managing one never means opening a tab and searching again.
 * Parameters: none.
 * @returns A promise settled after both shallow entry points are asserted.
 * Side effects: renders the App and dispatches clicks.
 */
async function assertShallowConnectionManagementEntries(): Promise<void> {
  render(<App />);
  await findConnectionPicker();

  // 1. A permanent button in the navigator, no right-click needed.
  fireEvent.click(screen.getByRole("button", { name: /管理连接/u }));
  expect(await screen.findByRole("region", { name: "连接管理" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "关闭 连接管理" }));

  // 2. The picker's per-row edit control lands on that exact connection.
  fireEvent.click(await findConnectionPicker());
  fireEvent.click(screen.getByRole("button", { name: "编辑 生产主库" }));
  const manager = await screen.findByRole("region", { name: "连接管理" });
  await waitFor(() => expect(within(manager).getByRole("option", { name: /生产主库/u }))
    .toHaveAttribute("aria-selected", "true"));
  expect(within(manager).getByRole("tab", { name: /连接信息/u }))
    .toHaveAttribute("aria-selected", "true");
}

/**
 * Verifies dropping a schema requires retyping its name and then closes that schema's tabs.
 * Parameters: none.
 * @returns A promise settled after the DROP DATABASE statement is asserted.
 * Side effects: renders the App, dispatches clicks, and resolves one mocked query.
 */
async function assertConfirmedDatabaseDeletion(): Promise<void> {
  vi.mocked(executeQueryOnce).mockImplementation(async (_connectionId, sql) => (
    sql.includes("INFORMATION_SCHEMA.SCHEMATA")
      ? {
        columns: [],
        affectedRows: 0,
        rows: [
          [{ kind: "text", value: "pipa" }, { kind: "text", value: "utf8mb4" }, { kind: "text", value: "utf8mb4_bin" }],
          [{ kind: "text", value: "scratch" }, { kind: "text", value: "utf8mb4" }, { kind: "text", value: "utf8mb4_bin" }],
        ],
      }
      : { columns: [], rows: [], affectedRows: 0 }
  ));
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "打开连接管理" }));
  const manager = screen.getByRole("region", { name: "连接管理" });
  fireEvent.click(within(manager).getByRole("option", { name: /生产主库/u }));
  fireEvent.click(within(manager).getByRole("tab", { name: /数据库/u }));

  const scratchRow = await within(manager).findByRole("row", { name: /scratch/u });
  fireEvent.click(within(scratchRow).getByRole("button", { name: /删除/u }));
  const dialog = screen.getByRole("dialog", { name: "删除数据库" });
  const confirm = within(dialog).getByRole("button", { name: "永久删除" });

  // Confirmation is gated on an exact name match, so a near miss stays blocked.
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "scratc" } });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "scratch" } });
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);

  await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    PRODUCTION_PROFILE.id,
    "DROP DATABASE `scratch`;",
  ));
  expect(await screen.findByRole("status")).toHaveTextContent("已删除数据库“scratch”。");
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
    vi.mocked(downloadTextFile).mockResolvedValue("saved");
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
  it("confirms destructive table shortcuts before executing SQL", assertConfirmedTableDestructiveActions);
  it("renames and duplicates tables from shared shortcuts", assertTableNameShortcuts);
  it("copies, pins, previews, and exports table metadata", assertTableMetadataAndExportShortcuts);
  it("opens a table shortcut in a native window", assertTableNewWindowShortcut);
  it("cycles and closes shared workspace tabs with conventional shortcuts", assertWorkspaceTabShortcuts);
  it("jumps directly to a workspace by position", assertPositionalWorkspaceJumpShortcuts);
  it("blocks workspace shortcuts while the MCP dialog is open", assertMcpDialogBlocksWorkspaceShortcuts);
  it("keeps query results mounted across workspace switches", assertQueryResultsSurviveWorkspaceSwitch);
  it("uses a configured workspace shortcut and releases its previous default", assertConfiguredGlobalShortcut);
  it("switches and persists the selected interface appearance", assertThemeSwitching);
  it("opens shortcut settings from the persistent topbar entry", assertShortcutSettingsEntry);
  it("opens and searches the global command palette", assertGlobalCommandPalette);
  it("discovers and reuses one connection-independent Binlog workspace", assertBinlogWorkspaceSingletonLifecycle);
  it("opens the Binlog workspace without a saved connection", assertBinlogWorkspaceNeedsNoConnection);
  it("switches to Binlog without unmounting a busy query", assertBusyQueryCanSwitchToBinlog);
  it("collapses the connection sidebar and restores the preference", assertSidebarCollapseToggleAndPersistence);
  it("states and switches the connection from the collapsed topbar", assertCollapsedTopbarPickerStatesAndSwitches);
  it("expands a collapsed sidebar when the palette opens a connection", assertPaletteNavigationExpandsSidebar);
  it("renames, copies, and reconnects from the connection context menu", assertSecondaryConnectionActions);
  it("creates a database from the connection quick action", assertCreateDatabaseQuickAction);
  it("opens the connection manager as its own workspace tab", assertConnectionManagerWorkspace);
  it("reaches connection management in one click from the navigator", assertShallowConnectionManagementEntries);
  it("drops a database only after its name is retyped", assertConfirmedDatabaseDeletion);
  it("keeps the create-database dialog open after a failure", assertCreateDatabaseFailureKeepsDialogOpen);
  it("moves an idle query into a new native window when dragged outside", assertQueryWorkspaceDetachesIntoNativeWindow);
  it("rolls a query back when native window creation fails", assertFailedQueryDetachRollsBack);
  it("removes a detached window from restart recovery when it closes", assertDetachedWindowCloseClearsRestoreSnapshot);
}

describe("App", registerAppTests);
