import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AlertTriangle, Braces, Command as CommandIcon, Copy, Database, FileClock, Keyboard, PanelLeft, Pencil, Plus, RotateCw, Server, Sparkles, Trash2 } from "lucide-react";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import type { Engine } from "../bindings/Engine";
import { BinlogWorkspace } from "../features/binlog/BinlogWorkspace";
import { CommandPalette, type CommandPaletteItem } from "../features/commands/CommandPalette";
import { ShortcutHelpDialog, type ShortcutDialogView } from "../features/commands/ShortcutHelpDialog";
import {
  getShortcutKeyLabels,
  matchesShortcut,
  shortcutToKeyboardEventInit,
  toTauriAccelerator,
  type ShortcutActionId,
  useShortcutSettings,
} from "../features/commands/shortcutRegistry";
import { handleScopedSelectAll } from "../features/commands/scopedSelectAll";
import { ConnectionForm } from "../features/connections/ConnectionForm";
import { ConnectionSidebar } from "../features/connections/ConnectionSidebar";
import { ConnectionTypePicker } from "../features/connections/ConnectionTypePicker";
import { useConnections } from "../features/connections/useConnections";
import { McpPanel } from "../features/mcp/McpPanel";
import { ThemeToggle } from "../features/preferences/ThemeToggle";
import { loadSidebarCollapsed, persistSidebarCollapsed } from "../features/preferences/sidebarLayout";
import { loadPinnedTables, persistPinnedTables } from "../features/preferences/pinnedTables";
import { useThemePreference } from "../features/preferences/theme";
import { QueryWorkspace } from "../features/query/QueryWorkspace";
import { executeQueryOnce } from "../features/query/executeQueryOnce";
import {
  cellValueToPlainText,
  downloadTextFile,
  serializeResultAsCsv,
  serializeRowsAsInsert,
  serializeSelectionAsJson,
} from "../features/query/resultExport";
import {
  useWorkspacePersistence,
  type WorkspaceTab,
} from "../features/query/useWorkspacePersistence";
import { RedisWorkspace } from "../features/redis/RedisWorkspace";
import { TableWorkspace } from "../features/tables/TableWorkspace";
import { SelectableSqlBlock } from "../features/tables/SelectableSqlBlock";
import {
  tableTargetKey,
  type TableDestructiveAction,
  type TableQuickAction,
} from "../features/tables/TableActionMenu";
import { quoteIdentifier } from "../features/tables/tableSql";
import { UpdateControl } from "../features/updater/UpdateControl";
import {
  WorkspaceTabs,
  type OpenTableTab,
  type UtilityWorkspaceTab,
  type WorkspaceDetachRequest,
} from "../features/workspace/WorkspaceTabs";
import {
  createDetachedWorkspaceWindow,
  MAIN_WORKSPACE_WINDOW_LABEL,
  readWorkspaceWindowContext,
  registerDetachedWorkspaceCloseHandler,
  restoreDetachedQueryWindow,
} from "../features/workspace/detachedWorkspace";
import {
  deleteConnection,
  listWorkspaceWindowLabels,
  reconnectConnection,
  renameConnection,
  setExecuteQueryAccelerator,
  transferWorkspaceTab,
} from "../lib/tauriClient";
import "./tokens.css";
import "./app.css";

const BINLOG_WORKSPACE_TAB: UtilityWorkspaceTab = {
  id: "binlog-analysis",
  kind: "binlog",
  title: "Binlog 分析",
};

interface PendingTableDestructiveAction {
  action: TableDestructiveAction;
  connectionId: string;
  tableName: string;
}

interface PendingTableNameAction {
  action: "rename" | "duplicate";
  connectionId: string;
  tableName: string;
}

interface TableDdlPreview {
  connectionId: string;
  error: string | null;
  loading: boolean;
  sql: string;
  tableName: string;
}

/** Returns a safe connection-deletion error message from an unknown IPC rejection. */
function getConnectionDeletionError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "删除失败。连接和相关数据均未从当前界面移除，请重试。";
}

/** Returns a safe message for a non-destructive connection action. */
function getConnectionActionError(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return fallback;
}

/**
 * Reports whether one engine owns an executable workspace in the current desktop slice.
 * @param engine - Stored database engine.
 * @returns `true` for MySQL SQL or Redis native commands.
 * Side effects: none.
 */
function matchesRunnableEngine(engine: Engine): engine is Extract<Engine, "my_sql" | "redis"> {
  return engine === "my_sql" || engine === "redis";
}

/** Returns the display/search label for one supported database engine. */
function connectionEngineLabel(engine: Engine): string {
  return {
    my_sql: "MySQL",
    postgre_sql: "PostgreSQL",
    mongo_db: "MongoDB",
    redis: "Redis",
  }[engine];
}

