import { describe, expect, it } from "vitest";

import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { UtilityWorkspaceTab } from "../workspace/WorkspaceTabs";
import {
  buildCommandPaletteItems,
  connectionPaletteDetail,
  connectionSearchTerms,
  paletteTableItemId,
  parsePaletteTableItemId,
  type CommandPaletteItemsInput,
} from "./commandPaletteItems";

const mysqlProfile: ConnectionProfile = {
  id: "conn-1",
  name: "本地 MySQL",
  engine: "my_sql",
  environment: "development",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  database: "shop",
  tlsMode: "disabled",
};

const connectionManagerTab: UtilityWorkspaceTab = {
  id: "connection-manager",
  kind: "connections",
  title: "连接管理",
};

const binlogWorkspaceTab: UtilityWorkspaceTab = {
  id: "binlog-analysis",
  kind: "binlog",
  title: "Binlog 分析",
};

function buildInput(overrides: Partial<CommandPaletteItemsInput> = {}): CommandPaletteItemsInput {
  return {
    activeQueryProfile: null,
    activeQueryTabId: null,
    activeTableTabId: null,
    activeUtilityTabId: null,
    binlogWorkspaceOpen: false,
    binlogWorkspaceTab,
    busyQueryTabId: null,
    connectionManagerOpen: false,
    connectionManagerTab,
    newQueryProfile: null,
    openTableTabs: [],
    openUtilityTabCount: 0,
    profiles: [],
    queryTabs: [],
    recentItemTimestamps: {},
    selectedProfile: null,
    shortcutLabel: (actionId) => `键:${actionId}`,
    sidebarCollapsed: false,
    tableCatalog: {},
    ...overrides,
  };
}

describe("paletteTableItemId", () => {
  it("round-trips parts that contain a colon", () => {
    const id = paletteTableItemId("conn:1", "db:main", "orders:2024");
    expect(parsePaletteTableItemId(id)).toEqual({
      connectionId: "conn:1",
      database: "db:main",
      tableName: "orders:2024",
    });
  });

  it("rejects a malformed identity", () => {
    expect(parsePaletteTableItemId("table:conn-1")).toBeNull();
  });
});

describe("connection search metadata", () => {
  it("indexes host, port, and a localized environment", () => {
    expect(connectionSearchTerms(mysqlProfile)).toContain("127.0.0.1:3306");
    expect(connectionSearchTerms(mysqlProfile)).toContain("开发");
  });

  it("indexes nothing for a missing profile", () => {
    expect(connectionSearchTerms(undefined)).toEqual([]);
  });

  it("names the engine and falls back when no database is set", () => {
    expect(connectionPaletteDetail({ ...mysqlProfile, database: null }))
      .toBe("MySQL · 未指定数据库 · 127.0.0.1:3306");
  });
});

describe("buildCommandPaletteItems", () => {
  it("always offers the connection-independent commands", () => {
    const ids = buildCommandPaletteItems(buildInput()).map((item) => item.id);
    expect(ids).toContain("command:add-connection");
    expect(ids).toContain("command:open-mcp");
    expect(ids).not.toContain("command:create-database");
    expect(ids).not.toContain("command:close-workspace");
  });

  it("offers create-database only for a focused MySQL connection", () => {
    const withMysql = buildCommandPaletteItems(buildInput({ selectedProfile: mysqlProfile }));
    expect(withMysql.find((item) => item.id === "command:create-database")?.connectionId)
      .toBe("conn-1");
    const withRedis = buildCommandPaletteItems(buildInput({
      selectedProfile: { ...mysqlProfile, engine: "redis" },
    }));
    expect(withRedis.map((item) => item.id)).not.toContain("command:create-database");
  });

  it("flips the sidebar command label with the collapsed state", () => {
    const label = (collapsed: boolean): string | undefined =>
      buildCommandPaletteItems(buildInput({ sidebarCollapsed: collapsed }))
        .find((item) => item.id === "command:toggle-sidebar")?.label;
    expect(label(true)).toBe("展开连接侧边栏");
    expect(label(false)).toBe("收起连接侧边栏");
  });

  it("offers cancel-query for the active query tab only while it runs", () => {
    const base = { activeQueryTabId: "q1" } as const;
    expect(buildCommandPaletteItems(buildInput(base)).map((item) => item.id))
      .not.toContain("command:cancel-query");
    expect(buildCommandPaletteItems(buildInput({ ...base, busyQueryTabId: "q1" }))
      .find((item) => item.id === "command:cancel-query")?.label).toBe("取消当前查询");
  });

  it("offers background cancellation from a utility workspace", () => {
    const items = buildCommandPaletteItems(buildInput({
      activeUtilityTabId: "connection-manager",
      busyQueryTabId: "q1",
    }));
    expect(items.find((item) => item.id === "command:cancel-query")?.label).toBe("取消后台查询");
  });

  it("words query commands for Redis workspaces", () => {
    const items = buildCommandPaletteItems(buildInput({
      activeQueryProfile: { ...mysqlProfile, engine: "redis" },
      activeQueryTabId: "q1",
    }));
    expect(items.find((item) => item.id === "command:execute-sql")?.label)
      .toBe("刷新 / 执行 Redis 工作区");
  });

  it("offers tab cycling only once more than one workspace is open", () => {
    const single = buildCommandPaletteItems(buildInput({
      queryTabs: [{ id: "q1", connectionId: "conn-1", sqlText: "select 1", title: "查询 1" }],
    }));
    expect(single.map((item) => item.id)).not.toContain("command:next-workspace");
    const paired = buildCommandPaletteItems(buildInput({
      queryTabs: [{ id: "q1", connectionId: "conn-1", sqlText: "select 1", title: "查询 1" }],
      openUtilityTabCount: 1,
    }));
    expect(paired.map((item) => item.id)).toContain("command:next-workspace");
  });

  it("lists one table item per schema entry and carries recency", () => {
    const orders = paletteTableItemId("conn-1", "shop", "orders");
    const items = buildCommandPaletteItems(buildInput({
      profiles: [mysqlProfile],
      tableCatalog: { "conn-1": { shop: ["orders"], analytics: ["events"] } },
      recentItemTimestamps: { [orders]: 42 },
    }));
    const tables = items.filter((item) => item.type === "table");
    expect(tables).toHaveLength(2);
    const ordersItem = tables.find((item) => item.id === orders);
    expect(ordersItem?.database).toBe("shop");
    expect(ordersItem?.detail).toBe("本地 MySQL · shop · 127.0.0.1:3306");
    expect(ordersItem?.lastUsedAt).toBe(42);
  });

  it("skips tables whose connection no longer exists", () => {
    const items = buildCommandPaletteItems(buildInput({
      profiles: [],
      tableCatalog: { "conn-gone": { shop: ["orders"] } },
    }));
    expect(items.filter((item) => item.type === "table")).toEqual([]);
  });

  it("marks a query workspace whose connection was deleted", () => {
    const items = buildCommandPaletteItems(buildInput({
      queryTabs: [{ id: "q1", connectionId: "conn-gone", sqlText: "select 1", title: "查询 1" }],
    }));
    expect(items.find((item) => item.id === "workspace:query:q1")?.detail).toBe("连接不可用");
  });

  it("lists open utility workspaces", () => {
    const items = buildCommandPaletteItems(buildInput({
      binlogWorkspaceOpen: true,
      connectionManagerOpen: true,
    }));
    const ids = items.map((item) => item.id);
    expect(ids).toContain("workspace:utility:binlog-analysis");
    expect(ids).toContain("workspace:utility:connection-manager");
  });
});
