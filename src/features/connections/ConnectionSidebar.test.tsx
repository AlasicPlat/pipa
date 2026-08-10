import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { resetAllShortcutBindings, updateShortcutBinding } from "../commands/shortcutRegistry";
import type { QuerySessionState } from "../query/useQuerySession";
import { ConnectionSidebar } from "./ConnectionSidebar";

const tableSession = vi.hoisted(() => ({
  state: {
    queryId: null,
    connectionId: null,
    sql: "",
    columns: [],
    rows: [],
    running: false,
    cancelRequested: false,
    incomplete: false,
    affectedRows: null,
    error: null,
  } as QuerySessionState,
  run: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("../query/useQuerySession", () => ({ useQuerySession: () => tableSession }));

const executeQueryOnce = vi.hoisted(() => vi.fn());

vi.mock("../query/executeQueryOnce", () => ({ executeQueryOnce }));

const MYSQL_CONNECTIONS: ConnectionProfile[] = [
  {
    id: "0d27c056-fd60-4ed4-9570-ab63c500073c",
    name: "订单主库",
    engine: "my_sql",
    environment: "production",
    host: "mysql.internal",
    port: 3306,
    username: "pipa",
    database: "orders",
    tlsMode: "required",
  },
  {
    id: "c5b9bdc0-b6c6-4a38-8e05-f2857ca2659f",
    name: "本地开发",
    engine: "my_sql",
    environment: "development",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    database: null,
    tlsMode: "disabled",
  },
];

const REDIS_CONNECTION: ConnectionProfile = {
  ...MYSQL_CONNECTIONS[1],
  id: "redis-development",
  name: "本地缓存",
  engine: "redis",
  port: 6379,
  database: "0",
};

/**
 * Verifies strict engine grouping, empty states, and the selected-row interaction.
 * Parameters: none.
 * @returns A promise that resolves after the selection state is asserted.
 * Side effects: renders the sidebar and dispatches one click event.
 */
async function assertGroupedConnectionSelection(): Promise<void> {
  const selectConnection = vi.fn();
  const { container, rerender } = render(
    <ConnectionSidebar
      profiles={MYSQL_CONNECTIONS}
      selectedConnectionId={null}
      onSelectConnection={selectConnection}
      onAddConnection={vi.fn()}
    />,
  );

  const mysqlGroup = screen.getByRole("region", { name: "MySQL 连接" });
  const postgresqlGroup = screen.getByRole("region", { name: "PostgreSQL 连接" });
  const mongodbGroup = screen.getByRole("region", { name: "MongoDB 连接" });
  const redisGroup = screen.getByRole("region", { name: "Redis 连接" });

  expect(within(mysqlGroup).getByRole("button", { name: "收起 MySQL 连接分组" })).toHaveAttribute("aria-expanded", "true");
  expect(within(postgresqlGroup).getByRole("button", { name: "展开 PostgreSQL 连接分组" })).toHaveAttribute("aria-expanded", "false");
  expect(within(mongodbGroup).getByRole("button", { name: "展开 MongoDB 连接分组" })).toHaveAttribute("aria-expanded", "false");
  expect(within(redisGroup).getByRole("button", { name: "展开 Redis 连接分组" })).toHaveAttribute("aria-expanded", "false");
  expect(within(mysqlGroup).getByRole("button", { name: /订单主库/ })).toHaveStyle({
    minHeight: "40px",
  });
  expect(within(mysqlGroup).getByRole("button", { name: /本地开发/ })).toBeVisible();
  expect(within(postgresqlGroup).queryByText("订单主库")).not.toBeInTheDocument();

  fireEvent.click(within(mongodbGroup).getByRole("button", { name: "展开 MongoDB 连接分组" }));
  expect(within(mongodbGroup).getByRole("button", { name: "收起 MongoDB 连接分组" })).toHaveAttribute("aria-expanded", "true");
  expect(within(mongodbGroup).getByText("暂无连接")).toBeVisible();

  const orderConnection = container.querySelector<HTMLButtonElement>(
    `[data-connection-id="${MYSQL_CONNECTIONS[0].id}"]`,
  );
  expect(orderConnection).not.toBeNull();
  if (!orderConnection) return;
  fireEvent.click(orderConnection);
  expect(selectConnection).toHaveBeenCalledWith(MYSQL_CONNECTIONS[0].id);

  rerender(
    <ConnectionSidebar
      profiles={MYSQL_CONNECTIONS}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onSelectConnection={selectConnection}
      onAddConnection={vi.fn()}
    />,
  );

  const selectedOrderConnection = container.querySelector<HTMLButtonElement>(
    `[data-connection-id="${MYSQL_CONNECTIONS[0].id}"]`,
  );
  expect(selectedOrderConnection).toHaveAttribute("aria-selected", "true");
  expect(selectedOrderConnection).toHaveClass("is-selected");
}

/**
 * Verifies multiple connections retain independent table drawers after single click.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the navigator and dispatches two click events.
 */
function assertIndependentConnectionDrawers(): void {
  render(
    <ConnectionSidebar
      profiles={MYSQL_CONNECTIONS}
      selectedConnectionId={null}
      onSelectConnection={vi.fn()}
      onAddConnection={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /订单主库/ }));
  fireEvent.click(screen.getByRole("button", { name: /本地开发/ }));

  expect(screen.getByLabelText("订单主库 数据表")).toBeVisible();
  expect(screen.getByLabelText("本地开发 数据表")).toBeVisible();
  expect(tableSession.run).toHaveBeenCalledWith("SHOW FULL TABLES;");
}

/** Verifies a connection click toggles once while table rows still own double-click opening. */
function assertSingleClickConnectionToggle(): void {
  render(
    <ConnectionSidebar
      profiles={[MYSQL_CONNECTIONS[0]]}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onAddConnection={vi.fn()}
      onSelectConnection={vi.fn()}
    />,
  );

  const connection = screen.getByRole("button", { name: /订单主库/u });
  expect(connection).toHaveAttribute("title", "单击或按 Enter 展开数据表");
  fireEvent.click(connection, { detail: 1 });
  expect(screen.getByLabelText("订单主库 数据表")).toBeVisible();
  expect(connection).toHaveAttribute("title", "单击或按 Enter 收起数据表");

  fireEvent.click(connection, { detail: 2 });
  expect(screen.getByLabelText("订单主库 数据表")).toBeVisible();
  fireEvent.click(connection, { detail: 1 });
  expect(screen.queryByLabelText("订单主库 数据表")).not.toBeInTheDocument();
}

/** Verifies table discovery is available globally and beside an expanded SQL connection. */
function assertTableFinderEntryPoints(): void {
  const onFindTables = vi.fn();
  render(
    <ConnectionSidebar
      profiles={[MYSQL_CONNECTIONS[0]]}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onAddConnection={vi.fn()}
      onFindTables={onFindTables}
      onSelectConnection={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "查找表" }));
  expect(onFindTables).toHaveBeenLastCalledWith();

  const connection = screen.getByRole("button", { name: /订单主库/u });
  expect(connection).toHaveTextContent("orders · mysql.internal:3306");
  fireEvent.click(connection);
  fireEvent.click(screen.getByRole("button", { name: "在 订单主库 中查找数据表" }));
  expect(onFindTables).toHaveBeenLastCalledWith(MYSQL_CONNECTIONS[0].id);
}

/** Verifies Redis connections reveal databases before a database-scoped key scan. */
async function assertRedisKeyBrowser(): Promise<void> {
  const openRedisKey = vi.fn();
  const selectRedisDatabase = vi.fn();
  render(
    <ConnectionSidebar
      profiles={[REDIS_CONNECTION]}
      selectedConnectionId={REDIS_CONNECTION.id}
      onAddConnection={vi.fn()}
      onOpenRedisKey={openRedisKey}
      onSelectRedisDatabase={selectRedisDatabase}
      onSelectConnection={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /本地缓存/ }));
  await vi.waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    REDIS_CONNECTION.id,
    "INFO keyspace",
  ));
  expect(executeQueryOnce).not.toHaveBeenCalledWith(
    REDIS_CONNECTION.id,
    'SCAN 0 MATCH "*" COUNT 500',
    expect.anything(),
  );

  const database = await screen.findByRole("treeitem", { name: /DB 2/u });
  fireEvent.doubleClick(database);
  await vi.waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
    REDIS_CONNECTION.id,
    'SCAN 0 MATCH "*" COUNT 500',
    "2",
  ));
  expect(selectRedisDatabase).toHaveBeenCalledWith(REDIS_CONNECTION.id, "2");

  fireEvent.doubleClick(await screen.findByRole("treeitem", { name: "user:1" }));
  expect(openRedisKey).toHaveBeenCalledWith(REDIS_CONNECTION.id, "2", "user:1");
}