/** Returns connection metadata fields shared by global object and workspace search. */
function connectionSearchTerms(profile: ConnectionProfile | undefined): string[] {
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
function connectionPaletteDetail(profile: ConnectionProfile): string {
  return `${connectionEngineLabel(profile.engine)} · ${profile.database ?? "未指定数据库"} · ${profile.host}:${profile.port}`;
}

/**
 * Quotes one Redis key for the command editor without changing its UTF-8 content.
 * @param value - Key name returned by Redis SCAN.
 * @returns Double-quoted redis-cli argument with control characters escaped.
 * Side effects: none.
 */
function quoteRedisArgument(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, "\\\"")
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")}"`;
}

/**
 * Recovers the Redis database embedded in a persisted key-workspace title.
 * @param title - Persisted workspace title created by the Redis navigator.
 * @returns The logical database number, or `null` for generic workspaces.
 * Side effects: none.
 */
function redisDatabaseFromWorkspaceTitle(title: string): string | null {
  return title.match(/ · DB (\d+) · /u)?.[1] ?? null;
}

/**
 * 解析持久化查询工作区执行时使用的连接配置。
 * @param profile - 标签页引用的已保存非敏感配置。
 * @param tab - 持久化查询工作区；其标题中可能编码了 Redis 数据库。
 * @param selectedRedisDatabases - 按连接记录的当前导航器数据库选择。
 * @returns 带 Redis 数据库上下文的可执行配置；不可用时返回 `null`。
 * 副作用：无。
 */
function resolveQueryWorkspaceProfile(
  profile: ConnectionProfile | undefined,
  tab: WorkspaceTab | null,
  selectedRedisDatabases: Readonly<Record<string, string>>,
): ConnectionProfile | null {
  if (!profile || !tab || !matchesRunnableEngine(profile.engine)) {
    return null;
  }
  if (profile.engine !== "redis") {
    return profile;
  }
  return {
    ...profile,
    database: selectedRedisDatabases[profile.id]
      ?? redisDatabaseFromWorkspaceTitle(tab.title)
      ?? profile.database
      ?? "0",
  };
}

/**
 * Composes the connection-management shell around feature-owned connection state.
 * Parameters: none.
 * @returns The React element for the persistent Pipa workspace.
 * Side effects: loads non-secret connection profiles through `useConnections` after mounting.
 */
export function App() {
  const connections = useConnections();
  const [workspaceWindowContext] = useState(readWorkspaceWindowContext);
  const queryWorkspace = useWorkspacePersistence(workspaceWindowContext.windowLabel);
  const theme = useThemePreference();
  const shortcuts = useShortcutSettings();
  const detachedTableTab = workspaceWindowContext.descriptor?.kind === "table"
    ? workspaceWindowContext.descriptor
    : null;
  const [isAddingConnection, setIsAddingConnection] = useState(false);
  const [connectionFormEngine, setConnectionFormEngine] = useState<Extract<Engine, "my_sql" | "redis"> | null>(null);
  const [openTableTabs, setOpenTableTabs] = useState<OpenTableTab[]>(() => detachedTableTab
    ? [{
      id: detachedTableTab.id,
      connectionId: detachedTableTab.connectionId,
      tableName: detachedTableTab.tableName,
      title: detachedTableTab.title,
    }]
    : []);
  const [activeTableTabId, setActiveTableTabId] = useState<string | null>(detachedTableTab?.id ?? null);
  const [binlogWorkspaceOpen, setBinlogWorkspaceOpen] = useState(false);
  const [activeUtilityTabId, setActiveUtilityTabId] = useState<string | null>(null);
  const [busyQueryTabId, setBusyQueryTabId] = useState<string | null>(null);
  const [dirtyTableTabIds, setDirtyTableTabIds] = useState<Set<string>>(new Set());
  const [pendingCloseTableId, setPendingCloseTableId] = useState<string | null>(null);
  const [pendingTableAction, setPendingTableAction] = useState<PendingTableDestructiveAction | null>(null);
  const [pendingTableNameAction, setPendingTableNameAction] = useState<PendingTableNameAction | null>(null);
  const [tableNameDraft, setTableNameDraft] = useState("");
  const [duplicateTableData, setDuplicateTableData] = useState(true);
  const [executingTableNameAction, setExecutingTableNameAction] = useState(false);
  const [tableNameActionError, setTableNameActionError] = useState<string | null>(null);
  const [tableDdlPreview, setTableDdlPreview] = useState<TableDdlPreview | null>(null);
  const [pinnedTableKeys, setPinnedTableKeys] = useState(loadPinnedTables);
  const [runningTableUtilityAction, setRunningTableUtilityAction] = useState(false);
  const [tableActionError, setTableActionError] = useState<string | null>(null);
  const [executingTableAction, setExecutingTableAction] = useState(false);
  const [tableCatalogRefreshVersions, setTableCatalogRefreshVersions] = useState<Record<string, number>>({});
  const [deleteCandidate, setDeleteCandidate] = useState<ConnectionProfile | null>(null);
  const [deletingConnectionId, setDeletingConnectionId] = useState<string | null>(null);
  const [connectionDeletionError, setConnectionDeletionError] = useState<string | null>(null);
  const [deletionNotice, setDeletionNotice] = useState<string | null>(null);
  const [connectionActionError, setConnectionActionError] = useState<string | null>(null);
  const [renameCandidate, setRenameCandidate] = useState<ConnectionProfile | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingConnectionId, setRenamingConnectionId] = useState<string | null>(null);
  const [reconnectingConnectionId, setReconnectingConnectionId] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteConnectionId, setCommandPaletteConnectionId] = useState<string | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [shortcutDialogView, setShortcutDialogView] = useState<ShortcutDialogView>("help");
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const [focusConnectionId, setFocusConnectionId] = useState<string | null>(null);
  const [tableCatalog, setTableCatalog] = useState<Record<string, string[]>>({});
  const [selectedRedisDatabases, setSelectedRedisDatabases] = useState<Record<string, string>>({});
  const [recentItemTimestamps, setRecentItemTimestamps] = useState<Record<string, number>>({});
  const [detachingWorkspaceId, setDetachingWorkspaceId] = useState<string | null>(null);
  const paletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const detachedWindowRestoreStartedRef = useRef(false);

  // Only the main window recreates detached labels that still own persisted query tabs.
  useEffect(() => {
    if (
      !isTauri()
      || workspaceWindowContext.windowLabel !== MAIN_WORKSPACE_WINDOW_LABEL
      || detachedWindowRestoreStartedRef.current
    ) {
      return;
    }
    detachedWindowRestoreStartedRef.current = true;
    void listWorkspaceWindowLabels()
      .then(async (windowLabels) => {
        await Promise.all(windowLabels.map(restoreDetachedQueryWindow));
      })
      .catch((error: unknown) => {
        console.error("Pipa detached workspace restore failed", error);
        setConnectionActionError("部分独立工作窗口无法恢复，请重新拖出对应工作区。");
      });
  }, [workspaceWindowContext.windowLabel]);

  // A non-empty detached label drives restart restoration, so manual close must clear it first.
  useEffect(() => {
    if (
      !isTauri()
      || workspaceWindowContext.windowLabel === MAIN_WORKSPACE_WINDOW_LABEL
    ) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void registerDetachedWorkspaceCloseHandler(
      queryWorkspace.discardWorkspace,
      (error: unknown) => {
        console.error("Pipa detached workspace close failed", error);
        setConnectionActionError(getConnectionActionError(
          error,
          "无法关闭独立工作窗口，请重试。",
        ));
      },
    )
      .then((registeredUnlisten) => {
        if (disposed) {
          registeredUnlisten();
          return;
        }
        unlisten = registeredUnlisten;
      })
      .catch((error: unknown) => {
        console.error("Pipa detached workspace close listener failed", error);
        setConnectionActionError("无法监听独立工作窗口关闭事件，请重试。");
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryWorkspace.discardWorkspace, workspaceWindowContext.windowLabel]);

  const selectedProfile = connections.profiles.find(
    (profile) => profile.id === connections.selectedConnectionId,
  );
  const activeQueryProfile = connections.profiles.find(
    (profile) => profile.id === queryWorkspace.activeTab?.connectionId,
  );
  const activeQueryWorkspaceProfile = resolveQueryWorkspaceProfile(
    activeQueryProfile,
    queryWorkspace.activeTab,
    selectedRedisDatabases,
  );
  const activeTableTab = openTableTabs.find((tab) => tab.id === activeTableTabId);
  const pendingCloseTable = openTableTabs.find((tab) => tab.id === pendingCloseTableId) ?? null;
  const pendingTableActionProfile = pendingTableAction
    ? connections.profiles.find((profile) => profile.id === pendingTableAction.connectionId) ?? null
    : null;
  const pendingTableNameActionProfile = pendingTableNameAction
    ? connections.profiles.find((profile) => profile.id === pendingTableNameAction.connectionId) ?? null
    : null;
  const pendingTableActionTabId = pendingTableAction
    ? `${pendingTableAction.connectionId}:${pendingTableAction.tableName}`
    : null;
  const pendingTableActionHasDirtyWorkspace = pendingTableActionTabId
    ? dirtyTableTabIds.has(pendingTableActionTabId)
    : false;
  const pendingTableNameActionHasDirtyWorkspace = pendingTableNameAction
    ? dirtyTableTabIds.has(`${pendingTableNameAction.connectionId}:${pendingTableNameAction.tableName}`)
    : false;
  const dirtyTables = openTableTabs
    .filter((tab) => dirtyTableTabIds.has(tab.id))
    .map((tab) => ({ connectionId: tab.connectionId, tableName: tab.tableName }));
  const activeTableProfile = connections.profiles.find((profile) => profile.id === activeTableTab?.connectionId);
  const isBinlogWorkspaceActive = binlogWorkspaceOpen
    && activeUtilityTabId === BINLOG_WORKSPACE_TAB.id;
  const workspaceContextProfile = isBinlogWorkspaceActive
    ? null
    : activeTableProfile
      ?? activeQueryWorkspaceProfile
      ?? selectedProfile
      ?? null;
  const newQueryProfile = selectedProfile
    ? matchesRunnableEngine(selectedProfile.engine) ? selectedProfile : null
    : activeTableProfile?.engine === "my_sql"
      ? activeTableProfile
      : activeQueryProfile && matchesRunnableEngine(activeQueryProfile.engine)
        ? activeQueryProfile
        : null;
  const hasUsableWorkspace = binlogWorkspaceOpen
    || openTableTabs.length > 0
    || Boolean(queryWorkspace.activeTab && activeQueryProfile && matchesRunnableEngine(activeQueryProfile.engine));
  const deleteCandidateWorkspaceCount = deleteCandidate
    ? queryWorkspace.tabs.filter((tab) => tab.connectionId === deleteCandidate.id).length
      + openTableTabs.filter((tab) => tab.connectionId === deleteCandidate.id).length
    : 0;
  const deleteBlockedByRunningQuery = Boolean(
    deleteCandidate
      && busyQueryTabId
      && queryWorkspace.tabs.some(
        (tab) => tab.id === busyQueryTabId && tab.connectionId === deleteCandidate.id,
      ),
  );
  /** Formats one current binding for compact command and toolbar hints. */
  const shortcutLabel = (actionId: ShortcutActionId): string =>
    getShortcutKeyLabels(shortcuts.bindings[actionId]).join(" + ");
  const commandPaletteItems: CommandPaletteItem[] = [
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
    ...(newQueryProfile ? [{
      id: "command:new-query",
      type: "command" as const,
      label: newQueryProfile.engine === "redis" ? "新建 Redis 工作区" : "新建 SQL 查询",
      detail: shortcutLabel("newQuery"),
      keywords: ["query", newQueryProfile.engine === "redis" ? "redis" : "sql"],
      lastUsedAt: recentItemTimestamps["command:new-query"],
    }] : []),
    ...((activeUtilityTabId || activeTableTabId || queryWorkspace.activeTabId) ? [{
      id: "command:close-workspace",
      type: "command" as const,
      label: "关闭当前工作区",
      detail: shortcutLabel("closeWorkspace"),
      keywords: ["close", "关闭标签"],
      lastUsedAt: recentItemTimestamps["command:close-workspace"],
    }] : []),
    ...(queryWorkspace.tabs.length + openTableTabs.length + (binlogWorkspaceOpen ? 1 : 0) > 1 ? [
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
    ...(activeUtilityTabId === null && activeTableTabId === null && queryWorkspace.activeTabId ? [
      {
        id: "command:execute-sql",
        type: "command" as const,
        label: activeQueryProfile?.engine === "redis" ? "刷新 / 执行 Redis 工作区" : "执行当前 SQL",
        detail: shortcutLabel("executeQuery"),
        keywords: ["run", "查询"],
        lastUsedAt: recentItemTimestamps["command:execute-sql"],
      },
      {
        id: "command:select-sql",
        type: "command" as const,
        label: activeQueryProfile?.engine === "redis" ? "选中当前 Redis 命令" : "选中当前 SQL",
        detail: shortcutLabel("selectSql"),
        keywords: ["select", "全选 sql"],
        lastUsedAt: recentItemTimestamps["command:select-sql"],
      },
      {
        id: "command:find-current",
        type: "command" as const,
        label: activeQueryProfile?.engine === "redis" ? "查找当前 Redis 工作区" : "查找当前 SQL",
        detail: shortcutLabel("find"),
        keywords: ["search", "查找文本"],
        lastUsedAt: recentItemTimestamps["command:find-current"],
      },
      ...(busyQueryTabId === queryWorkspace.activeTabId ? [{
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
    ...connections.profiles.map((profile) => ({
      id: `connection:${profile.id}`,
      type: "connection" as const,
      label: profile.name,
      detail: connectionPaletteDetail(profile),
      keywords: connectionSearchTerms(profile),
      connectionId: profile.id,
      lastUsedAt: recentItemTimestamps[`connection:${profile.id}`],
    })),
    ...Object.entries(tableCatalog).flatMap(([connectionId, tableNames]) => {
      const profile = connections.profiles.find((item) => item.id === connectionId);
      return profile ? tableNames.map((tableName) => ({
        id: `table:${connectionId}:${tableName}`,
        type: "table" as const,
        label: tableName,
        detail: `${profile.name} · ${profile.database ?? "未指定数据库"} · ${profile.host}:${profile.port}`,
        keywords: connectionSearchTerms(profile),
        connectionId,
        lastUsedAt: recentItemTimestamps[`table:${connectionId}:${tableName}`],
      })) : [];
    }),
    ...queryWorkspace.tabs.map((tab) => {
      const profile = connections.profiles.find((item) => item.id === tab.connectionId);
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
      const profile = connections.profiles.find((item) => item.id === tab.connectionId);
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
    ...(binlogWorkspaceOpen ? [{
      id: `workspace:utility:${BINLOG_WORKSPACE_TAB.id}`,
      type: "workspace" as const,
      label: BINLOG_WORKSPACE_TAB.title,
      detail: "独立 Binlog 工作区",
      keywords: ["binlog", "binary log", "时间线", "日志"],
      lastUsedAt: recentItemTimestamps[`workspace:utility:${BINLOG_WORKSPACE_TAB.id}`],
    }] : []),
  ];

  /**
   * Adds and selects the saved profile before returning to the connection overview.
   * @param profile - Backend-confirmed non-secret profile.
   * @returns Nothing (`void`).
   * Side effects: updates connection state and closes the add form.
   */
  function handleConnectionSaved(profile: ConnectionProfile): void {
    connections.addProfile(profile);
    if (
      !queryWorkspace.loading &&
      !queryWorkspace.recoveryBlocked &&
      queryWorkspace.tabs.length === 0 &&
      profile.engine === "my_sql"
    ) {
      queryWorkspace.addTab(
        profile.id,
        "查询 1",
        "SELECT 1;",
      );
    }
    setIsAddingConnection(false);
    setConnectionFormEngine(null);
  }

  /** Records session-local object recency without persisting connection metadata outside the encrypted store. */
  function markPaletteItemRecent(itemId: string): void {
    setRecentItemTimestamps((current) => ({ ...current, [itemId]: Date.now() }));
  }

  /**
   * Opens or reactivates the singleton Binlog workspace without selecting a database connection.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: cancels an unfinished connection form and updates session-local workspace state.
   */
  function handleOpenBinlogWorkspace(): void {
    setIsAddingConnection(false);
    setConnectionFormEngine(null);
    setBinlogWorkspaceOpen(true);
    setActiveUtilityTabId(BINLOG_WORKSPACE_TAB.id);
    markPaletteItemRecent(`workspace:utility:${BINLOG_WORKSPACE_TAB.id}`);
  }

  /**
   * Activates an already-open connection-independent utility workspace.
   * @param tabId - Utility workspace identifier from the shared tab strip.
   * @returns Nothing (`void`).
   * Side effects: updates only the active utility identity and session-local recency.
   */
  function handleSelectUtilityTab(tabId: string): void {
    if (!binlogWorkspaceOpen || tabId !== BINLOG_WORKSPACE_TAB.id) {
      return;
    }
    setActiveUtilityTabId(tabId);
    markPaletteItemRecent(`workspace:utility:${tabId}`);
  }

  /**
   * Closes the singleton utility workspace while preserving all query and table bindings.
   * @param tabId - Utility workspace identifier from the shared tab strip.
   * @returns Nothing (`void`).
   * Side effects: unmounts the Binlog workspace and reveals the retained query, table, or empty state.
   */
  function handleCloseUtilityTab(tabId: string): void {
    if (tabId !== BINLOG_WORKSPACE_TAB.id) {
      return;
    }
    setBinlogWorkspaceOpen(false);
    setActiveUtilityTabId((current) => current === tabId ? null : current);
  }

  /** Retains table names discovered by explicitly expanded connections for global fuzzy lookup. */
  const handleTablesLoaded = useCallback((connectionId: string, tableNames: string[]): void => {
    setTableCatalog((current) => {
      const previous = current[connectionId] ?? [];
      if (previous.length === tableNames.length && previous.every((name, index) => name === tableNames[index])) {
        return current;
      }
      return { ...current, [connectionId]: tableNames };
    });
  }, []);

  /** Opens the global palette while remembering which scoped surface should regain focus. */
  function openCommandPalette(): void {
    paletteReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setCommandPaletteConnectionId(null);
    setCommandPaletteOpen(true);
  }

  /**
   * Opens table discovery globally or pre-scoped to one connection.
   * @param connectionId - Optional connection whose tables should be shown first.
   * @returns Nothing (`void`).
   * Side effects: records focus, updates the initial palette scope, and opens global table discovery.
   */
  function openTableFinder(connectionId?: string): void {
    paletteReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setCommandPaletteConnectionId(connectionId ?? null);
    setCommandPaletteOpen(true);
  }

  /** Closes the global palette and restores the previously focused workspace surface. */
  function closeCommandPalette(): void {
    setCommandPaletteOpen(false);
    window.requestAnimationFrame(() => paletteReturnFocusRef.current?.focus());
  }

  /** Opens the requested shortcut surface without forcing it during startup. */
  function openShortcutDialog(view: ShortcutDialogView): void {
    paletteReturnFocusRef.current = null;
    setShortcutDialogView(view);
    setShortcutHelpOpen(true);
  }

  /** Dispatches one configured scoped shortcut after the palette has released focus. */
  function dispatchScopedShortcut(actionId: ShortcutActionId): void {
    const eventInit = shortcutToKeyboardEventInit(shortcuts.bindings[actionId]);
    if (!eventInit) {
      return;
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const activeTableWorkspace = document.querySelector<HTMLElement>(
          ".workspace-tab-panel:not([hidden]) .table-workspace",
        );
        const activeDataGrid = activeTableWorkspace?.querySelector<HTMLElement>(".editable-grid") ?? null;
        const activeSqlEditor = document.querySelector<HTMLElement>(
          ".query-workspace .monaco-editor textarea, .query-workspace [role='textbox']",
        );
        const scopedTarget = activeTableTabId
          ? actionId === "selectRows" ? activeDataGrid ?? activeTableWorkspace : activeTableWorkspace
          : activeSqlEditor ?? paletteReturnFocusRef.current ?? document;
        const target = scopedTarget ?? document;
        if (target instanceof HTMLElement) {
          target.focus();
        }
        target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      });
    });
  }

  /**
   * Toggles connection-sidebar visibility while keeping the panel mounted.
   * @param nextCollapsed - Explicit collapsed state, or the inverse of the current state when omitted.
   * @returns Nothing (`void`).
   * Side effects: updates React state, persists the preference, and may move focus out of the panel.
   */
  function handleToggleSidebar(nextCollapsed?: boolean): void {
    const collapsed = nextCollapsed ?? !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    persistSidebarCollapsed(collapsed);
    if (collapsed) {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && activeElement.closest(".connection-panel")) {
        sidebarToggleRef.current?.focus();
      }
    }
  }

  /** Ensures the connection sidebar is visible before navigation that depends on it. */
  function ensureSidebarExpanded(): void {
    if (sidebarCollapsed) {
      handleToggleSidebar(false);
    }
  }

  /**
   * Expands the sidebar and scrolls the given connection into view.
   * @param connectionId - Saved connection to reveal in the navigator.
   * @returns Nothing (`void`).
   * Side effects: expands the panel, selects the connection, and requests sidebar focus.
   */
  function handleRevealConnection(connectionId: string): void {
    ensureSidebarExpanded();
    handleSelectConnection(connectionId);
    setFocusConnectionId(connectionId);
  }

  /** Runs the command or navigation represented by one selected palette item. */
  function handleCommandPaletteSelect(item: CommandPaletteItem): void {
    markPaletteItemRecent(item.id);
    if (item.type === "connection") {
      ensureSidebarExpanded();
      handleSelectConnection(item.id.slice("connection:".length));
      return;
    }
    if (item.type === "table") {
      const [connectionId, ...tableNameParts] = item.id.slice("table:".length).split(":");
      if (connectionId && tableNameParts.length > 0) {
        ensureSidebarExpanded();
        handleOpenTable(connectionId, tableNameParts.join(":"));
      }
      return;
    }
    if (item.type === "workspace") {
      if (item.id.startsWith("workspace:query:")) {
        handleSelectQueryTab(item.id.slice("workspace:query:".length));
      } else if (item.id.startsWith("workspace:table:")) {
        handleSelectTableTab(item.id.slice("workspace:table:".length));
      } else if (item.id.startsWith("workspace:utility:")) {
        handleSelectUtilityTab(item.id.slice("workspace:utility:".length));
      }
      return;
    }

    switch (item.id) {
      case "command:add-connection":
        handleAddConnection();
        break;
      case "command:new-query":
        handleCreateQuery();
        break;
      case "command:open-binlog":
        handleOpenBinlogWorkspace();
        break;
      case "command:close-workspace":
        if (activeUtilityTabId) {
          handleCloseUtilityTab(activeUtilityTabId);
        } else if (activeTableTabId) {
          handleCloseTable(activeTableTabId);
        } else if (queryWorkspace.activeTabId) {
          handleCloseQueryTab(queryWorkspace.activeTabId);
        }
        break;
      case "command:next-workspace":
        cycleWorkspaceTabs(false);
        break;
      case "command:previous-workspace":
        cycleWorkspaceTabs(true);
        break;
      case "command:open-mcp":
        setMcpPanelOpen(true);
        break;
      case "command:shortcut-help":
        openShortcutDialog("help");
        break;
      case "command:shortcut-settings":
        openShortcutDialog("settings");
        break;
      case "command:toggle-sidebar":
        handleToggleSidebar();
        break;
      case "command:execute-sql":
        dispatchScopedShortcut("executeQuery");
        break;
      case "command:cancel-query":
        dispatchScopedShortcut("cancelQuery");
        break;
      case "command:select-sql":
        dispatchScopedShortcut("selectSql");
        break;
      case "command:find-current":
        dispatchScopedShortcut("find");
        break;
      case "command:select-current-page":
        dispatchScopedShortcut("selectRows");
        break;
      case "command:save-table-changes":
        dispatchScopedShortcut("saveTable");
        break;
    }
  }

  /**
   * Leaves command search and opens the shared table-action confirmation.
   * @param connectionId - Saved connection that owns the table result.
   * @param tableName - Exact table name selected in command search.
   * @param action - Requested table shortcut.
   * @returns Nothing (`void`).
   * Side effects: closes the palette without restoring background focus and opens confirmation.
   */
  function handleCommandPaletteTableAction(
    connectionId: string,
    tableName: string,
    action: TableQuickAction,
  ): void {
    setCommandPaletteOpen(false);
    handleRequestTableAction(connectionId, tableName, action);
  }

  /** Opens the rename dialog with the exact current non-secret profile name. */
  function handleRequestRenameConnection(profile: ConnectionProfile): void {
    setConnectionActionError(null);
    setRenameCandidate(profile);
    setRenameDraft(profile.name);
  }

  /** Cancels connection renaming without mutating local or persisted state. */
  function handleCancelRenameConnection(): void {
    setRenameCandidate(null);
    setRenameDraft("");
    setConnectionActionError(null);
  }

  /** Persists a validated connection name and updates generated workspace labels. */
  async function handleConfirmRenameConnection(): Promise<void> {
    if (!renameCandidate || renamingConnectionId || !renameDraft.trim()) {
      return;
    }
    const previousProfile = renameCandidate;
    setRenamingConnectionId(previousProfile.id);
    setConnectionActionError(null);
    try {
      const renamedProfile = await renameConnection(previousProfile.id, renameDraft);
      connections.addProfile(renamedProfile);
      queryWorkspace.renameConnectionTabTitles(previousProfile.id, previousProfile.name, renamedProfile.name);
      setOpenTableTabs((current) => current.map((tab) => (
        tab.connectionId === previousProfile.id
          ? { ...tab, title: `${renamedProfile.name} · ${tab.tableName}` }
          : tab
      )));
      setRenameCandidate(null);
      setRenameDraft("");
      setDeletionNotice(`已将连接重命名为“${renamedProfile.name}”。`);
    } catch (error: unknown) {
      setConnectionActionError(getConnectionActionError(error, "重命名失败，请重试。"));
    } finally {
      setRenamingConnectionId(null);
    }
  }

  /** Copies only the non-secret connection profile fields as formatted JSON. */
  async function handleCopyConnectionConfig(profile: ConnectionProfile): Promise<void> {
    setConnectionActionError(null);
    try {
      await writeText(JSON.stringify({
        engine: profile.engine,
        name: profile.name,
        environment: profile.environment,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        database: profile.database,
        tlsMode: profile.tlsMode,
      }, null, 2));
      setDeletionNotice(`已复制“${profile.name}”的非敏感连接配置。`);
    } catch (error: unknown) {
      setConnectionActionError(getConnectionActionError(error, "复制失败，请检查系统剪贴板权限。"));
    }
  }

  /** Re-tests one profile through the backend-owned encrypted credential. */
  async function handleReconnectConnection(profile: ConnectionProfile): Promise<void> {
    if (reconnectingConnectionId) {
      return;
    }
    setReconnectingConnectionId(profile.id);
    setConnectionActionError(null);
    try {
      await reconnectConnection(profile.id);
      setDeletionNotice(`连接“${profile.name}”可用。`);
    } catch (error: unknown) {
      setConnectionActionError(getConnectionActionError(error, `无法重新连接“${profile.name}”。`));
    } finally {
      setReconnectingConnectionId(null);
    }
  }

  /** Opens the destructive confirmation without mutating connection state. */
  function handleRequestDeleteConnection(profile: ConnectionProfile): void {
    setConnectionDeletionError(null);
    setDeleteCandidate(profile);
  }

  /** Closes the delete confirmation and restores focus to its invoking connection row. */
  function handleCancelDeleteConnection(): void {
    const profileId = deleteCandidate?.id;
    setDeleteCandidate(null);
    setConnectionDeletionError(null);
    if (profileId) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>(
          `[data-connection-id="${profileId}"]`,
        )?.focus();
      });
    }
  }

  /**
   * Deletes one confirmed connection and closes every workspace bound to it.
   * Parameters: none.
   * @returns A promise that settles after backend and in-memory state agree.
   * Side effects: permanently deletes encrypted local data and updates open tabs.
   */
  async function handleConfirmDeleteConnection(): Promise<void> {
    if (!deleteCandidate || deletingConnectionId || deleteBlockedByRunningQuery) {
      return;
    }
    const profile = deleteCandidate;
    setDeletingConnectionId(profile.id);
    setConnectionDeletionError(null);
    try {
      await deleteConnection(profile.id);
      connections.removeProfile(profile.id);
      setPinnedTableKeys((current) => {
        const next = new Set([...current].filter((key) => !key.startsWith(`${profile.id}\u0000`)));
        if (next.size === current.size) {
          return current;
        }
        persistPinnedTables(next);
        return next;
      });
      setSelectedRedisDatabases((current) => {
        if (!(profile.id in current)) {
          return current;
        }
        const next = { ...current };
        delete next[profile.id];
        return next;
      });
      queryWorkspace.closeTabsForConnection(profile.id);
      const removedTableTabIds = new Set(
        openTableTabs
          .filter((tab) => tab.connectionId === profile.id)
          .map((tab) => tab.id),
      );
      setDirtyTableTabIds((current) => new Set(
        [...current].filter((tabId) => !removedTableTabIds.has(tabId)),
      ));
      setOpenTableTabs((current) => {
        const nextTabs = current.filter((tab) => tab.connectionId !== profile.id);
        setActiveTableTabId((activeId) => current.some(
          (tab) => tab.id === activeId && tab.connectionId === profile.id,
        ) ? nextTabs[0]?.id ?? null : activeId);
        return nextTabs;
      });
      setDeleteCandidate(null);
      setDeletionNotice(`已删除连接“${profile.name}”及其本地数据。`);
    } catch (error: unknown) {
      setConnectionDeletionError(getConnectionDeletionError(error));
    } finally {
      setDeletingConnectionId(null);
    }
  }

  /**
   * Changes only navigator selection and creates a fixed tab solely when no workspace exists.
   * @param connectionId - Connection selected in the left navigation.
   * @returns Nothing (`void`).
   * Side effects: updates sidebar state and may create the first immutable runnable tab.
   */
  function handleSelectConnection(connectionId: string): void {
    connections.selectConnection(connectionId);
    markPaletteItemRecent(`connection:${connectionId}`);
    const profile = connections.profiles.find((item) => item.id === connectionId);
    if (
      profile?.engine === "my_sql" &&
      !queryWorkspace.loading &&
      !queryWorkspace.recoveryBlocked &&
      queryWorkspace.tabs.length === 0
    ) {
      queryWorkspace.addTab(
        profile.id,
        "查询 1",
        "SELECT 1;",
      );
    }
  }

  /**
   * Creates and activates a native workspace bound to the explicitly selected connection.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: adds a persisted workspace tab without changing any existing tab context.
   */
  function handleCreateQuery(): void {
    if (!newQueryProfile || queryWorkspace.loading || queryWorkspace.recoveryBlocked) {
      return;
    }
    const queryNumber =
      queryWorkspace.tabs.filter((tab) => tab.connectionId === newQueryProfile.id).length + 1;
    const newTab = queryWorkspace.addTab(
      newQueryProfile.id,
      `${newQueryProfile.name} · ${newQueryProfile.engine === "redis" ? "Redis" : "查询"} ${queryNumber}`,
      newQueryProfile.engine === "redis" ? "PING" : "SELECT 1;",
    );
    if (newTab) {
      markPaletteItemRecent(`workspace:query:${newTab.id}`);
    }
    setActiveTableTabId(null);
    setActiveUtilityTabId(null);
  }

  /**
   * Switches the current logical database for one Redis connection without persisting it.
   * @param connectionId - Saved Redis connection identifier.
   * @param database - Redis logical database number selected in the navigator.
   * @returns Nothing (`void`).
   * Side effects: updates navigator selection and the active Redis workspace context.
   */
  function handleSelectRedisDatabase(connectionId: string, database: string): void {
    const profile = connections.profiles.find((item) => item.id === connectionId);
    if (profile?.engine !== "redis") {
      return;
    }
    connections.selectConnection(connectionId);
    setSelectedRedisDatabases((current) => (
      current[connectionId] === database
        ? current
        : { ...current, [connectionId]: database }
    ));
  }

  /**
   * Opens one table in an immutable connection-bound object workspace.
   * @param connectionId - Saved MySQL connection that owns the table.
   * @param tableName - Database-reported table name.
   * @returns Nothing (`void`).
   * Side effects: selects the navigator connection and opens or activates a table tab.
   */
  function handleOpenTable(connectionId: string, tableName: string): void {
    const profile = connections.profiles.find((item) => item.id === connectionId);
    if (profile?.engine !== "my_sql" || !profile.database) {
      return;
    }
    connections.selectConnection(connectionId);
    const tabId = `${connectionId}:${tableName}`;
    setOpenTableTabs((current) => current.some((tab) => tab.id === tabId)
      ? current
      : [...current, { id: tabId, connectionId, tableName, title: `${profile.name} · ${tableName}` }]);
    setActiveTableTabId(tabId);
    setActiveUtilityTabId(null);
    markPaletteItemRecent(`table:${connectionId}:${tableName}`);
    markPaletteItemRecent(`workspace:table:${tabId}`);
  }

  /**
   * Copies table metadata through the desktop clipboard and reports one visible result.
   * @param text - Exact text to place on the clipboard.
   * @param successMessage - Toast shown after the platform accepts the write.
   * @returns A promise settled after the clipboard operation.
   * Side effects: writes to the system clipboard and updates app feedback.
   */
  async function copyTableText(text: string, successMessage: string): Promise<void> {
    try {
      await writeText(text);
      setDeletionNotice(successMessage);
    } catch (error: unknown) {
      setConnectionActionError(getConnectionActionError(
        error,
        "复制失败，请检查系统剪贴板权限。",
      ));
    }
  }

  /**
   * Fetches the server-authored CREATE TABLE statement for one exact MySQL table.
   * @param connectionId - Saved connection identifier.
   * @param database - Exact database name.
   * @param tableName - Exact table name.
   * @returns The server-authored DDL text.
   * Side effects: executes one internal SHOW CREATE TABLE query.
   */
  async function loadCreateTableSql(
    connectionId: string,
    database: string,
    tableName: string,
  ): Promise<string> {
    const result = await executeQueryOnce(
      connectionId,
      `SHOW CREATE TABLE ${quoteIdentifier(database)}.${quoteIdentifier(tableName)};`,
    );
    return cellValueToPlainText(result.rows[0]?.[1] ?? result.rows[0]?.[0]);
  }

  /**
   * Toggles one table pin and persists the exact connection-bound identity locally.
   * @param connectionId - Saved connection identifier.
   * @param tableName - Exact database-reported table name.
   * @returns Nothing (`void`).
   * Side effects: updates React state, local preferences, ordering, and feedback.
   */
  function togglePinnedTable(connectionId: string, tableName: string): void {
    const key = tableTargetKey(connectionId, tableName);
    setPinnedTableKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      persistPinnedTables(next);
      setDeletionNotice(next.has(key) ? `已置顶表“${tableName}”。` : `已取消置顶表“${tableName}”。`);
      return next;
    });
  }

  /**
   * Opens one table in a separate native window, with same-window fallback for browsers.
   * @param profile - MySQL profile that owns the table.
   * @param tableName - Exact database-reported table name.
   * @returns A promise settled after window creation or fallback navigation.
   * Side effects: creates a desktop window or activates a local table tab.
   */
  async function openTableInNewWindow(
    profile: ConnectionProfile,
    tableName: string,
  ): Promise<void> {
    if (!isTauri()) {
      handleOpenTable(profile.id, tableName);
      setDeletionNotice("当前环境不支持独立窗口，已在当前窗口打开表。");
      return;
    }
    try {
      await createDetachedWorkspaceWindow(
        {
          kind: "table",
          id: `${profile.id}:${tableName}`,
          connectionId: profile.id,
          tableName,
          title: `${profile.name} · ${tableName}`,
        },
        { x: window.screenX + 140, y: window.screenY + 90 },
      );
      setDeletionNotice(`已在新窗口中打开表“${tableName}”。`);
    } catch (error: unknown) {
      setConnectionActionError(getConnectionActionError(error, "无法打开独立表窗口，请重试。"));
    }
  }

  /**
   * Loads an entire table result and saves it in the explicitly selected export format.
   * @param profile - MySQL profile that owns the table.
   * @param tableName - Exact database-reported table name.
   * @param action - Requested CSV, JSON, or SQL INSERT format.
   * @returns A promise settled after query and save-dialog completion.
   * Side effects: queries table rows, opens a save dialog, writes a file, and reports progress.
   */
  async function exportTable(
    profile: ConnectionProfile,
    tableName: string,
    action: Extract<TableQuickAction, "export_csv" | "export_json" | "export_sql">,
  ): Promise<void> {
    if (!profile.database || runningTableUtilityAction) {
      return;
    }
    const target = `${quoteIdentifier(profile.database)}.${quoteIdentifier(tableName)}`;
    const fileBase = `${profile.database}-${tableName}`
      .replace(/[^\w\u4e00-\u9fff.-]+/gu, "_")
      .slice(0, 80) || "table";
    setRunningTableUtilityAction(true);
    setConnectionActionError(null);
    setDeletionNotice(`正在导出表“${tableName}”…`);
    try {
      const result = await executeQueryOnce(profile.id, `SELECT * FROM ${target};`);
      const selection = {
        startRow: 0,
        startCol: 0,
        endRow: Math.max(0, result.rows.length - 1),
        endCol: Math.max(0, result.columns.length - 1),
      };
      const exportDefinition = action === "export_csv"
        ? {
          content: serializeResultAsCsv(result.columns, result.rows),
          fileName: `${fileBase}.csv`,
          mimeType: "text/csv;charset=utf-8",
          label: "CSV",
        }
        : action === "export_json"
          ? {
            content: result.rows.length > 0 && result.columns.length > 0
              ? serializeSelectionAsJson(result.columns, result.rows, selection)
              : "[]",
            fileName: `${fileBase}.json`,
            mimeType: "application/json;charset=utf-8",
            label: "JSON",
          }
          : {
            content: serializeRowsAsInsert(result.columns, result.rows, {
              tableName: `${profile.database}.${tableName}`,
              includePrimaryKey: true,
            }) || `-- ${profile.database}.${tableName} 暂无可导出的数据\n`,
            fileName: `${fileBase}.sql`,
            mimeType: "application/sql;charset=utf-8",
            label: "SQL INSERT",
          };
      const outcome = await downloadTextFile(
        exportDefinition.content,
        exportDefinition.fileName,
        exportDefinition.mimeType,
      );
      setDeletionNotice(outcome === "saved"
        ? `已导出 ${exportDefinition.label} · ${result.rows.length} 行。`
        : outcome === "cancelled" ? "已取消导出。" : "导出失败，请重试。");
    } catch (error: unknown) {
      setConnectionActionError(getConnectionActionError(error, "无法读取或导出该表，请重试。"));
    } finally {
      setRunningTableUtilityAction(false);
    }
  }

  /**
   * Opens the shared DDL preview after loading the server-authored CREATE TABLE statement.
   * @param profile - MySQL profile that owns the table.
   * @param tableName - Exact database-reported table name.
   * @returns A promise settled after the DDL query.
   * Side effects: opens and updates the DDL preview dialog.
   */
  async function showCreateTable(profile: ConnectionProfile, tableName: string): Promise<void> {
    if (!profile.database) {
      return;
    }
    setTableDdlPreview({ connectionId: profile.id, tableName, loading: true, sql: "", error: null });
    try {
      const sql = await loadCreateTableSql(profile.id, profile.database, tableName);
      setTableDdlPreview((current) => current?.connectionId === profile.id && current.tableName === tableName
        ? { ...current, loading: false, sql }
        : current);
    } catch (error: unknown) {
      setTableDdlPreview((current) => current?.connectionId === profile.id && current.tableName === tableName
        ? {
          ...current,
          loading: false,
          error: getConnectionActionError(error, "无法读取 CREATE TABLE 语法。"),
        }
        : current);
    }
  }

  /**
   * Loads and copies the server-authored CREATE TABLE statement without opening a preview.
   * @param profile - MySQL profile that owns the table.
   * @param tableName - Exact database-reported table name.
   * @returns A promise settled after query and clipboard completion.
   * Side effects: executes a metadata query, writes the clipboard, and updates feedback.
   */
  async function copyCreateTable(profile: ConnectionProfile, tableName: string): Promise<void> {
    if (!profile.database || runningTableUtilityAction) {
      return;
    }
    setRunningTableUtilityAction(true);
    try {
      const sql = await loadCreateTableSql(profile.id, profile.database, tableName);
      await copyTableText(sql, `已复制表“${tableName}”的 CREATE TABLE 语法。`);
    } catch (error: unknown) {
      setConnectionActionError(getConnectionActionError(error, "无法读取 CREATE TABLE 语法。"));
    } finally {
      setRunningTableUtilityAction(false);
    }
  }

  /**
   * Dispatches every shared table shortcut from the navigator or command center.
   * @param connectionId - Saved connection that owns the table.
   * @param tableName - Database-reported table name.
   * @param action - Requested table shortcut.
   * @returns Nothing (`void`).
   * Side effects: may copy text, open a window/dialog, export data, pin a table, or request confirmation.
   */
  function handleRequestTableAction(
    connectionId: string,
    tableName: string,
    action: TableQuickAction,
  ): void {
    const profile = connections.profiles.find((item) => item.id === connectionId);
    if (profile?.engine !== "my_sql" || !profile.database) {
      return;
    }
    connections.selectConnection(connectionId);
    setConnectionActionError(null);
    if (action === "copy_name") {
      void copyTableText(tableName, `已复制表名“${tableName}”。`);
    } else if (action === "rename" || action === "duplicate") {
      setTableNameActionError(null);
      setDuplicateTableData(true);
      setTableNameDraft(action === "rename" ? tableName : `${tableName}_copy`);
      setPendingTableNameAction({ action, connectionId, tableName });
    } else if (action === "truncate" || action === "drop") {
      setTableActionError(null);
      setPendingTableAction({ action, connectionId, tableName });
    } else if (action === "toggle_pin") {
      togglePinnedTable(connectionId, tableName);
    } else if (action === "open_window") {
      void openTableInNewWindow(profile, tableName);
    } else if (action === "show_create") {
      void showCreateTable(profile, tableName);
    } else if (action === "copy_create") {
      void copyCreateTable(profile, tableName);
    } else {
      void exportTable(profile, tableName, action);
    }
  }

  /**
   * Cancels an idle table operation and restores focus to the invoking table row.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: closes the confirmation layer and schedules focus restoration.
   */
  function handleCancelTableAction(): void {
    if (executingTableAction) {
      return;
    }
    const target = pendingTableAction;
    setPendingTableAction(null);
    setTableActionError(null);
    if (!target) {
      return;
    }
    window.requestAnimationFrame(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>(
        ".table-tree__item[data-connection-id][data-table-name]",
      )).find((item) => (
        item.dataset.connectionId === target.connectionId
        && item.dataset.tableName === target.tableName
      ))?.focus();
    });
  }

  /**
   * Executes one explicitly confirmed TRUNCATE or DROP statement.
   * Parameters: none.
   * @returns A promise settled after SQL execution and navigator/workspace reconciliation.
   * Side effects: permanently mutates MySQL data, refreshes table metadata, and closes stale table tabs.
   */
  async function handleConfirmTableAction(): Promise<void> {
    const database = pendingTableActionProfile?.database;
    if (!pendingTableAction || !database || executingTableAction) {
      return;
    }
    const target = pendingTableAction;
    const qualifiedTable = `${quoteIdentifier(database)}.${quoteIdentifier(target.tableName)}`;
    const sql = target.action === "drop"
      ? `DROP TABLE ${qualifiedTable};`
      : `TRUNCATE TABLE ${qualifiedTable};`;
    setExecutingTableAction(true);
    setTableActionError(null);
    try {
      await executeQueryOnce(target.connectionId, sql);
      closeTableImmediately(`${target.connectionId}:${target.tableName}`);
      if (target.action === "drop") {
        setTableCatalog((current) => {
          const previous = current[target.connectionId];
          if (!previous) {
            return current;
          }
          return {
            ...current,
            [target.connectionId]: previous.filter((tableName) => tableName !== target.tableName),
          };
        });
        setPinnedTableKeys((current) => {
          const key = tableTargetKey(target.connectionId, target.tableName);
          if (!current.has(key)) {
            return current;
          }
          const next = new Set(current);
          next.delete(key);
          persistPinnedTables(next);
          return next;
        });
      }
      setTableCatalogRefreshVersions((current) => ({
        ...current,
        [target.connectionId]: (current[target.connectionId] ?? 0) + 1,
      }));
      setPendingTableAction(null);
      setDeletionNotice(target.action === "drop"
        ? `已删除表“${target.tableName}”。`
        : `已清空表“${target.tableName}”的全部数据。`);
    } catch (error: unknown) {
      setTableActionError(getConnectionActionError(
        error,
        target.action === "drop" ? "删除表失败，请重试。" : "清空表失败，请重试。",
      ));
    } finally {
      setExecutingTableAction(false);
    }
  }

  /**
   * Closes the rename/duplicate dialog while no metadata mutation is running.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: clears dialog state and validation feedback.
   */
  function handleCancelTableNameAction(): void {
    if (executingTableNameAction) {
      return;
    }
    setPendingTableNameAction(null);
    setTableNameDraft("");
    setTableNameActionError(null);
  }

  /**
   * Renames or duplicates one table after validating the destination identifier.
   * Parameters: none.
   * @returns A promise settled after SQL execution and local catalog reconciliation.
   * Side effects: mutates MySQL schema/data and updates table tabs, pins, and cached metadata.
   */
  async function handleConfirmTableNameAction(): Promise<void> {
    const target = pendingTableNameAction;
    const profile = pendingTableNameActionProfile;
    const database = profile?.database;
    const nextTableName = tableNameDraft.trim();
    if (!target || !profile || !database || executingTableNameAction) {
      return;
    }
    if (!nextTableName || nextTableName.length > 64) {
      setTableNameActionError("表名不能为空，且不能超过 64 个字符。");
      return;
    }
    if (nextTableName === target.tableName) {
      setTableNameActionError(target.action === "rename" ? "请输入不同的新表名。" : "复制表不能与原表同名。");
      return;
    }
    if (target.action === "rename" && pendingTableNameActionHasDirtyWorkspace) {
      setTableNameActionError("请先提交或撤销该表的本地修改，再重命名。");
      return;
    }

    const source = `${quoteIdentifier(database)}.${quoteIdentifier(target.tableName)}`;
    const destination = `${quoteIdentifier(database)}.${quoteIdentifier(nextTableName)}`;
    let duplicateStructureCreated = false;
    setExecutingTableNameAction(true);
    setTableNameActionError(null);
    try {
      if (target.action === "rename") {
        await executeQueryOnce(target.connectionId, `RENAME TABLE ${source} TO ${destination};`);
        const previousTabId = `${target.connectionId}:${target.tableName}`;
        const nextTabId = `${target.connectionId}:${nextTableName}`;
        setOpenTableTabs((current) => current.map((tab) => tab.id === previousTabId
          ? {
            ...tab,
            id: nextTabId,
            tableName: nextTableName,
            title: `${profile.name} · ${nextTableName}`,
          }
          : tab));
        setActiveTableTabId((current) => current === previousTabId ? nextTabId : current);
        setPinnedTableKeys((current) => {
          const previousKey = tableTargetKey(target.connectionId, target.tableName);
          if (!current.has(previousKey)) {
            return current;
          }
          const next = new Set(current);
          next.delete(previousKey);
          next.add(tableTargetKey(target.connectionId, nextTableName));
          persistPinnedTables(next);
          return next;
        });
        setTableCatalog((current) => ({
          ...current,
          [target.connectionId]: (current[target.connectionId] ?? []).map((tableName) => (
            tableName === target.tableName ? nextTableName : tableName
          )),
        }));
        setDeletionNotice(`已将表“${target.tableName}”重命名为“${nextTableName}”。`);
      } else {
        await executeQueryOnce(target.connectionId, `CREATE TABLE ${destination} LIKE ${source};`);
        duplicateStructureCreated = true;
        setTableCatalog((current) => ({
          ...current,
          [target.connectionId]: Array.from(new Set([
            ...(current[target.connectionId] ?? []),
            nextTableName,
          ])),
        }));
        if (duplicateTableData) {
          await executeQueryOnce(target.connectionId, `INSERT INTO ${destination} SELECT * FROM ${source};`);
        }
        setDeletionNotice(duplicateTableData
          ? `已复制表“${target.tableName}”及其数据为“${nextTableName}”。`
          : `已复制表“${target.tableName}”的结构为“${nextTableName}”。`);
      }
      setTableCatalogRefreshVersions((current) => ({
        ...current,
        [target.connectionId]: (current[target.connectionId] ?? 0) + 1,
      }));
      setPendingTableNameAction(null);
      setTableNameDraft("");
    } catch (error: unknown) {
      if (target.action === "duplicate" && duplicateStructureCreated) {
        setPendingTableNameAction(null);
        setTableNameDraft("");
        setTableCatalogRefreshVersions((current) => ({
          ...current,
          [target.connectionId]: (current[target.connectionId] ?? 0) + 1,
        }));
        setConnectionActionError(
          `已创建表“${nextTableName}”的结构，但复制数据失败：${getConnectionActionError(error, "未知错误")}`,
        );
        return;
      }
      setTableNameActionError(getConnectionActionError(
        error,
        target.action === "rename" ? "重命名表失败，请重试。" : "复制表失败，请重试。",
      ));
    } finally {
      setExecutingTableNameAction(false);
    }
  }

  /**
   * Opens or reuses a Redis tab seeded with non-mutating inspection commands for one key.
   * @param connectionId - Saved Redis connection that owns the key.
   * @param database - Redis logical database that owns the key.
   * @param keyName - Exact key name returned by SCAN.
   * @returns Nothing (`void`).
   * Side effects: selects the connection and activates or persists its key-inspection tab.
   */
  function handleOpenRedisKey(
    connectionId: string,
    database: string,
    keyName: string,
  ): void {
    const profile = connections.profiles.find((item) => item.id === connectionId);
    if (profile?.engine !== "redis" || queryWorkspace.loading || queryWorkspace.recoveryBlocked) {
      return;
    }
    const key = quoteRedisArgument(keyName);
    const inspectionSql = `TYPE ${key};\nTTL ${key};\nMEMORY USAGE ${key};`;
    connections.selectConnection(connectionId);
    setSelectedRedisDatabases((current) => ({ ...current, [connectionId]: database }));
    const title = `${profile.name} · DB ${database} · ${keyName}`;
    const existingTab = queryWorkspace.tabs.find(
      (tab) => (
        tab.connectionId === connectionId
        && tab.title === title
        && tab.sqlText === inspectionSql
      ),
    );
    if (existingTab) {
      queryWorkspace.selectTab(existingTab.id);
      markPaletteItemRecent(`workspace:query:${existingTab.id}`);
      setActiveTableTabId(null);
      setActiveUtilityTabId(null);
      return;
    }
    const newTab = queryWorkspace.addTab(
      connectionId,
      title,
      inspectionSql,
    );
    if (newTab) {
      markPaletteItemRecent(`workspace:query:${newTab.id}`);
    }
    setActiveTableTabId(null);
    setActiveUtilityTabId(null);
  }

  /**
   * Closes one table tab and activates its nearest surviving table or query.
   * @param tabId - Open table tab identifier.
   * @returns Nothing (`void`).
   * Side effects: updates the open table collection and active workspace identity.
   */
  function closeTableImmediately(tabId: string): void {
    setOpenTableTabs((current) => {
      const closingIndex = current.findIndex((tab) => tab.id === tabId);
      if (closingIndex === -1) {
        return current;
      }
      const next = current.filter((tab) => tab.id !== tabId);
      setActiveTableTabId((activeId) => activeId === tabId
        ? next[closingIndex]?.id ?? next[closingIndex - 1]?.id ?? null
        : activeId);
      return next;
    });
    setDirtyTableTabIds((current) => {
      if (!current.has(tabId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(tabId);
      return next;
    });
  }

  /** Requests confirmation only when closing a table would discard local changes. */
  function handleCloseTable(tabId: string): void {
    if (dirtyTableTabIds.has(tabId)) {
      setPendingCloseTableId(tabId);
      return;
    }
    closeTableImmediately(tabId);
  }

  /** Cancels a dirty close confirmation and restores focus to the retained table tab. */
  function cancelPendingTableClose(): void {
    const tabId = pendingCloseTableId;
    setPendingCloseTableId(null);
    if (tabId) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>(
          `[data-workspace-tab-id="${tabId}"]`,
        )?.focus();
      });
    }
  }

  /** Tracks whether one mounted table workspace has uncommitted DML or DDL. */
  const handleTableDirtyChange = useCallback((tabId: string, dirty: boolean): void => {
    setDirtyTableTabIds((current) => {
      if (current.has(tabId) === dirty) {
        return current;
      }
      const next = new Set(current);
      if (dirty) {
        next.add(tabId);
      } else {
        next.delete(tabId);
      }
      return next;
    });
  }, []);

  /**
   * Selects a query tab while preserving all mounted table workspaces.
   * @param tabId - Persisted query tab to activate.
   * @returns Nothing (`void`).
   * Side effects: updates active table and query-tab state.
   */
  function handleSelectQueryTab(tabId: string): void {
    const tab = queryWorkspace.tabs.find((item) => item.id === tabId);
    const profile = connections.profiles.find((item) => item.id === tab?.connectionId);
    const database = tab ? redisDatabaseFromWorkspaceTitle(tab.title) : null;
    if (profile?.engine === "redis" && database) {
      setSelectedRedisDatabases((current) => ({ ...current, [profile.id]: database }));
    }
    setActiveTableTabId(null);
    setActiveUtilityTabId(null);
    queryWorkspace.selectTab(tabId);
    markPaletteItemRecent(`workspace:query:${tabId}`);
  }

  /** Activates one already-mounted table workspace without losing its local change set. */
  function handleSelectTableTab(tabId: string): void {
    if (openTableTabs.some((tab) => tab.id === tabId)) {
      setActiveTableTabId(tabId);
      setActiveUtilityTabId(null);
      markPaletteItemRecent(`workspace:table:${tabId}`);
    }
  }

  /** Closes one query and falls back to a table when no query remains active. */
  function handleCloseQueryTab(tabId: string): void {
    const isClosingLastActiveQuery = queryWorkspace.activeTabId === tabId && queryWorkspace.tabs.length === 1;
    queryWorkspace.closeTab(tabId);
    if (isClosingLastActiveQuery && openTableTabs.length > 0) {
      setActiveTableTabId(openTableTabs[0]?.id ?? null);
    }
  }

  /** Moves one safe query or table workspace into a newly created native desktop window. */
  async function handleDetachWorkspace(request: WorkspaceDetachRequest): Promise<void> {
    if (!isTauri() || detachingWorkspaceId !== null) return;
    const targetWindowLabel = `workspace-${crypto.randomUUID()}`;
    setConnectionActionError(null);
    setDetachingWorkspaceId(request.tabId);
    if (request.kind === "query") {
      const tab = queryWorkspace.tabs.find((item) => item.id === request.tabId);
      if (!tab || busyQueryTabId === tab.id) {
        setDetachingWorkspaceId(null);
        return;
      }
      let transferred = false;
      try {
        await queryWorkspace.retrySave();
        await transferWorkspaceTab(
          tab,
          workspaceWindowContext.windowLabel,
          targetWindowLabel,
        );
        transferred = true;
        await createDetachedWorkspaceWindow(
          { kind: "query", id: tab.id, title: tab.title },
          request.point,
          targetWindowLabel,
        );
        handleCloseQueryTab(tab.id);
      } catch (error: unknown) {
        console.error("Pipa query workspace detach failed", error);
        if (transferred) {
          try {
            await transferWorkspaceTab(
              tab,
              targetWindowLabel,
              workspaceWindowContext.windowLabel,
            );
          } catch (rollbackError: unknown) {
            console.error("Pipa query workspace detach rollback failed", rollbackError);
          }
        }
        setConnectionActionError(getConnectionActionError(error, "无法分离查询工作区，请重试。"));
      } finally {
        setDetachingWorkspaceId(null);
      }
      return;
    }

    const tableTab = openTableTabs.find((tab) => tab.id === request.tabId);
    if (!tableTab || dirtyTableTabIds.has(tableTab.id)) {
      setConnectionActionError("请先提交或撤销表修改，再分离该工作区。");
      setDetachingWorkspaceId(null);
      return;
    }
    try {
      await createDetachedWorkspaceWindow(
        { kind: "table", ...tableTab },
        request.point,
        targetWindowLabel,
      );
      closeTableImmediately(tableTab.id);
    } catch (error: unknown) {
      console.error("Pipa table workspace detach failed", error);
      setConnectionActionError(getConnectionActionError(error, "无法分离表工作区，请重试。"));
    } finally {
      setDetachingWorkspaceId(null);
    }
  }

  /** Cycles through shared tabs, limiting a busy query to itself and the read-only Binlog workspace. */
  function cycleWorkspaceTabs(reverse: boolean): void {
    const orderedTabs = [
      ...queryWorkspace.tabs.map((tab) => ({ id: tab.id, type: "query" as const })),
      ...openTableTabs.map((tab) => ({ id: tab.id, type: "table" as const })),
      ...(binlogWorkspaceOpen
        ? [{ id: BINLOG_WORKSPACE_TAB.id, type: "utility" as const }]
        : []),
    ];
    const cycleableTabs = busyQueryTabId
      ? orderedTabs.filter(
        (tab) => tab.type === "utility" || (tab.type === "query" && tab.id === busyQueryTabId),
      )
      : orderedTabs;
    if (cycleableTabs.length < 2) {
      return;
    }
    const currentId = activeUtilityTabId ?? activeTableTabId ?? queryWorkspace.activeTabId;
    const currentIndex = Math.max(0, cycleableTabs.findIndex((tab) => tab.id === currentId));
    const delta = reverse ? -1 : 1;
    const nextIndex = (currentIndex + delta + cycleableTabs.length) % cycleableTabs.length;
    const nextTab = cycleableTabs[nextIndex];
    if (nextTab?.type === "query") {
      handleSelectQueryTab(nextTab.id);
    } else if (nextTab?.type === "table") {
      handleSelectTableTab(nextTab.id);
    } else if (nextTab) {
      handleSelectUtilityTab(nextTab.id);
    }
  }

  /** Tracks the one query tab that must not be unmounted during execution. */
  const handleQueryRunningChange = useCallback((tabId: string, running: boolean): void => {
    setBusyQueryTabId((current) => running ? tabId : current === tabId ? null : current);
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const accelerator = toTauriAccelerator(shortcuts.bindings.executeQuery);
    if (!accelerator) {
      return;
    }
    void setExecuteQueryAccelerator(accelerator).catch((error: unknown) => {
      console.error("Pipa native execute shortcut synchronization failed", {
        accelerator,
        error: error instanceof Error ? error.message : "unknown native menu error",
      });
    });
  }, [shortcuts.bindings.executeQuery]);

  useEffect(() => {
    /** Handles global workspace creation, closure, and tab cycling shortcuts. */
    function handleWorkspaceShortcut(event: KeyboardEvent): void {
      if (
        event.defaultPrevented ||
        isAddingConnection ||
        deleteCandidate ||
        pendingCloseTableId ||
        pendingTableAction ||
        renameCandidate ||
        commandPaletteOpen ||
        shortcutHelpOpen
      ) {
        return;
      }
      if (handleScopedSelectAll(event, (candidate) => matchesShortcut(candidate, "Mod+A"))) {
        return;
      }
      if (matchesShortcut(event, shortcuts.bindings.commandPalette)) {
        event.preventDefault();
        openCommandPalette();
        return;
      }
      if (matchesShortcut(event, shortcuts.bindings.shortcutHelp)) {
        event.preventDefault();
        openShortcutDialog("help");
        return;
      }
      if (matchesShortcut(event, shortcuts.bindings.toggleSidebar)) {
        event.preventDefault();
        handleToggleSidebar();
        return;
      }
      if (matchesShortcut(event, shortcuts.bindings.newQuery)) {
        event.preventDefault();
        if (busyQueryTabId === null) {
          handleCreateQuery();
        }
        return;
      }
      if (matchesShortcut(event, shortcuts.bindings.closeWorkspace)) {
        if (!activeUtilityTabId && !activeTableTabId && !queryWorkspace.activeTabId) {
          return;
        }
        event.preventDefault();
        if (activeUtilityTabId) {
          handleCloseUtilityTab(activeUtilityTabId);
        } else if (activeTableTabId) {
          handleCloseTable(activeTableTabId);
        } else if (queryWorkspace.activeTabId && busyQueryTabId !== queryWorkspace.activeTabId) {
          handleCloseQueryTab(queryWorkspace.activeTabId);
        }
        return;
      }
      if (matchesShortcut(event, shortcuts.bindings.nextWorkspace)) {
        event.preventDefault();
        cycleWorkspaceTabs(false);
        return;
      }
      if (matchesShortcut(event, shortcuts.bindings.previousWorkspace)) {
        event.preventDefault();
        cycleWorkspaceTabs(true);
      }
    }
    document.addEventListener("keydown", handleWorkspaceShortcut, true);
    return () => document.removeEventListener("keydown", handleWorkspaceShortcut, true);
  });

  useEffect(() => {
    if (!deletionNotice) {
      return;
    }
    const timeoutId = window.setTimeout(() => setDeletionNotice(null), 3200);
    return () => window.clearTimeout(timeoutId);
  }, [deletionNotice]);

  useEffect(() => {
    if (!connectionActionError) {
      return;
    }
    const timeoutId = window.setTimeout(() => setConnectionActionError(null), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [connectionActionError]);

  useEffect(() => {
    if (!deleteCandidate || deletingConnectionId) {
      return;
    }
    /** Closes an idle deletion confirmation with the platform-standard Escape key. */
    function handleDeleteDialogKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        handleCancelDeleteConnection();
      }
    }
    document.addEventListener("keydown", handleDeleteDialogKeyDown);
    return () => document.removeEventListener("keydown", handleDeleteDialogKeyDown);
  }, [deleteCandidate, deletingConnectionId]);

  useEffect(() => {
    if (!pendingTableAction || executingTableAction) {
      return;
    }
    /**
     * Cancels an idle table operation without mutating database state.
     * @param event - Document-level keyboard event.
     * @returns Nothing (`void`).
     * Side effects: may close the pending table action and restore focus.
     */
    function handleTableActionDialogKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        handleCancelTableAction();
      }
    }
    document.addEventListener("keydown", handleTableActionDialogKeyDown);
    return () => document.removeEventListener("keydown", handleTableActionDialogKeyDown);
  }, [executingTableAction, pendingTableAction]);

  useEffect(() => {
    if (!pendingCloseTableId) {
      return;
    }
    /** Returns to the dirty table workspace without discarding changes. */
    function handleDirtyCloseDialogKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        cancelPendingTableClose();
      }
    }
    document.addEventListener("keydown", handleDirtyCloseDialogKeyDown);
    return () => document.removeEventListener("keydown", handleDirtyCloseDialogKeyDown);
  }, [pendingCloseTableId]);

  useEffect(() => {
    if (!renameCandidate || renamingConnectionId) {
      return;
    }
    /** Cancels the non-destructive rename layer while preserving the selected connection. */
    function handleRenameDialogKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        handleCancelRenameConnection();
      }
    }
    document.addEventListener("keydown", handleRenameDialogKeyDown);
    return () => document.removeEventListener("keydown", handleRenameDialogKeyDown);
  }, [renameCandidate, renamingConnectionId]);

  /**
   * Opens the global database-type picker from either workspace entry point.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: updates local form visibility state.
   */
  function handleAddConnection(): void {
    if (queryWorkspace.recoveryBlocked) {
      return;
    }
    setIsAddingConnection(true);
    setConnectionFormEngine(null);
  }

  /**
   * Closes the connection flow without persisting its ephemeral state.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: unmounts the form and its password state.
   */
  function handleCancelConnection(): void {
    setIsAddingConnection(false);
    setConnectionFormEngine(null);
  }

  /** Opens the selected engine-specific connection form. */
  function handleSelectConnectionType(engine: Extract<Engine, "my_sql" | "redis">): void {
    setConnectionFormEngine(engine);
  }

  /**
   * Retries loading local profiles after an actionable load error.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: invokes the hook's asynchronous Tauri reload command.
   */
  function handleReloadConnections(): void {
    void connections.reload();
  }

  /** Retries the blocked startup restore before allowing any workspace mutation. */
  function handleRetryWorkspaceRecovery(): void {
    setIsAddingConnection(false);
    void queryWorkspace.retryLoad();
  }

  return (
    <div
      className={`app-shell${sidebarCollapsed ? " app-shell--sidebar-collapsed" : ""}`}
      role="application"
      aria-label="Pipa 数据库工作台"
    >
      <aside className="activity-rail" aria-label="主功能">
        <span className="product-mark" aria-label="Pipa">P</span>
        <button
          aria-controls="connection-panel"
          aria-expanded={!sidebarCollapsed}
          aria-label={sidebarCollapsed ? "展开连接侧边栏" : "收起连接侧边栏"}
          className={`activity-rail__toggle${sidebarCollapsed ? "" : " is-active"}`}
          onClick={() => handleToggleSidebar()}
          ref={sidebarToggleRef}
          title={`连接侧边栏（${shortcutLabel("toggleSidebar")}）`}
          type="button"
        >
          <PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </aside>
      <nav
        aria-hidden={sidebarCollapsed || undefined}
        aria-label="数据库连接"
        className="connection-panel"
        id="connection-panel"
        inert={sidebarCollapsed}
      >
        <header className="connection-panel__header">
          <span>
            <span className="eyebrow">LOCAL DATABASE TOOL</span>
            <h1>Pipa</h1>
          </span>
          <span className="connection-panel__actions">
            <span className="connection-panel__status" title="所有配置均保存在本机">本机</span>
            <button
              aria-label="从面板收起侧边栏"
              className="connection-panel__collapse"
              onClick={() => handleToggleSidebar(true)}
              title={`收起连接侧边栏（${shortcutLabel("toggleSidebar")}）`}
              type="button"
            >
              <PanelLeft size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </span>
        </header>

        {connections.loading ? <p className="panel-status">正在读取本地连接…</p> : null}
        {connections.error ? (
          <div className="panel-error" role="alert">
            <p>{connections.error}</p>
            <button type="button" onClick={handleReloadConnections}>
              <RotateCw size={13} aria-hidden="true" />
              重试
            </button>
          </div>
        ) : null}
        <ConnectionSidebar
          discoverTables={commandPaletteOpen}
          discoverTablesForConnectionId={commandPaletteConnectionId}
          dirtyTables={dirtyTables}
          focusConnectionId={focusConnectionId}
          onAddConnection={handleAddConnection}
          onCopyConfig={(profile) => void handleCopyConnectionConfig(profile)}
          onFindTables={openTableFinder}
          onFocusConnectionHandled={() => setFocusConnectionId(null)}
          onOpenRedisKey={handleOpenRedisKey}
          onOpenTable={handleOpenTable}
          onReconnect={(profile) => void handleReconnectConnection(profile)}
          onRequestDelete={handleRequestDeleteConnection}
          onRequestRename={handleRequestRenameConnection}
          onRequestTableAction={handleRequestTableAction}
          onSelectRedisDatabase={handleSelectRedisDatabase}
          onSelectConnection={handleSelectConnection}
          onTablesLoaded={handleTablesLoaded}
          pinnedTableKeys={pinnedTableKeys}
          profiles={connections.profiles}
          reconnectingConnectionId={reconnectingConnectionId}
          selectedConnectionId={connections.selectedConnectionId}
          selectedRedisDatabases={selectedRedisDatabases}
          tableCatalog={tableCatalog}
          tableCatalogRefreshVersions={tableCatalogRefreshVersions}
        />
      </nav>
      <main className="workspace" aria-label="查询工作区">
        <header className="workspace__topbar">
          {isBinlogWorkspaceActive ? (
            <span>Binlog 分析</span>
          ) : sidebarCollapsed && workspaceContextProfile ? (
            <button
              aria-label={`当前连接 ${workspaceContextProfile.name} · ${workspaceContextProfile.database ?? "未指定数据库"}`}
              className="workspace__topbar-context"
              onClick={() => handleRevealConnection(workspaceContextProfile.id)}
              title="展开侧边栏并定位到当前连接"
              type="button"
            >
              <strong>{workspaceContextProfile.name}</strong>
              <span>{workspaceContextProfile.database ?? "未指定数据库"}</span>
            </button>
          ) : (
            <span>连接工作区</span>
          )}
          <span className="workspace__topbar-actions">
            <button
              aria-label="打开 Binlog 分析"
              className={isBinlogWorkspaceActive ? "is-active" : undefined}
              onClick={handleOpenBinlogWorkspace}
              title="打开独立 Binlog 分析工作区"
              type="button"
            >
              <FileClock size={14} aria-hidden="true" />
              Binlog
            </button>
            <button
              aria-label={`打开命令面板（${shortcutLabel("commandPalette")}）`}
              onClick={openCommandPalette}
              title={`打开命令面板（${shortcutLabel("commandPalette")}）`}
              type="button"
            >
              <CommandIcon size={13} aria-hidden="true" />
              命令
            </button>
            <button aria-label="打开快捷键设置" onClick={() => openShortcutDialog("settings")} title="快捷键设置" type="button">
              <Keyboard size={14} aria-hidden="true" />
              快捷键
            </button>
            <button
              aria-label="打开 MCP 控制台"
              onClick={() => setMcpPanelOpen(true)}
              title="MCP 控制台"
              type="button"
            >
              <Server size={14} aria-hidden="true" />
              MCP
            </button>
            <UpdateControl />
            <ThemeToggle preference={theme.preference} onChange={theme.setPreference} />
            <span className="workspace__scope">本地会话</span>
          </span>
        </header>

        <div
          className={`workspace__content${
            hasUsableWorkspace
              ? " workspace__content--query"
              : ""
          }`}
        >
          {queryWorkspace.recoveryBlocked && !isBinlogWorkspaceActive ? (
            <section
              className="connection-overview"
              aria-labelledby="workspace-recovery-title"
              role="alert"
            >
              <span className="connection-overview__glow" aria-hidden="true" />
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">RECOVERY REQUIRED</span>
              <h2 id="workspace-recovery-title">无法恢复上次工作区</h2>
              <p>{queryWorkspace.loadError}</p>
              <div className="connection-overview__actions">
                <button
                  className="button button--primary"
                  disabled={queryWorkspace.loading}
                  onClick={handleRetryWorkspaceRecovery}
                  type="button"
                >
                  {queryWorkspace.loading ? "正在恢复…" : "重新恢复"}
                </button>
              </div>
            </section>
          ) : queryWorkspace.loading && !isBinlogWorkspaceActive ? (
            <p className="panel-status" role="status">
              正在恢复本地工作区…
            </p>
          ) : hasUsableWorkspace ? (
            <section className="workspace-stack" aria-label="已打开工作区">
              <WorkspaceTabs
                activeQueryTabId={queryWorkspace.activeTabId}
                activeTableTabId={activeTableTabId}
                activeUtilityTabId={activeUtilityTabId}
                busyQueryTabId={busyQueryTabId}
                dirtyTableTabIds={dirtyTableTabIds}
                newQueryEngine={newQueryProfile?.engine === "redis" ? "redis" : newQueryProfile ? "my_sql" : null}
                newQueryConnectionName={newQueryProfile?.name ?? null}
                onCloseQuery={handleCloseQueryTab}
                onCloseTable={handleCloseTable}
                onCloseUtility={handleCloseUtilityTab}
                onCreateQuery={handleCreateQuery}
                onDetach={isTauri() ? (request) => void handleDetachWorkspace(request) : undefined}
                onSelectQuery={handleSelectQueryTab}
                onSelectTable={handleSelectTableTab}
                onSelectUtility={handleSelectUtilityTab}
                queryTabs={queryWorkspace.tabs}
                tableTabs={openTableTabs}
                utilityTabs={binlogWorkspaceOpen ? [BINLOG_WORKSPACE_TAB] : []}
              />
              <div className="workspace-tab-panels">
                {queryWorkspace.tabs.map((queryTab) => {
                  const storedProfile = connections.profiles.find(
                    (profile) => profile.id === queryTab.connectionId,
                  );
                  const workspaceProfile = resolveQueryWorkspaceProfile(
                    storedProfile,
                    queryTab,
                    selectedRedisDatabases,
                  );
                  if (!workspaceProfile) {
                    return null;
                  }
                  const isActive = activeUtilityTabId === null
                    && activeTableTabId === null
                    && queryWorkspace.activeTabId === queryTab.id;
                  return (
                    <div
                      className="workspace-tab-panel"
                      hidden={!isActive}
                      key={queryTab.id}
                    >
                      {workspaceProfile.engine === "redis" ? (
                        <RedisWorkspace
                          active={isActive}
                          onDatabaseChange={(database) => handleSelectRedisDatabase(
                            workspaceProfile.id,
                            database,
                          )}
                          onRetryPersistence={queryWorkspace.retrySave}
                          onRunningChange={handleQueryRunningChange}
                          onSqlChange={queryWorkspace.updateTabSql}
                          persistenceError={queryWorkspace.saveError}
                          profile={workspaceProfile}
                          tab={queryTab}
                          theme={theme.resolvedTheme}
                        />
                      ) : (
                        <QueryWorkspace
                          active={isActive}
                          onRetryPersistence={queryWorkspace.retrySave}
                          onRunningChange={handleQueryRunningChange}
                          onSqlChange={queryWorkspace.updateTabSql}
                          persistenceError={queryWorkspace.saveError}
                          profile={workspaceProfile}
                          tab={queryTab}
                          theme={theme.resolvedTheme}
                        />
                      )}
                    </div>
                  );
                })}
                {openTableTabs.map((tableTab) => {
                  const profile = connections.profiles.find((item) => item.id === tableTab.connectionId);
                  return profile?.engine === "my_sql" ? (
                    <div
                      className="workspace-tab-panel"
                      hidden={activeUtilityTabId !== null || activeTableTabId !== tableTab.id}
                      key={tableTab.id}
                    >
                      <TableWorkspace
                        onDirtyChange={(dirty) => handleTableDirtyChange(tableTab.id, dirty)}
                        profile={profile}
                        tableName={tableTab.tableName}
                      />
                    </div>
                  ) : null;
                })}
                {binlogWorkspaceOpen ? (
                  <div
                    aria-labelledby={`workspace-tab-${BINLOG_WORKSPACE_TAB.id}`}
                    className="workspace-tab-panel"
                    hidden={!isBinlogWorkspaceActive}
                    id={`workspace-panel-${BINLOG_WORKSPACE_TAB.id}`}
                    role="tabpanel"
                  >
                    <BinlogWorkspace />
                  </div>
                ) : null}
              </div>
            </section>
          ) : queryWorkspace.activeTab ? (
            <section className="connection-overview" aria-labelledby="connection-overview-title">
              <span className="connection-overview__glow" aria-hidden="true" />
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">CONNECTION UNAVAILABLE</span>
              <h2 id="connection-overview-title">无法恢复查询连接</h2>
              <p>此标签仍保留原连接标识，不会改绑到当前侧栏连接。</p>
              <div className="connection-overview__hints">
                <button onClick={handleAddConnection} type="button">
                  <Plus size={13} aria-hidden="true" />
                  添加可用连接
                </button>
                <button onClick={openCommandPalette} type="button">
                  <CommandIcon size={13} aria-hidden="true" />
                  命令面板
                  <kbd>{shortcutLabel("commandPalette")}</kbd>
                </button>
              </div>
            </section>
          ) : selectedProfile ? (
            <section className="connection-overview" aria-labelledby="connection-overview-title">
              <span className="connection-overview__glow" aria-hidden="true" />
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">CONNECTION SELECTED</span>
              <h2 id="connection-overview-title">{selectedProfile.name}</h2>
              <p>
                {selectedProfile.engine === "redis"
                  ? "已选中 Redis 连接。创建命令工作区，或在侧栏展开浏览键。"
                  : selectedProfile.engine === "my_sql"
                    ? "已选中 MySQL 连接。创建查询工作区，或展开侧栏打开数据表。"
                    : "此引擎界面位置已预留，当前请改用 MySQL 或 Redis 连接继续。"}
              </p>
              {newQueryProfile ? (
                <div className="connection-overview__actions">
                  <button className="button button--primary" onClick={handleCreateQuery} type="button">
                    <Plus size={16} aria-hidden="true" />
                    {newQueryProfile.engine === "redis" ? "新建 Redis 工作区" : "新建 SQL 查询"}
                  </button>
                  <button className="button button--secondary" onClick={openCommandPalette} type="button">
                    <CommandIcon size={14} aria-hidden="true" />
                    命令面板
                    <kbd>{shortcutLabel("commandPalette")}</kbd>
                  </button>
                </div>
              ) : (
                <div className="connection-overview__actions">
                  <button className="button button--primary" onClick={handleAddConnection} type="button">
                    <Plus size={16} aria-hidden="true" />
                    添加连接
                  </button>
                </div>
              )}
              {newQueryProfile ? (
                <ol className="connection-overview__guide">
                  <li>
                    <span className="connection-overview__guide-index" aria-hidden="true">1</span>
                    <span>
                      <strong>在侧栏展开连接</strong>
                      <span>
                        {selectedProfile.engine === "redis"
                          ? "浏览逻辑库与键，双击键可打开检查工作区。"
                          : "展开后加载数据表，点击即可进入表工作区。"}
                      </span>
                    </span>
                    <kbd>{shortcutLabel("toggleSidebar")}</kbd>
                  </li>
                  <li>
                    <span className="connection-overview__guide-index" aria-hidden="true">2</span>
                    <span>
                      <strong>{selectedProfile.engine === "redis" ? "执行 Redis 命令" : "编写并执行 SQL"}</strong>
                      <span>在工作区编辑器中运行语句，结果会流式展示在下方。</span>
                    </span>
                    <kbd>{shortcutLabel("executeQuery")}</kbd>
                  </li>
                </ol>
              ) : null}
            </section>
          ) : (
            <section className="connection-overview" aria-labelledby="connection-overview-title">
              <span className="connection-overview__glow" aria-hidden="true" />
              <span className="connection-overview__icon" aria-hidden="true">
                <Sparkles size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">GET STARTED</span>
              <h2 id="connection-overview-title">选择或创建一个数据库连接</h2>
              <p>连接按引擎整理，凭据仅保存在本机。当前支持 MySQL 与 Redis。</p>
              <div className="connection-overview__actions">
                <button className="button button--primary" onClick={handleAddConnection} type="button">
                  <Plus size={16} aria-hidden="true" />
                  添加连接
                </button>
                <button className="button button--secondary" onClick={openCommandPalette} type="button">
                  <CommandIcon size={14} aria-hidden="true" />
                  命令面板
                  <kbd>{shortcutLabel("commandPalette")}</kbd>
                </button>
              </div>
              <ol className="connection-overview__guide">
                <li>
                  <span className="connection-overview__guide-index" aria-hidden="true">1</span>
                  <span>
                    <strong>添加本机连接</strong>
                    <span>选择 MySQL 或 Redis，测试通过后保存到本地加密存储。</span>
                  </span>
                </li>
                <li>
                  <span className="connection-overview__guide-index" aria-hidden="true">2</span>
                  <span>
                    <strong>打开工作区</strong>
                    <span>新建查询、浏览数据表 / 键，或导入 Binlog 做离线分析。</span>
                  </span>
                </li>
                <li>
                  <span className="connection-overview__guide-index" aria-hidden="true">3</span>
                  <span>
                    <strong>用命令面板加速</strong>
                    <span>搜索连接、表、工作区与常用操作，无需离开键盘。</span>
                  </span>
                  <kbd>{shortcutLabel("commandPalette")}</kbd>
                </li>
              </ol>
              <div className="connection-overview__hints">
                <button onClick={handleOpenBinlogWorkspace} type="button">
                  <FileClock size={13} aria-hidden="true" />
                  Binlog 分析
                </button>
                <button onClick={() => setMcpPanelOpen(true)} type="button">
                  <Server size={13} aria-hidden="true" />
                  MCP 控制台
                </button>
                <button onClick={() => openShortcutDialog("help")} type="button">
                  <Keyboard size={13} aria-hidden="true" />
                  快捷键
                  <kbd>{shortcutLabel("shortcutHelp")}</kbd>
                </button>
              </div>
            </section>
          )}
        </div>
      </main>
      {isAddingConnection ? (
        <div
          aria-labelledby={connectionFormEngine ? "connection-form-title" : "connection-type-title"}
          aria-modal="true"
          className="connection-flow-backdrop"
          role="dialog"
        >
          {connectionFormEngine ? (
            <ConnectionForm
              engine={connectionFormEngine}
              onCancel={() => setConnectionFormEngine(null)}
              onSaved={handleConnectionSaved}
            />
          ) : (
            <ConnectionTypePicker
              onCancel={handleCancelConnection}
              onSelect={handleSelectConnectionType}
            />
          )}
        </div>
      ) : null}
      <CommandPalette
        initialConnectionId={commandPaletteConnectionId}
        items={commandPaletteItems}
        onClose={closeCommandPalette}
        onRequestTableAction={handleCommandPaletteTableAction}
        onSelect={handleCommandPaletteSelect}
        open={commandPaletteOpen}
        pinnedTableKeys={pinnedTableKeys}
      />
      <ShortcutHelpDialog
        initialView={shortcutDialogView}
        onClose={() => setShortcutHelpOpen(false)}
        open={shortcutHelpOpen}
      />
      <McpPanel
        onClose={() => setMcpPanelOpen(false)}
        open={mcpPanelOpen}
        profiles={connections.profiles}
      />
      {renameCandidate ? (
        <div
          className="destructive-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !renamingConnectionId) {
              handleCancelRenameConnection();
            }
          }}
        >
          <section
            aria-labelledby="rename-connection-title"
            aria-modal="true"
            className="destructive-dialog connection-action-dialog"
            role="dialog"
          >
            <header>
              <span className="connection-action-dialog__icon" aria-hidden="true">
                <Pencil size={17} />
              </span>
              <span>
                <span className="eyebrow">CONNECTION NAME</span>
                <h2 id="rename-connection-title">重命名连接</h2>
              </span>
            </header>
            <label className="connection-action-dialog__field">
              <span>连接名称</span>
              <input
                autoFocus
                disabled={Boolean(renamingConnectionId)}
                maxLength={120}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleConfirmRenameConnection();
                  }
                }}
                value={renameDraft}
              />
            </label>
            {connectionActionError ? <p className="destructive-dialog__error" role="alert">{connectionActionError}</p> : null}
            <footer>
              <button className="button button--secondary" disabled={Boolean(renamingConnectionId)} onClick={handleCancelRenameConnection} type="button">
                取消
              </button>
              <button className="button button--primary" disabled={Boolean(renamingConnectionId) || !renameDraft.trim()} onClick={() => void handleConfirmRenameConnection()} type="button">
                {renamingConnectionId ? "正在保存…" : "保存名称"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {pendingTableNameAction && pendingTableNameActionProfile ? (
        <div
          className="destructive-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleCancelTableNameAction();
            }
          }}
        >
          <section
            aria-labelledby="table-name-action-title"
            aria-modal="true"
            className="destructive-dialog connection-action-dialog"
            role="dialog"
          >
            <header>
              <span className="connection-action-dialog__icon" aria-hidden="true">
                {pendingTableNameAction.action === "rename" ? <Pencil size={17} /> : <Copy size={17} />}
              </span>
              <span>
                <span className="eyebrow">TABLE OPERATION</span>
                <h2 id="table-name-action-title">
                  {pendingTableNameAction.action === "rename" ? "重命名表" : "复制表"}
                </h2>
              </span>
            </header>
            <dl>
              <div><dt>连接</dt><dd>{pendingTableNameActionProfile.name}</dd></div>
              <div><dt>原表</dt><dd>{pendingTableNameAction.tableName}</dd></div>
            </dl>
            <label className="connection-action-dialog__field">
              <span>{pendingTableNameAction.action === "rename" ? "新表名" : "复制为"}</span>
              <input
                autoFocus
                disabled={executingTableNameAction}
                maxLength={64}
                onChange={(event) => setTableNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleConfirmTableNameAction();
                  }
                }}
                value={tableNameDraft}
              />
            </label>
            {pendingTableNameAction.action === "duplicate" ? (
              <label className="table-copy-option">
                <input
                  checked={duplicateTableData}
                  disabled={executingTableNameAction}
                  onChange={(event) => setDuplicateTableData(event.target.checked)}
                  type="checkbox"
                />
                同时复制表数据
              </label>
            ) : null}
            {pendingTableNameActionHasDirtyWorkspace ? (
              <p className="destructive-dialog__warning">
                该表有未提交的本地修改；请先提交或撤销后再重命名。
              </p>
            ) : null}
            {tableNameActionError ? (
              <p className="destructive-dialog__error" role="alert">{tableNameActionError}</p>
            ) : null}
            <footer>
              <button
                className="button button--secondary"
                disabled={executingTableNameAction}
                onClick={handleCancelTableNameAction}
                type="button"
              >
                取消
              </button>
              <button
                className="button button--primary"
                disabled={executingTableNameAction || !tableNameDraft.trim()}
                onClick={() => void handleConfirmTableNameAction()}
                type="button"
              >
                {executingTableNameAction
                  ? "正在执行…"
                  : pendingTableNameAction.action === "rename" ? "保存新表名" : "开始复制"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {tableDdlPreview ? (
        <div
          className="destructive-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setTableDdlPreview(null);
            }
          }}
        >
          <section
            aria-labelledby="table-ddl-preview-title"
            aria-modal="true"
            className="destructive-dialog connection-action-dialog table-ddl-dialog"
            role="dialog"
          >
            <header>
              <span className="connection-action-dialog__icon" aria-hidden="true">
                <Braces size={17} />
              </span>
              <span>
                <span className="eyebrow">SHOW CREATE TABLE</span>
                <h2 id="table-ddl-preview-title">{tableDdlPreview.tableName}</h2>
              </span>
            </header>
            <div className="table-ddl-dialog__body">
              {tableDdlPreview.loading ? (
                <p className="panel-status">正在读取 CREATE TABLE 语法…</p>
              ) : tableDdlPreview.error ? (
                <p className="destructive-dialog__error" role="alert">{tableDdlPreview.error}</p>
              ) : (
                <SelectableSqlBlock
                  ariaLabel={`${tableDdlPreview.tableName} CREATE TABLE 语法`}
                  value={tableDdlPreview.sql}
                />
              )}
            </div>
            <footer>
              <button className="button button--secondary" onClick={() => setTableDdlPreview(null)} type="button">
                关闭
              </button>
              <button
                className="button button--primary"
                disabled={!tableDdlPreview.sql}
                onClick={() => void copyTableText(
                  tableDdlPreview.sql,
                  `已复制表“${tableDdlPreview.tableName}”的 CREATE TABLE 语法。`,
                )}
                type="button"
              >
                <Copy size={14} aria-hidden="true" />
                复制语法
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {pendingTableAction && pendingTableActionProfile ? (
        <div
          className="destructive-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleCancelTableAction();
            }
          }}
        >
          <section
            aria-describedby="table-action-description"
            aria-labelledby="table-action-title"
            aria-modal="true"
            className="destructive-dialog"
            role="alertdialog"
          >
            <header>
              <span className="destructive-dialog__icon" aria-hidden="true">
                <AlertTriangle size={18} />
              </span>
              <span>
                <span className="eyebrow">DESTRUCTIVE SQL</span>
                <h2 id="table-action-title">
                  {pendingTableAction.action === "drop"
                    ? `删除表“${pendingTableAction.tableName}”？`
                    : `清空“${pendingTableAction.tableName}”的全部数据？`}
                </h2>
              </span>
            </header>
            <p id="table-action-description">
              {pendingTableAction.action === "drop"
                ? "DROP TABLE 会永久删除表结构及全部数据，无法撤销。"
                : "TRUNCATE TABLE 会永久删除全部行并重置自增计数，无法撤销。"}
              {pendingTableActionHasDirtyWorkspace
                ? " 此表还有未提交的本地修改；执行成功后工作区会关闭，这些修改也会丢失。"
                : " 执行成功后会关闭已打开的表工作区，避免继续显示旧数据。"}
            </p>
            <dl>
              <div><dt>连接</dt><dd>{pendingTableActionProfile.name}</dd></div>
              <div><dt>数据库</dt><dd>{pendingTableActionProfile.database}</dd></div>
              <div>
                <dt>SQL</dt>
                <dd>{pendingTableAction.action === "drop" ? "DROP TABLE" : "TRUNCATE TABLE"}</dd>
              </div>
            </dl>
            {tableActionError ? (
              <p className="destructive-dialog__error" role="alert">{tableActionError}</p>
            ) : null}
            <footer>
              <button
                autoFocus
                className="button button--secondary"
                disabled={executingTableAction}
                onClick={handleCancelTableAction}
                type="button"
              >
                取消
              </button>
              <button
                className="button button--danger"
                disabled={executingTableAction}
                onClick={() => void handleConfirmTableAction()}
                type="button"
              >
                <Trash2 size={14} aria-hidden="true" />
                {executingTableAction
                  ? "正在执行…"
                  : pendingTableAction.action === "drop" ? "永久删除表" : "清空全部数据"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {deleteCandidate ? (
        <div
          className="destructive-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deletingConnectionId) {
              handleCancelDeleteConnection();
            }
          }}
        >
          <section
            aria-describedby="delete-connection-description"
            aria-labelledby="delete-connection-title"
            aria-modal="true"
            className="destructive-dialog"
            role="alertdialog"
          >
            <header>
              <span className="destructive-dialog__icon" aria-hidden="true">
                <AlertTriangle size={18} />
              </span>
              <span>
                <span className="eyebrow">PERMANENT ACTION</span>
                <h2 id="delete-connection-title">删除“{deleteCandidate.name}”？</h2>
              </span>
            </header>
            <p id="delete-connection-description">
              将永久删除连接配置、加密凭据和查询历史
              {deleteCandidateWorkspaceCount > 0
                ? `，并关闭 ${deleteCandidateWorkspaceCount} 个相关工作区`
                : ""}
              。未提交的表修改无法恢复。
            </p>
            <dl>
              <div><dt>类型</dt><dd>{deleteCandidate.engine === "my_sql" ? "MySQL" : "Redis"}</dd></div>
              <div><dt>地址</dt><dd>{deleteCandidate.host}:{deleteCandidate.port}</dd></div>
            </dl>
            {deleteBlockedByRunningQuery ? (
              <p className="destructive-dialog__warning" role="status">
                此连接仍有查询运行。请先取消或等待查询完成。
              </p>
            ) : null}
            {connectionDeletionError ? (
              <p className="destructive-dialog__error" role="alert">{connectionDeletionError}</p>
            ) : null}
            <footer>
              <button
                autoFocus
                className="button button--secondary"
                disabled={Boolean(deletingConnectionId)}
                onClick={() => {
                  handleCancelDeleteConnection();
                }}
                type="button"
              >
                取消
              </button>
              <button
                className="button button--danger"
                disabled={Boolean(deletingConnectionId) || deleteBlockedByRunningQuery}
                onClick={() => void handleConfirmDeleteConnection()}
                type="button"
              >
                <Trash2 size={14} aria-hidden="true" />
                {deletingConnectionId ? "正在删除…" : deleteCandidate.environment === "production" ? "永久删除生产连接" : "永久删除连接"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {pendingCloseTable ? (
        <div
          className="destructive-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              cancelPendingTableClose();
            }
          }}
        >
          <section
            aria-describedby="close-dirty-table-description"
            aria-labelledby="close-dirty-table-title"
            aria-modal="true"
            className="destructive-dialog"
            role="alertdialog"
          >
            <header>
              <span className="destructive-dialog__icon" aria-hidden="true">
                <AlertTriangle size={18} />
              </span>
              <span>
                <span className="eyebrow">UNCOMMITTED CHANGES</span>
                <h2 id="close-dirty-table-title">关闭“{pendingCloseTable.tableName}”？</h2>
              </span>
            </header>
            <p id="close-dirty-table-description">
              此表工作区包含尚未提交的 DML 或 DDL。关闭后，本地变更集将无法恢复。
            </p>
            <footer>
              <button
                autoFocus
                className="button button--secondary"
                onClick={cancelPendingTableClose}
                type="button"
              >
                继续编辑
              </button>
              <button
                className="button button--danger"
                onClick={() => {
                  const tabId = pendingCloseTable.id;
                  setPendingCloseTableId(null);
                  closeTableImmediately(tabId);
                }}
                type="button"
              >
                放弃修改并关闭
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {deletionNotice ? <p className="app-toast" role="status">{deletionNotice}</p> : null}
      {connectionActionError && !renameCandidate ? <p className="app-toast app-toast--error" role="alert">{connectionActionError}</p> : null}
    </div>
  );
}
