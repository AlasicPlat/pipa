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

/** Table rows returned by `SHOW FULL TABLES` for the focused schema. */
const TABLE_ROWS = [
  [{ kind: "text" as const, value: "orders" }, { kind: "text" as const, value: "BASE TABLE" }],
  [{ kind: "text" as const, value: "customers" }, { kind: "text" as const, value: "BASE TABLE" }],
];

/** Renders the navigator with overridable props. */
function renderSidebar(overrides: Partial<Parameters<typeof ConnectionSidebar>[0]> = {}) {
  const props = {
    profiles: MYSQL_CONNECTIONS,
    selectedConnectionId: MYSQL_CONNECTIONS[0].id,
    onAddConnection: vi.fn(),
    ...overrides,
  };
  return { ...render(<ConnectionSidebar {...props} />), props };
}

/**
 * Verifies the navigator lists only the focused connection's tables, with no connection rows.
 *
 * This is the point of the single-focus navigator: the user's attention stays on the objects they
 * are working with, and choosing a connection happens elsewhere.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the sidebar.
 */
function assertFocusedConnectionObjectsOnly(): void {
  tableSession.state.rows = TABLE_ROWS;
  renderSidebar();

  expect(tableSession.run).toHaveBeenCalledWith("SHOW FULL TABLES FROM `orders`;");
  expect(screen.getAllByRole("treeitem").map((row) => row.getAttribute("data-table-name")))
    .toEqual(["orders", "customers"]);
  // The other saved connection must not appear: it is not what the user is looking at.
  expect(screen.queryByText("本地开发")).not.toBeInTheDocument();
  expect(document.querySelector(".connection-row")).toBeNull();
  expect(document.querySelector(".engine-section")).toBeNull();
}

/** Verifies switching the focused connection replaces the listed objects. */
function assertFocusFollowsSelectedConnection(): void {
  tableSession.state.rows = TABLE_ROWS;
  const { rerender, props } = renderSidebar();

  expect(screen.getAllByRole("treeitem")).toHaveLength(2);

  tableSession.run.mockClear();
  rerender(
    <ConnectionSidebar
      {...props}
      selectedConnectionId={MYSQL_CONNECTIONS[1].id}
      selectedDatabases={{ [MYSQL_CONNECTIONS[1].id]: "scratch" }}
    />,
  );

  expect(tableSession.run).toHaveBeenCalledWith("SHOW FULL TABLES FROM `scratch`;");
}

/** Verifies a connection without any schema selected asks for one instead of failing. */
function assertPromptsForDatabaseWhenNoneSelected(): void {
  tableSession.state.rows = [];
  renderSidebar({ selectedConnectionId: MYSQL_CONNECTIONS[1].id });

  expect(screen.getByText("请先选择一个数据库。")).toBeVisible();
  expect(screen.getByRole("button", { name: /数据库：未选择/u })).toBeVisible();
}

/** Verifies the navigator explains itself when no connection is in focus. */
function assertEmptyStates(): void {
  const { rerender, props } = renderSidebar({ profiles: [], selectedConnectionId: null });
  expect(screen.getByText("还没有保存任何连接。")).toBeVisible();
  expect(screen.getByRole("button", { name: /添加连接/u })).toBeVisible();

  rerender(<ConnectionSidebar {...props} profiles={MYSQL_CONNECTIONS} selectedConnectionId={null} />);
  expect(screen.getByText("请先在顶部选择一个连接。")).toBeVisible();
}

/** Verifies clicking one table opens it against the focused schema. */
function assertOpensTableWithItsSchema(): void {
  tableSession.state.rows = TABLE_ROWS;
  const openTable = vi.fn();
  renderSidebar({ onOpenTable: openTable });

  fireEvent.click(screen.getByRole("treeitem", { name: /customers/u }));

  expect(openTable).toHaveBeenCalledWith(MYSQL_CONNECTIONS[0].id, "orders", "customers");
}

/** Verifies table quick actions remain reachable from the row context menu. */
function assertTableContextMenu(): void {
  tableSession.state.rows = TABLE_ROWS;
  const requestTableAction = vi.fn();
  renderSidebar({ onRequestTableAction: requestTableAction });

  const row = screen.getByRole("treeitem", { name: /orders/u });
  fireEvent.contextMenu(row, { clientX: 90, clientY: 120 });
  fireEvent.click(screen.getByRole("menuitem", { name: "清空表…" }));

  expect(requestTableAction).toHaveBeenLastCalledWith(
    MYSQL_CONNECTIONS[0].id,
    "orders",
    "orders",
    "truncate",
  );
}