/** Verifies unified navigator filtering and double-click-only workspace opening. */
function assertTableSearchAndDoubleClickOpen(): void {
  tableSession.state.rows = [
    [{ kind: "text", value: "orders" }, { kind: "text", value: "BASE TABLE" }],
    [{ kind: "text", value: "customers" }, { kind: "text", value: "BASE TABLE" }],
  ];
  const openTable = vi.fn();
  render(
    <ConnectionSidebar
      profiles={[MYSQL_CONNECTIONS[0]]}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onSelectConnection={vi.fn()}
      onOpenTable={openTable}
      onAddConnection={vi.fn()}
      tableCatalog={{ [MYSQL_CONNECTIONS[0].id]: ["orders", "customers"] }}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /订单主库/ }));
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索连接或已加载的数据表" }), {
    target: { value: "order" },
  });
  expect(screen.getByRole("treeitem", { name: "orders" })).toBeVisible();
  expect(screen.queryByRole("treeitem", { name: "customers" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("treeitem", { name: "orders" }));
  expect(openTable).not.toHaveBeenCalled();
  fireEvent.doubleClick(screen.getByRole("treeitem", { name: "orders" }));
  expect(openTable).toHaveBeenCalledWith(MYSQL_CONNECTIONS[0].id, "orders");
}

/** Verifies table rows expose reviewed TRUNCATE and DROP shortcuts by pointer or keyboard. */
function assertTableDestructiveContextMenu(): void {
  tableSession.state.rows = [
    [{ kind: "text", value: "orders" }, { kind: "text", value: "BASE TABLE" }],
    [{ kind: "text", value: "order_summary" }, { kind: "text", value: "VIEW" }],
  ];
  const onRequestTableAction = vi.fn();
  render(
    <ConnectionSidebar
      profiles={[MYSQL_CONNECTIONS[0]]}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onAddConnection={vi.fn()}
      onRequestTableAction={onRequestTableAction}
      onSelectConnection={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /订单主库/u }));
  const table = screen.getByRole("treeitem", { name: "orders" });
  fireEvent.contextMenu(table, { clientX: 120, clientY: 160 });
  expect(screen.getByRole("menu", { name: "orders 表操作" })).toBeVisible();
  fireEvent.click(screen.getByRole("menuitem", { name: "清空表…" }));
  expect(onRequestTableAction).toHaveBeenLastCalledWith(
    MYSQL_CONNECTIONS[0].id,
    "orders",
    "truncate",
  );

  table.focus();
  fireEvent.keyDown(table, { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: "删除表…" }));
  expect(onRequestTableAction).toHaveBeenLastCalledWith(
    MYSQL_CONNECTIONS[0].id,
    "orders",
    "drop",
  );

  fireEvent.contextMenu(screen.getByRole("treeitem", { name: /order_summary/u }));
  expect(screen.queryByRole("menu", { name: "order_summary 表操作" })).not.toBeInTheDocument();
}

