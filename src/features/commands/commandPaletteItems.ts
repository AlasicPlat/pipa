import type { CommandPaletteItem } from "./CommandPalette";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { Engine } from "../../bindings/Engine";
import type { ShortcutActionId } from "./shortcutRegistry";
import type { UtilityWorkspaceTab } from "../workspace/WorkspaceTabs";

/** One open query workspace, reduced to what the palette displays and searches. */
export interface PaletteQueryTab {
  /** Tab identifier. */
  id: string;
  /** Saved connection the tab executes against. */
  connectionId: string;
  /** Editor contents; a prefix is indexed as search keywords. */
  sqlText: string;
  /** Tab title shown as the palette label. */
  title: string;
}

/** One open table workspace, reduced to what the palette displays and searches. */
export interface PaletteTableTab {
  /** Tab identifier. */
  id: string;
  /** Saved connection that owns the table. */
  connectionId: string;
  /** Exact database-reported table name. */
  tableName: string;
  /** Tab title shown as the palette label. */
  title: string;
}

/** Everything {@link buildCommandPaletteItems} needs to enumerate the palette. */
export interface CommandPaletteItemsInput {
  /** Identifier of the active table workspace, when one is focused. */
  activeTableTabId: string | null;
  /** Identifier of the active utility workspace, when one is focused. */
  activeUtilityTabId: string | null;
  /** Identifier of the active query workspace, when one is focused. */
  activeQueryTabId: string | null;
  /** Connection backing the active query workspace, used to word engine-specific labels. */
  activeQueryProfile: ConnectionProfile | null | undefined;
  /** The one query tab currently executing, when any. */
  busyQueryTabId: string | null;
  /** Whether the binlog utility workspace is open. */
  binlogWorkspaceOpen: boolean;
  /** Static descriptor for the binlog utility tab. */
  binlogWorkspaceTab: UtilityWorkspaceTab;
  /** Whether the connection-manager utility workspace is open. */
  connectionManagerOpen: boolean;
  /** Static descriptor for the connection-manager utility tab. */
  connectionManagerTab: UtilityWorkspaceTab;
  /** Connection the new-query command would target, when one qualifies. */
  newQueryProfile: ConnectionProfile | null;
  /** Open table workspaces, in strip order. */
  openTableTabs: readonly PaletteTableTab[];
  /** Open utility workspaces, used only for the total tab count. */
  openUtilityTabCount: number;
  /** Every saved connection profile. */
  profiles: readonly ConnectionProfile[];
  /** Open query workspaces, in strip order. */
  queryTabs: readonly PaletteQueryTab[];
  /** Session-local last-used timestamps, keyed by palette item id. */
  recentItemTimestamps: Readonly<Record<string, number>>;
  /** Connection the navigator has in focus, which gates connection-scoped commands. */
  selectedProfile: ConnectionProfile | null | undefined;
  /** Whether the connection sidebar is collapsed, which flips the toggle label. */
  sidebarCollapsed: boolean;
  /** Formats one action's current key binding for the item detail line. */
  shortcutLabel: (actionId: ShortcutActionId) => string;
  /** Table names per connection, then per schema. */
  tableCatalog: Readonly<Record<string, Record<string, string[]>>>;
}

/**
 * Builds the command-palette identity for one table inside one database.
 *
 * A NUL separator keeps the parts unambiguous even when a schema or table name contains a colon.
 * @param connectionId - Saved connection identifier.
 * @param database - Schema that owns the table.
 * @param tableName - Exact database-reported table name.
 * @returns A stable palette item identifier.
 */
export function paletteTableItemId(
  connectionId: string,
  database: string,
  tableName: string,
): string {
  return `table:${connectionId}\u0000${database}\u0000${tableName}`;
}

/**
 * Parses one palette table identity back into its parts.
 * @param itemId - Identifier produced by {@link paletteTableItemId}.
 * @returns The connection, database, and table, or null when the identity is malformed.
 */
export function parsePaletteTableItemId(
  itemId: string,
): { connectionId: string; database: string; tableName: string } | null {
  const [connectionId, database, tableName] = itemId.slice("table:".length).split("\u0000");
  return connectionId && database && tableName
    ? { connectionId, database, tableName }
    : null;
}