/** Verifies pinned tables sort ahead of the rest within the focused schema. */
function assertPinnedTableOrdering(): void {
  tableSession.state.rows = [
    [{ kind: "text", value: "customers" }, { kind: "text", value: "BASE TABLE" }],
    [{ kind: "text", value: "orders" }, { kind: "text", value: "BASE TABLE" }],
  ];
  renderSidebar({
    pinnedTableKeys: new Set([`${MYSQL_CONNECTIONS[0].id}\u0000orders\u0000orders`]),
  });

  const rows = screen.getAllByRole("treeitem");
  expect(rows.map((row) => row.getAttribute("data-table-name"))).toEqual(["orders", "customers"]);
  expect(rows[0]).toHaveTextContent("置顶");
}

/** Verifies dirty tables are marked so unsaved work is visible without opening the tab. */
function assertDirtyTableMarkers(): void {
  tableSession.state.rows = TABLE_ROWS;
  renderSidebar({
    dirtyTables: [{ connectionId: MYSQL_CONNECTIONS[0].id, tableName: "orders" }],
  });

  const row = screen.getByRole("treeitem", { name: /orders/u });
  expect(within(row).getByLabelText("orders 有未提交修改")).toBeInTheDocument();
}

/** Verifies objects already open as workspace tabs are marked in the list. */
function assertOpenObjectMarkers(): void {
  tableSession.state.rows = TABLE_ROWS;
  renderSidebar({
    openObjects: [{ connectionId: MYSQL_CONNECTIONS[0].id, objectName: "orders" }],
  });

  expect(screen.getByRole("treeitem", { name: /orders/u }).className).toContain("is-open");
  expect(screen.getByRole("treeitem", { name: /customers/u }).className).not.toContain("is-open");
}

/**
 * Verifies tables loaded from other schemas stay findable through search.
 *
 * The navigator lists one schema, so cross-schema hits are surfaced in their own section instead
 * of disappearing from search entirely.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the sidebar and types into its search box.
 */
function assertOtherSchemaSearchResults(): void {
  tableSession.state.rows = TABLE_ROWS;
  const openTable = vi.fn();
  renderSidebar({
    onOpenTable: openTable,
    tableCatalog: {
      [MYSQL_CONNECTIONS[0].id]: {
        orders: ["orders", "customers"],
        analytics: ["events_archive"],
      },
    },
  });

  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "archive" } });

  const section = screen.getByRole("region", { name: "其他数据库中的匹配表" });
  const hit = within(section).getByRole("button", { name: /events_archive/u });
  expect(hit).toHaveTextContent("analytics");

  fireEvent.click(hit);
  expect(openTable).toHaveBeenCalledWith(MYSQL_CONNECTIONS[0].id, "analytics", "events_archive");
}

/** Verifies the scoped find shortcut focuses the navigator search box. */
function assertScopedFindFocusesSearch(): void {
  expect(updateShortcutBinding("find", "Alt+K")).toBe(true);
  tableSession.state.rows = TABLE_ROWS;
  const { container } = renderSidebar();

  fireEvent.keyDown(container.querySelector(".connection-groups")!, { key: "k", altKey: true });

  expect(screen.getByRole("searchbox")).toHaveFocus();
}

/** Verifies arrow keys traverse the object list from a single Tab stop. */
function assertKeyboardTraversal(): void {
  tableSession.state.rows = TABLE_ROWS;
  renderSidebar();

  const [first, second] = screen.getAllByRole("treeitem");
  first!.focus();
  fireEvent.keyDown(first!, { key: "ArrowDown" });
  expect(second).toHaveFocus();

  fireEvent.keyDown(second!, { key: "ArrowUp" });
  expect(first).toHaveFocus();

  // Leaving the list returns to the search box, which is now the navigator's root.
  fireEvent.keyDown(first!, { key: "ArrowLeft" });
  expect(screen.getByRole("searchbox")).toHaveFocus();
}

/** Verifies the Redis explorer loads its databases without an expand step. */
async function assertRedisExplorer(): Promise<void> {
  executeQueryOnce.mockImplementation(async (_id: string, command: string) => (
    command === "INFO keyspace"
      ? {
        columns: [],
        affectedRows: 0,
        rows: [[{ kind: "text", value: "db0:keys=2,expires=0,avg_ttl=0" }]],
      }
      : { columns: [], affectedRows: 0, rows: [[{ kind: "text", value: "0" }, { kind: "text", value: "session:1" }]] }
  ));
  const openRedisKey = vi.fn();
  renderSidebar({
    profiles: [REDIS_CONNECTION],
    selectedConnectionId: REDIS_CONNECTION.id,
    onOpenRedisKey: openRedisKey,
  });

  const database = await screen.findByRole("treeitem", { name: /DB 0/u });
  fireEvent.click(database);

  const key = await screen.findByRole("treeitem", { name: /session:1/u });
  fireEvent.click(key);
  expect(openRedisKey).toHaveBeenCalledWith(REDIS_CONNECTION.id, "0", "session:1");
}