/** Verifies persisted pin identities reorder only their owning connection's table list. */
function assertPinnedTableOrdering(): void {
  tableSession.state.rows = [
    [{ kind: "text", value: "customers" }, { kind: "text", value: "BASE TABLE" }],
    [{ kind: "text", value: "orders" }, { kind: "text", value: "BASE TABLE" }],
  ];
  render(
    <ConnectionSidebar
      pinnedTableKeys={new Set([`${MYSQL_CONNECTIONS[0].id}\u0000orders`])}
      profiles={[MYSQL_CONNECTIONS[0]]}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onAddConnection={vi.fn()}
      onRequestTableAction={vi.fn()}
      onSelectConnection={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /订单主库/u }));
  const tables = screen.getAllByRole("treeitem");
  expect(tables.map((table) => table.getAttribute("data-table-name"))).toEqual(["orders", "customers"]);
  expect(tables[0]).toHaveTextContent("置顶");
  fireEvent.contextMenu(tables[0]!);
  expect(screen.getByRole("menuitem", { name: "取消置顶" })).toBeVisible();
}

/** Verifies right click exposes an explicit delete action for the exact connection. */
function assertContextMenuRequestsDeletion(): void {
  const selectConnection = vi.fn();
  const requestRename = vi.fn();
  const copyConfig = vi.fn();
  const reconnect = vi.fn();
  const requestDelete = vi.fn();
  render(
    <ConnectionSidebar
      profiles={[MYSQL_CONNECTIONS[0]]}
      selectedConnectionId={null}
      onCopyConfig={copyConfig}
      onReconnect={reconnect}
      onSelectConnection={selectConnection}
      onRequestRename={requestRename}
      onRequestDelete={requestDelete}
      onAddConnection={vi.fn()}
    />,
  );

  const connection = screen.getByRole("button", { name: /订单主库/ });
  fireEvent.contextMenu(connection, { clientX: 120, clientY: 160 });

  expect(selectConnection).toHaveBeenCalledWith(MYSQL_CONNECTIONS[0].id);
  expect(screen.getByRole("menu", { name: "订单主库 操作" })).toBeVisible();
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "重命名…",
    "复制连接配置",
    "重新连接",
    "删除连接…",
  ]);
  expect(screen.getByRole("separator")).toBeVisible();
  fireEvent.click(screen.getByRole("menuitem", { name: "删除连接…" }));
  expect(requestDelete).toHaveBeenCalledWith(MYSQL_CONNECTIONS[0]);

  fireEvent.keyDown(connection, { key: "F10", shiftKey: true });
  expect(screen.getByRole("menu", { name: "订单主库 操作" })).toBeVisible();
}