/** Returns the display/search label for one supported database engine. */
export function connectionEngineLabel(engine: Engine): string {
  return {
    my_sql: "MySQL",
    postgre_sql: "PostgreSQL",
    mongo_db: "MongoDB",
    redis: "Redis",
  }[engine];
}

/** Returns connection metadata fields shared by global object and workspace search. */
export function connectionSearchTerms(profile: ConnectionProfile | undefined): string[] {
  if (!profile) return [];
  const environment = {
    production: "生产",
    development: "开发",
    unspecified: "未指定",
  }[profile.environment];
  return [
    profile.name,
    connectionEngineLabel(profile.engine),
    profile.host,
    `${profile.host}:${profile.port}`,
    String(profile.port),
    profile.username,
    profile.database ?? "",
    profile.environment,
    environment,
  ];
}

/** Formats the compact connection identity displayed in global search results. */
export function connectionPaletteDetail(profile: ConnectionProfile): string {
  return `${connectionEngineLabel(profile.engine)} · ${profile.database ?? "未指定数据库"} · ${profile.host}:${profile.port}`;
}

/**
 * Enumerates every command, connection, table, and workspace the palette can act on.
 *
 * This walks every table in `tableCatalog` — every connection, every schema — allocating one item
 * per table, measured at 10.7 ms for 15k tables and 32 ms for 50k. Callers should only invoke it
 * while the palette is open and should memoize the result.
 * @param input - Read-only snapshot of shell state the palette surfaces.
 * @returns Palette items in priority order: commands, connections, tables, then workspaces.
 */