/** Verifies the database switcher lists visible schemas and switches the browsed one. */
async function assertDatabaseSwitcher(): Promise<void> {
  executeQueryOnce.mockImplementation(async (_connectionId: string, sql: string) => (
    sql.includes("INFORMATION_SCHEMA.SCHEMATA")
      ? {
        columns: [],
        affectedRows: 0,
        rows: [
          [{ kind: "text", value: "orders" }, { kind: "text", value: "utf8mb4" }, { kind: "text", value: "utf8mb4_bin" }],
          [{ kind: "text", value: "analytics" }, { kind: "text", value: "utf8mb4" }, { kind: "text", value: "utf8mb4_bin" }],
          [{ kind: "text", value: "mysql" }, { kind: "text", value: "utf8mb4" }, { kind: "text", value: "utf8mb4_bin" }],
        ],
      }
      : { columns: [], rows: [], affectedRows: 0 }
  ));
  const selectDatabase = vi.fn();
  tableSession.state.rows = TABLE_ROWS;
  renderSidebar({ onSelectDatabase: selectDatabase });

  fireEvent.click(screen.getByRole("button", { name: /数据库：orders/u }));
  const list = await screen.findByRole("listbox", { name: "订单主库 数据库" });
  expect(within(list).getAllByRole("option").map((option) => option.textContent))
    .toEqual(["analytics", "orders默认"]);

  // Server-managed schemas stay grouped behind a toggle rather than crowding the list.
  fireEvent.click(within(list).getByRole("button", { name: /系统库/u }));
  expect(within(list).getByRole("option", { name: "mysql" })).toBeVisible();

  fireEvent.click(within(list).getByRole("option", { name: "analytics" }));
  expect(selectDatabase).toHaveBeenCalledWith(MYSQL_CONNECTIONS[0].id, "analytics");
}

/** Verifies create-database is reachable from the switcher for MySQL connections. */
async function assertCreateDatabaseEntry(): Promise<void> {
  executeQueryOnce.mockResolvedValue({ columns: [], rows: [], affectedRows: 0 });
  const requestCreateDatabase = vi.fn();
  renderSidebar({
    selectedConnectionId: MYSQL_CONNECTIONS[1].id,
    onRequestCreateDatabase: requestCreateDatabase,
  });

  fireEvent.click(screen.getByRole("button", { name: /数据库：未选择/u }));
  fireEvent.click(await screen.findByRole("button", { name: "新建数据库…" }));

  expect(requestCreateDatabase).toHaveBeenCalledWith(MYSQL_CONNECTIONS[1]);
}

/** Verifies scoped table discovery is still reachable for the focused connection. */
function assertScopedTableDiscovery(): void {
  tableSession.state.rows = TABLE_ROWS;
  const findTables = vi.fn();
  renderSidebar({ onFindTables: findTables });

  fireEvent.click(screen.getByRole("button", { name: /在 订单主库 中查找数据表/u }));
  expect(findTables).toHaveBeenCalledWith(MYSQL_CONNECTIONS[0].id);

  fireEvent.click(screen.getByRole("button", { name: "查找表" }));
  expect(findTables).toHaveBeenLastCalledWith();
}

describe("ConnectionSidebar", () => {
  beforeEach(() => {
    tableSession.run.mockClear();
    tableSession.cancel.mockClear();
    tableSession.state.rows = [];
    tableSession.state.running = false;
    tableSession.state.error = null;
    tableSession.state.affectedRows = null;
    tableSession.state.queryId = null;
    executeQueryOnce.mockReset();
    executeQueryOnce.mockResolvedValue({ columns: [], rows: [], affectedRows: 0 });
    window.localStorage.clear();
    resetAllShortcutBindings();
  });
  afterEach(cleanup);

  it("lists only the focused connection's objects", assertFocusedConnectionObjectsOnly);
  it("follows the selected connection", assertFocusFollowsSelectedConnection);
  it("asks for a database when none is selected", assertPromptsForDatabaseWhenNoneSelected);
  it("explains both empty states", assertEmptyStates);
  it("opens a table against the focused schema", assertOpensTableWithItsSchema);
  it("keeps table quick actions on the row menu", assertTableContextMenu);
  it("sorts pinned tables first", assertPinnedTableOrdering);
  it("marks dirty tables", assertDirtyTableMarkers);
  it("marks objects already open as tabs", assertOpenObjectMarkers);
  it("surfaces matches from other schemas", assertOtherSchemaSearchResults);
  it("focuses search with the scoped find shortcut", assertScopedFindFocusesSearch);
  it("traverses the object list from one Tab stop", assertKeyboardTraversal);
  it("browses Redis databases and keys", assertRedisExplorer);
  it("switches the browsed database", assertDatabaseSwitcher);
  it("reaches create-database from the switcher", assertCreateDatabaseEntry);
  it("keeps global and scoped table discovery", assertScopedTableDiscovery);
});