/** Verifies completed table metadata is reported for command-palette discovery. */
async function assertLoadedTablesAreReported(): Promise<void> {
  tableSession.state.queryId = "tables-query";
  tableSession.state.rows = [
    [{ kind: "text", value: "orders" }, { kind: "text", value: "BASE TABLE" }],
    [{ kind: "text", value: "customers" }, { kind: "text", value: "BASE TABLE" }],
  ];
  const onTablesLoaded = vi.fn();
  render(
    <ConnectionSidebar
      profiles={[MYSQL_CONNECTIONS[0]]}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onAddConnection={vi.fn()}
      onSelectConnection={vi.fn()}
      onTablesLoaded={onTablesLoaded}
    />,
  );

  await vi.waitFor(() => expect(onTablesLoaded).toHaveBeenCalledWith(
    MYSQL_CONNECTIONS[0].id,
    ["orders", "customers"],
  ));
}

/** Verifies opening global discovery loads table names without visually expanding drawers. */
function assertGlobalDiscoveryLoadsTables(): void {
  render(
    <ConnectionSidebar
      discoverTables
      profiles={[MYSQL_CONNECTIONS[0]]}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onAddConnection={vi.fn()}
      onSelectConnection={vi.fn()}
    />,
  );

  expect(tableSession.run).toHaveBeenCalledWith("SHOW FULL TABLES;");
  expect(screen.queryByLabelText("订单主库 数据表")).not.toBeInTheDocument();
}

/** Verifies a connection-scoped finder does not load metadata from unrelated connections. */
function assertScopedDiscoveryLoadsOneConnection(): void {
  render(
    <ConnectionSidebar
      discoverTables
      discoverTablesForConnectionId={MYSQL_CONNECTIONS[0].id}
      profiles={[
        MYSQL_CONNECTIONS[0],
        { ...MYSQL_CONNECTIONS[1], database: "local_development" },
      ]}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onAddConnection={vi.fn()}
      onSelectConnection={vi.fn()}
    />,
  );

  expect(tableSession.run).toHaveBeenCalledTimes(1);
  expect(tableSession.run).toHaveBeenCalledWith("SHOW FULL TABLES;");
}

/** Verifies arrow navigation and Enter/Escape expansion keep connection focus predictable. */
function assertConnectionKeyboardNavigation(): void {
  const selectConnection = vi.fn();
  render(
    <ConnectionSidebar
      profiles={MYSQL_CONNECTIONS}
      selectedConnectionId={null}
      onSelectConnection={selectConnection}
      onAddConnection={vi.fn()}
    />,
  );

  const firstConnection = screen.getByRole("button", { name: /订单主库/ });
  const secondConnection = screen.getByRole("button", { name: /本地开发/ });
  firstConnection.focus();
  fireEvent.keyDown(firstConnection, { key: "ArrowDown" });
  expect(secondConnection).toHaveFocus();
  expect(selectConnection).toHaveBeenLastCalledWith(MYSQL_CONNECTIONS[1].id);

  fireEvent.keyDown(secondConnection, { key: "ArrowUp" });
  expect(firstConnection).toHaveFocus();
  fireEvent.keyDown(firstConnection, { key: "ArrowRight" });
  expect(screen.getByLabelText("订单主库 数据表")).toBeVisible();
  expect(tableSession.run).toHaveBeenCalledWith("SHOW FULL TABLES;");

  fireEvent.keyDown(firstConnection, { key: "ArrowLeft" });
  expect(screen.queryByLabelText("订单主库 数据表")).not.toBeInTheDocument();
  expect(firstConnection).toHaveFocus();
}