export function buildCommandPaletteItems(
  input: CommandPaletteItemsInput,
): CommandPaletteItem[] {
  const {
    activeQueryProfile,
    activeQueryTabId,
    activeTableTabId,
    activeUtilityTabId,
    binlogWorkspaceOpen,
    binlogWorkspaceTab,
    busyQueryTabId,
    connectionManagerOpen,
    connectionManagerTab,
    newQueryProfile,
    openTableTabs,
    openUtilityTabCount,
    profiles,
    queryTabs,
    recentItemTimestamps,
    selectedProfile,
    shortcutLabel,
    sidebarCollapsed,
    tableCatalog,
  } = input;
  const isRedisQuery = activeQueryProfile?.engine === "redis";
  return [
    {
      id: "command:add-connection",
      type: "command",
      label: "添加数据库连接",
      detail: "选择 MySQL 或 Redis",
      keywords: ["新建连接", "mysql", "redis"],
      lastUsedAt: recentItemTimestamps["command:add-connection"],
    },
    {
      id: "command:open-mcp",
      type: "command",
      label: "打开 MCP 控制台",
      detail: "启停 MCP、查看执行日志并确认写 SQL",
      keywords: ["mcp", "ai", "只读", "propose"],
      lastUsedAt: recentItemTimestamps["command:open-mcp"],
    },
    {
      id: "command:open-connection-manager",
      type: "command",
      label: "打开连接管理",
      detail: connectionManagerOpen ? "切换到已打开的连接管理" : "编辑连接配置、浏览与新建数据库",
      keywords: ["connection", "database", "连接管理", "数据库管理", "配置", "建库"],
      lastUsedAt: recentItemTimestamps["command:open-connection-manager"],
    },
    {
      id: "command:open-binlog",
      type: "command",
      label: "打开 Binlog 分析",
      detail: binlogWorkspaceOpen ? "切换到已打开的独立日志工作区" : "导入并分析本地 MySQL Binlog",
      keywords: ["binlog", "binary log", "时间线", "日志", "恢复"],
      lastUsedAt: recentItemTimestamps["command:open-binlog"],
    },
    {
      id: "command:shortcut-help",
      type: "command",
      label: "打开快捷键帮助",
      detail: `搜索全部键盘操作 · ${shortcutLabel("shortcutHelp")}`,
      keywords: ["keyboard", "hotkey", "帮助"],
      lastUsedAt: recentItemTimestamps["command:shortcut-help"],
    },
    {
      id: "command:shortcut-settings",
      type: "command",
      label: "打开快捷键设置",
      detail: "修改组合键、检查冲突或恢复默认",
      keywords: ["keyboard", "hotkey", "偏好", "修改"],
      lastUsedAt: recentItemTimestamps["command:shortcut-settings"],
    },
    {
      id: "command:toggle-sidebar",
      type: "command",
      label: sidebarCollapsed ? "展开连接侧边栏" : "收起连接侧边栏",
      detail: shortcutLabel("toggleSidebar"),
      keywords: ["sidebar", "收起", "展开", "panel"],
      lastUsedAt: recentItemTimestamps["command:toggle-sidebar"],
    },
    ...(selectedProfile?.engine === "my_sql" ? [{
      id: "command:create-database",
      type: "command" as const,
      label: "新建数据库",
      detail: `在连接 ${selectedProfile.name} 上执行 CREATE DATABASE`,
      keywords: ["create database", "建库", "schema", "数据库"],
      connectionId: selectedProfile.id,
      lastUsedAt: recentItemTimestamps["command:create-database"],
    }] : []),
    ...(newQueryProfile ? [{
      id: "command:new-query",
      type: "command" as const,
      label: newQueryProfile.engine === "redis" ? "新建 Redis 工作区" : "新建 SQL 查询",
      detail: shortcutLabel("newQuery"),
      keywords: ["query", newQueryProfile.engine === "redis" ? "redis" : "sql"],
      lastUsedAt: recentItemTimestamps["command:new-query"],
    }] : []),
    ...((activeUtilityTabId || activeTableTabId || activeQueryTabId) ? [{
      id: "command:close-workspace",
      type: "command" as const,
      label: "关闭当前工作区",
      detail: shortcutLabel("closeWorkspace"),
      keywords: ["close", "关闭标签"],
      lastUsedAt: recentItemTimestamps["command:close-workspace"],
    }] : []),
    ...(queryTabs.length + openTableTabs.length + openUtilityTabCount > 1 ? [
      {
        id: "command:next-workspace",
        type: "command" as const,
        label: "下一个工作区",
        detail: shortcutLabel("nextWorkspace"),
        keywords: ["next", "切换标签"],
        lastUsedAt: recentItemTimestamps["command:next-workspace"],
      },
      {
        id: "command:previous-workspace",
        type: "command" as const,
        label: "上一个工作区",
        detail: shortcutLabel("previousWorkspace"),
        keywords: ["previous", "切换标签"],
        lastUsedAt: recentItemTimestamps["command:previous-workspace"],
      },
    ] : []),
    ...(activeUtilityTabId === null && activeTableTabId === null && activeQueryTabId ? [
      {
        id: "command:execute-sql",
        type: "command" as const,
        label: isRedisQuery ? "刷新 / 执行 Redis 工作区" : "执行当前 SQL",
        detail: shortcutLabel("executeQuery"),
        keywords: ["run", "查询"],
        lastUsedAt: recentItemTimestamps["command:execute-sql"],
      },
      {
        id: "command:select-sql",
        type: "command" as const,
        label: isRedisQuery ? "选中当前 Redis 命令" : "选中当前 SQL",
        detail: shortcutLabel("selectSql"),
        keywords: ["select", "全选 sql"],
        lastUsedAt: recentItemTimestamps["command:select-sql"],
      },
      {
        id: "command:find-current",
        type: "command" as const,
        label: isRedisQuery ? "查找当前 Redis 工作区" : "查找当前 SQL",
        detail: shortcutLabel("find"),
        keywords: ["search", "查找文本"],
        lastUsedAt: recentItemTimestamps["command:find-current"],
      },
      ...(busyQueryTabId === activeQueryTabId ? [{
        id: "command:cancel-query",
        type: "command" as const,
        label: "取消当前查询",
        detail: shortcutLabel("cancelQuery"),
        keywords: ["stop", "停止"],
        lastUsedAt: recentItemTimestamps["command:cancel-query"],
      }] : []),
    ] : []),
    ...(activeUtilityTabId !== null && busyQueryTabId ? [{
      id: "command:cancel-query",
      type: "command" as const,
      label: "取消后台查询",
      detail: shortcutLabel("cancelQuery"),
      keywords: ["stop", "停止", "后台查询"],
      lastUsedAt: recentItemTimestamps["command:cancel-query"],
    }] : []),
    ...(activeUtilityTabId === null && activeTableTabId ? [
      {
        id: "command:find-current",
        type: "command" as const,
        label: "查找当前页数据",
        detail: shortcutLabel("find"),
        keywords: ["search", "过滤"],
        lastUsedAt: recentItemTimestamps["command:find-current"],
      },
      {
        id: "command:select-current-page",
        type: "command" as const,
        label: "选择当前页全部行",
        detail: shortcutLabel("selectRows"),
        keywords: ["全选", "rows"],
        lastUsedAt: recentItemTimestamps["command:select-current-page"],
      },
      {
        id: "command:save-table-changes",
        type: "command" as const,
        label: "提交表变更",
        detail: shortcutLabel("saveTable"),
        keywords: ["save", "ddl", "dml"],
        lastUsedAt: recentItemTimestamps["command:save-table-changes"],
      },
    ] : []),
    ...profiles.map((profile) => ({
      id: `connection:${profile.id}`,
      type: "connection" as const,
      label: profile.name,
      detail: connectionPaletteDetail(profile),
      keywords: connectionSearchTerms(profile),
      connectionId: profile.id,
      lastUsedAt: recentItemTimestamps[`connection:${profile.id}`],
    })),
    ...Object.entries(tableCatalog).flatMap(([connectionId, tablesByDatabase]) => {
      const profile = profiles.find((item) => item.id === connectionId);
      return profile
        ? Object.entries(tablesByDatabase).flatMap(([database, tableNames]) => (
          tableNames.map((tableName) => ({
            id: paletteTableItemId(connectionId, database, tableName),
            type: "table" as const,
            label: tableName,
            database,
            detail: `${profile.name} · ${database} · ${profile.host}:${profile.port}`,
            keywords: [database, ...connectionSearchTerms(profile)],
            connectionId,
            lastUsedAt: recentItemTimestamps[paletteTableItemId(connectionId, database, tableName)],
          }))
        ))
        : [];
    }),
    ...queryTabs.map((tab) => {
      const profile = profiles.find((item) => item.id === tab.connectionId);
      return {
        id: `workspace:query:${tab.id}`,
        type: "workspace" as const,
        label: tab.title,
        detail: profile ? `${profile.name} · ${profile.host}:${profile.port}` : "连接不可用",
        keywords: [tab.sqlText.slice(0, 160), "SQL 查询", ...connectionSearchTerms(profile)],
        connectionId: tab.connectionId,
        lastUsedAt: recentItemTimestamps[`workspace:query:${tab.id}`],
      };
    }),
    ...openTableTabs.map((tab) => {
      const profile = profiles.find((item) => item.id === tab.connectionId);
      return {
        id: `workspace:table:${tab.id}`,
        type: "workspace" as const,
        label: tab.title,
        detail: profile ? `${profile.name} · ${profile.host}:${profile.port}` : "表工作区",
        keywords: [tab.tableName, ...connectionSearchTerms(profile)],
        connectionId: tab.connectionId,
        lastUsedAt: recentItemTimestamps[`workspace:table:${tab.id}`],
      };
    }),
    ...(connectionManagerOpen ? [{
      id: `workspace:utility:${connectionManagerTab.id}`,
      type: "workspace" as const,
      label: connectionManagerTab.title,
      detail: "管理连接配置与数据库",
      keywords: ["connection", "database", "连接", "数据库", "配置"],
      lastUsedAt: recentItemTimestamps[`workspace:utility:${connectionManagerTab.id}`],
    }] : []),
    ...(binlogWorkspaceOpen ? [{
      id: `workspace:utility:${binlogWorkspaceTab.id}`,
      type: "workspace" as const,
      label: binlogWorkspaceTab.title,
      detail: "独立 Binlog 工作区",
      keywords: ["binlog", "binary log", "时间线", "日志"],
      lastUsedAt: recentItemTimestamps[`workspace:utility:${binlogWorkspaceTab.id}`],
    }] : []),
  ];
}