/** Verifies table arrows, Enter opening, and Escape return focus to the owning connection. */
function assertTableKeyboardNavigation(): void {
  tableSession.state.rows = [
    [{ kind: "text", value: "orders" }, { kind: "text", value: "BASE TABLE" }],
    [{ kind: "text", value: "customers" }, { kind: "text", value: "BASE TABLE" }],
  ];
  const openTable = vi.fn();
  const selectConnection = vi.fn();
  render(
    <ConnectionSidebar
      profiles={[MYSQL_CONNECTIONS[0]]}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onSelectConnection={selectConnection}
      onOpenTable={openTable}
      onAddConnection={vi.fn()}
    />,
  );

  const connection = screen.getByRole("button", { name: /订单主库/ });
  fireEvent.keyDown(connection, { key: "Enter" });
  const orders = screen.getByRole("treeitem", { name: "orders" });
  const customers = screen.getByRole("treeitem", { name: "customers" });
  orders.focus();
  fireEvent.keyDown(orders, { key: "ArrowDown" });
  expect(customers).toHaveFocus();
  expect(customers).toHaveAttribute("aria-selected", "true");

  fireEvent.keyDown(customers, { key: "Enter" });
  expect(openTable).toHaveBeenCalledWith(MYSQL_CONNECTIONS[0].id, "customers");
  fireEvent.keyDown(customers, { key: "Escape" });
  expect(screen.queryByLabelText("订单主库 数据表")).not.toBeInTheDocument();
  expect(connection).toHaveFocus();
  expect(selectConnection).toHaveBeenLastCalledWith(MYSQL_CONNECTIONS[0].id);
}

/** Verifies scoped find focuses the sidebar-wide navigator search. */
function assertScopedTableSearchShortcut(): void {
  expect(updateShortcutBinding("find", "Alt+K")).toBe(true);
  render(
    <ConnectionSidebar
      profiles={[MYSQL_CONNECTIONS[0]]}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onSelectConnection={vi.fn()}
      onAddConnection={vi.fn()}
    />,
  );

  const connection = screen.getByRole("button", { name: /订单主库/ });
  const search = screen.getByRole("searchbox", { name: "搜索连接或已加载的数据表" });
  connection.focus();
  expect(fireEvent.keyDown(connection, { key: "k", altKey: true })).toBe(false);
  expect(search).toHaveFocus();
}

/** Verifies engine sections can be collapsed and remember the override. */
function assertEngineSectionCollapseToggle(): void {
  render(
    <ConnectionSidebar
      profiles={MYSQL_CONNECTIONS}
      selectedConnectionId={null}
      onSelectConnection={vi.fn()}
      onAddConnection={vi.fn()}
    />,
  );

  const mysqlToggle = screen.getByRole("button", { name: "收起 MySQL 连接分组" });
  expect(mysqlToggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /订单主库/ })).toBeVisible();

  fireEvent.click(mysqlToggle);
  expect(screen.getByRole("button", { name: "展开 MySQL 连接分组" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: /订单主库/ })).not.toBeInTheDocument();
  expect(window.localStorage.getItem("pipa.engine-section-collapse.v1")).toContain("\"my_sql\":true");

  fireEvent.click(screen.getByRole("button", { name: "展开 MySQL 连接分组" }));
  expect(screen.getByRole("button", { name: "收起 MySQL 连接分组" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /订单主库/ })).toBeVisible();
}

/** Verifies navigator search matches loaded catalog tables and auto-expands that connection. */
function assertUnifiedSearchMatchesCatalogTables(): void {
  render(
    <ConnectionSidebar
      profiles={MYSQL_CONNECTIONS}
      selectedConnectionId={null}
      onSelectConnection={vi.fn()}
      onAddConnection={vi.fn()}
      tableCatalog={{ [MYSQL_CONNECTIONS[0].id]: ["orders", "customers"] }}
    />,
  );

  fireEvent.change(screen.getByRole("searchbox", { name: "搜索连接或已加载的数据表" }), {
    target: { value: "customers" },
  });
  expect(document.querySelector(
    `[data-connection-id="${MYSQL_CONNECTIONS[0].id}"]`,
  )).toBeVisible();
  expect(document.querySelector(
    `[data-connection-id="${MYSQL_CONNECTIONS[1].id}"]`,
  )).not.toBeInTheDocument();
  expect(screen.getByLabelText("订单主库 数据表")).toBeVisible();
}

/** Verifies staged table changes remain visible on both their table and owning connection. */
function assertDirtyObjectIndicators(): void {
  tableSession.state.rows = [
    [{ kind: "text", value: "orders" }, { kind: "text", value: "BASE TABLE" }],
  ];
  render(
    <ConnectionSidebar
      dirtyTables={[{ connectionId: MYSQL_CONNECTIONS[0].id, tableName: "orders" }]}
      profiles={[MYSQL_CONNECTIONS[0]]}
      selectedConnectionId={MYSQL_CONNECTIONS[0].id}
      onSelectConnection={vi.fn()}
      onAddConnection={vi.fn()}
    />,
  );

  expect(screen.getByLabelText("订单主库 下有未提交修改")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /订单主库/ }));
  expect(screen.getByLabelText("orders 有未提交修改")).toBeVisible();
}

/**
 * Registers the connection-sidebar behavior tests.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: registers one Vitest case.
 */
function registerConnectionSidebarTests(): void {
  beforeEach(() => {
    window.localStorage.clear();
    tableSession.state.rows = [];
    tableSession.state.queryId = null;
    tableSession.state.affectedRows = null;
    vi.clearAllMocks();
    executeQueryOnce.mockImplementation(async (_connectionId: string, command: string) => (
      command === "INFO keyspace"
        ? {
            columns: [{ name: "value", databaseType: "REDIS VALUE", nullable: null }],
            rows: [[{
              kind: "text",
              value: "# Keyspace\r\ndb0:keys=1,expires=0,avg_ttl=0\r\ndb2:keys=2,expires=1,avg_ttl=3200\r\n",
            }]],
            affectedRows: 0,
          }
        : {
            columns: [
              { name: "cursor", databaseType: "REDIS CURSOR", nullable: null },
              { name: "key", databaseType: "REDIS VALUE", nullable: null },
            ],
            rows: [
              [{ kind: "text", value: "0" }, { kind: "text", value: "user:1" }],
              [{ kind: "text", value: "0" }, { kind: "text", value: "jobs:ready" }],
            ],
            affectedRows: 0,
          }
    ));
  });
  afterEach(() => {
    cleanup();
    resetAllShortcutBindings();
  });
  it("keeps engines separate and exposes a strong selected state", assertGroupedConnectionSelection);
  it("collapses engine sections and persists the choice", assertEngineSectionCollapseToggle);
  it("keeps multiple connection drawers open independently", assertIndependentConnectionDrawers);
  it("toggles connection drawers on a single click", assertSingleClickConnectionToggle);
  it("opens global or connection-scoped table discovery", assertTableFinderEntryPoints);
  it("browses Redis keys and opens native key commands", assertRedisKeyBrowser);
  it("filters tables and opens them only on double click", assertTableSearchAndDoubleClickOpen);
  it("requests reviewed destructive table actions from its context menu", assertTableDestructiveContextMenu);
  it("keeps pinned tables at the top of their connection", assertPinnedTableOrdering);
  it("matches loaded catalog tables from the unified navigator search", assertUnifiedSearchMatchesCatalogTables);
  it("requests connection deletion from its context menu", assertContextMenuRequestsDeletion);
  it("navigates and expands connections from the keyboard", assertConnectionKeyboardNavigation);
  it("navigates and opens tables from the keyboard", assertTableKeyboardNavigation);
  it("focuses the unified navigator search with scoped find", assertScopedTableSearchShortcut);
  it("marks dirty tables and their owning connections", assertDirtyObjectIndicators);
  it("reports loaded tables for global discovery", assertLoadedTablesAreReported);
  it("loads table names for global discovery without expanding drawers", assertGlobalDiscoveryLoadsTables);
  it("limits scoped discovery to the requested connection", assertScopedDiscoveryLoadsOneConnection);
}

describe("ConnectionSidebar", registerConnectionSidebarTests);
