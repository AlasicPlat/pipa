import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AlertTriangle, Command as CommandIcon, Database, Keyboard, PanelLeft, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import type { Engine } from "../bindings/Engine";
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
import { ConnectionForm } from "../features/connections/ConnectionForm";
import { ConnectionSidebar } from "../features/connections/ConnectionSidebar";
import { ConnectionTypePicker } from "../features/connections/ConnectionTypePicker";
import { useConnections } from "../features/connections/useConnections";
import { ThemeToggle } from "../features/preferences/ThemeToggle";
import { useThemePreference } from "../features/preferences/theme";
import { QueryWorkspace } from "../features/query/QueryWorkspace";
import { useWorkspacePersistence } from "../features/query/useWorkspacePersistence";
import { TableWorkspace } from "../features/tables/TableWorkspace";
import { WorkspaceTabs, type OpenTableTab } from "../features/workspace/WorkspaceTabs";
import { deleteConnection, reconnectConnection, renameConnection, setExecuteQueryAccelerator } from "../lib/tauriClient";
import "./tokens.css";
import "./app.css";

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
 * Composes the connection-management shell around feature-owned connection state.
 * Parameters: none.
 * @returns The React element for the persistent Pipa workspace.
 * Side effects: loads non-secret connection profiles through `useConnections` after mounting.
 */
export function App() {
  const connections = useConnections();
  const queryWorkspace = useWorkspacePersistence();
  const theme = useThemePreference();
  const shortcuts = useShortcutSettings();
  const [isAddingConnection, setIsAddingConnection] = useState(false);
  const [connectionFormEngine, setConnectionFormEngine] = useState<Extract<Engine, "my_sql" | "redis"> | null>(null);
  const [openTableTabs, setOpenTableTabs] = useState<OpenTableTab[]>([]);
  const [activeTableTabId, setActiveTableTabId] = useState<string | null>(null);
  const [busyQueryTabId, setBusyQueryTabId] = useState<string | null>(null);
  const [dirtyTableTabIds, setDirtyTableTabIds] = useState<Set<string>>(new Set());
  const [pendingCloseTableId, setPendingCloseTableId] = useState<string | null>(null);
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
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [shortcutDialogView, setShortcutDialogView] = useState<ShortcutDialogView>("help");
  const [tableCatalog, setTableCatalog] = useState<Record<string, string[]>>({});
  const [recentItemTimestamps, setRecentItemTimestamps] = useState<Record<string, number>>({});
  const paletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const selectedProfile = connections.profiles.find(
    (profile) => profile.id === connections.selectedConnectionId,
  );
  const activeQueryProfile = connections.profiles.find(
    (profile) => profile.id === queryWorkspace.activeTab?.connectionId,
  );
  const activeTableTab = openTableTabs.find((tab) => tab.id === activeTableTabId);
  const pendingCloseTable = openTableTabs.find((tab) => tab.id === pendingCloseTableId) ?? null;
  const dirtyTables = openTableTabs
    .filter((tab) => dirtyTableTabIds.has(tab.id))
    .map((tab) => ({ connectionId: tab.connectionId, tableName: tab.tableName }));
  const activeTableProfile = connections.profiles.find((profile) => profile.id === activeTableTab?.connectionId);
  const newQueryProfile = selectedProfile
    ? selectedProfile.engine === "my_sql" ? selectedProfile : null
    : activeTableProfile?.engine === "my_sql"
      ? activeTableProfile
      : activeQueryProfile?.engine === "my_sql" ? activeQueryProfile : null;
  const hasUsableWorkspace = openTableTabs.length > 0 || Boolean(queryWorkspace.activeTab && activeQueryProfile?.engine === "my_sql");
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
    ...(newQueryProfile ? [{
      id: "command:new-query",
      type: "command" as const,
      label: "新建 SQL 查询",
      detail: shortcutLabel("newQuery"),
      keywords: ["query", "sql"],
      lastUsedAt: recentItemTimestamps["command:new-query"],
    }] : []),
    ...((activeTableTabId || queryWorkspace.activeTabId) ? [{
      id: "command:close-workspace",
      type: "command" as const,
      label: "关闭当前工作区",
      detail: shortcutLabel("closeWorkspace"),
      keywords: ["close", "关闭标签"],
      lastUsedAt: recentItemTimestamps["command:close-workspace"],
    }] : []),
    ...(queryWorkspace.tabs.length + openTableTabs.length > 1 ? [
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
    ...(activeTableTabId === null && queryWorkspace.activeTabId ? [
      {
        id: "command:execute-sql",
        type: "command" as const,
        label: "执行当前 SQL",
        detail: shortcutLabel("executeQuery"),
        keywords: ["run", "查询"],
        lastUsedAt: recentItemTimestamps["command:execute-sql"],
      },
      {
        id: "command:select-sql",
        type: "command" as const,
        label: "选中当前 SQL",
        detail: shortcutLabel("selectSql"),
        keywords: ["select", "全选 sql"],
        lastUsedAt: recentItemTimestamps["command:select-sql"],
      },
      {
        id: "command:find-current",
        type: "command" as const,
        label: "查找当前 SQL",
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
    ...(activeTableTabId ? [
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
      detail: `${profile.engine === "my_sql" ? "MySQL" : profile.engine === "redis" ? "Redis" : profile.engine} · ${profile.host}:${profile.port}`,
      keywords: [profile.database ?? "", profile.username, profile.environment],
      lastUsedAt: recentItemTimestamps[`connection:${profile.id}`],
    })),
    ...Object.entries(tableCatalog).flatMap(([connectionId, tableNames]) => {
      const profile = connections.profiles.find((item) => item.id === connectionId);
      return profile ? tableNames.map((tableName) => ({
        id: `table:${connectionId}:${tableName}`,
        type: "table" as const,
        label: tableName,
        detail: `${profile.name} · ${profile.database ?? "未指定数据库"}`,
        keywords: [profile.name, profile.database ?? ""],
        lastUsedAt: recentItemTimestamps[`table:${connectionId}:${tableName}`],
      })) : [];
    }),
    ...queryWorkspace.tabs.map((tab) => ({
      id: `workspace:query:${tab.id}`,
      type: "workspace" as const,
      label: tab.title,
      detail: connections.profiles.find((profile) => profile.id === tab.connectionId)?.name ?? "连接不可用",
      keywords: [tab.sqlText.slice(0, 160), "SQL 查询"],
      lastUsedAt: recentItemTimestamps[`workspace:query:${tab.id}`],
    })),
    ...openTableTabs.map((tab) => ({
      id: `workspace:table:${tab.id}`,
      type: "workspace" as const,
      label: tab.title,
      detail: "表工作区",
      keywords: [tab.tableName],
      lastUsedAt: recentItemTimestamps[`workspace:table:${tab.id}`],
    })),
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
      queryWorkspace.addTab(profile.id, "查询 1");
    }
    setIsAddingConnection(false);
    setConnectionFormEngine(null);
  }

  /** Records session-local object recency without persisting connection metadata outside the encrypted store. */
  function markPaletteItemRecent(itemId: string): void {
    setRecentItemTimestamps((current) => ({ ...current, [itemId]: Date.now() }));
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

  /** Runs the command or navigation represented by one selected palette item. */
  function handleCommandPaletteSelect(item: CommandPaletteItem): void {
    markPaletteItemRecent(item.id);
    if (item.type === "connection") {
      handleSelectConnection(item.id.slice("connection:".length));
      return;
    }
    if (item.type === "table") {
      const [connectionId, ...tableNameParts] = item.id.slice("table:".length).split(":");
      if (connectionId && tableNameParts.length > 0) {
        handleOpenTable(connectionId, tableNameParts.join(":"));
      }
      return;
    }
    if (item.type === "workspace") {
      if (item.id.startsWith("workspace:query:")) {
        handleSelectQueryTab(item.id.slice("workspace:query:".length));
      } else if (item.id.startsWith("workspace:table:")) {
        handleSelectTableTab(item.id.slice("workspace:table:".length));
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
      case "command:close-workspace":
        if (activeTableTabId) {
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
      case "command:shortcut-help":
        openShortcutDialog("help");
        break;
      case "command:shortcut-settings":
        openShortcutDialog("settings");
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
   * Side effects: updates sidebar state and may create the first immutable MySQL query tab.
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
      queryWorkspace.addTab(profile.id, "查询 1");
    }
  }

  /**
   * Creates and activates a query bound to the explicitly selected MySQL connection.
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
      `${newQueryProfile.name} · 查询 ${queryNumber}`,
    );
    if (newTab) {
      markPaletteItemRecent(`workspace:query:${newTab.id}`);
    }
    setActiveTableTabId(null);
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
    markPaletteItemRecent(`table:${connectionId}:${tableName}`);
    markPaletteItemRecent(`workspace:table:${tabId}`);
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
    setActiveTableTabId(null);
    queryWorkspace.selectTab(tabId);
    markPaletteItemRecent(`workspace:query:${tabId}`);
  }

  /** Activates one already-mounted table workspace without losing its local change set. */
  function handleSelectTableTab(tabId: string): void {
    if (openTableTabs.some((tab) => tab.id === tabId)) {
      setActiveTableTabId(tabId);
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

  /** Cycles through the shared query/table tab order without changing connection binding. */
  function cycleWorkspaceTabs(reverse: boolean): void {
    const orderedTabs = [
      ...queryWorkspace.tabs.map((tab) => ({ id: tab.id, type: "query" as const })),
      ...openTableTabs.map((tab) => ({ id: tab.id, type: "table" as const })),
    ];
    if (orderedTabs.length < 2 || busyQueryTabId !== null) {
      return;
    }
    const currentId = activeTableTabId ?? queryWorkspace.activeTabId;
    const currentIndex = Math.max(0, orderedTabs.findIndex((tab) => tab.id === currentId));
    const delta = reverse ? -1 : 1;
    const nextIndex = (currentIndex + delta + orderedTabs.length) % orderedTabs.length;
    const nextTab = orderedTabs[nextIndex];
    if (nextTab?.type === "query") {
      handleSelectQueryTab(nextTab.id);
    } else if (nextTab) {
      handleSelectTableTab(nextTab.id);
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
        renameCandidate ||
        commandPaletteOpen ||
        shortcutHelpOpen
      ) {
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
      if (matchesShortcut(event, shortcuts.bindings.newQuery)) {
        event.preventDefault();
        if (busyQueryTabId === null) {
          handleCreateQuery();
        }
        return;
      }
      if (matchesShortcut(event, shortcuts.bindings.closeWorkspace)) {
        if (!activeTableTabId && !queryWorkspace.activeTabId) {
          return;
        }
        event.preventDefault();
        if (activeTableTabId) {
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
    <div className="app-shell" role="application" aria-label="Pipa 数据库工作台">
      <aside className="activity-rail" aria-label="主功能">
        <span className="product-mark" aria-label="Pipa">P</span>
        <span className="activity-rail__active" aria-label="连接">
          <PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
        </span>
      </aside>
      <nav className="connection-panel" aria-label="数据库连接">
        <header className="connection-panel__header">
          <span>
            <span className="eyebrow">LOCAL DATABASE TOOL</span>
            <h1>Pipa</h1>
          </span>
          <span className="connection-panel__status" title="所有配置均保存在本机">本机</span>
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
          dirtyTables={dirtyTables}
          onAddConnection={handleAddConnection}
          onCopyConfig={(profile) => void handleCopyConnectionConfig(profile)}
          onOpenTable={handleOpenTable}
          onReconnect={(profile) => void handleReconnectConnection(profile)}
          onRequestDelete={handleRequestDeleteConnection}
          onRequestRename={handleRequestRenameConnection}
          onSelectConnection={handleSelectConnection}
          onTablesLoaded={handleTablesLoaded}
          profiles={connections.profiles}
          reconnectingConnectionId={reconnectingConnectionId}
          selectedConnectionId={connections.selectedConnectionId}
        />
      </nav>
      <main className="workspace" aria-label="查询工作区">
        <header className="workspace__topbar">
          <span>连接工作区</span>
          <span className="workspace__topbar-actions">
            <button onClick={openCommandPalette} title={`打开命令面板（${shortcutLabel("commandPalette")}）`} type="button">
              <CommandIcon size={13} aria-hidden="true" />
              命令
              <kbd>{shortcutLabel("commandPalette")}</kbd>
            </button>
            <button aria-label="打开快捷键设置" onClick={() => openShortcutDialog("settings")} title="快捷键设置" type="button">
              <Keyboard size={14} aria-hidden="true" />
              快捷键
            </button>
            <ThemeToggle preference={theme.preference} onChange={theme.setPreference} />
            <span className="workspace__scope">本地会话</span>
          </span>
        </header>

        <div
          className={`workspace__content${
            hasUsableWorkspace && !isAddingConnection
              ? " workspace__content--query"
              : ""
          }`}
        >
          {queryWorkspace.recoveryBlocked ? (
            <section
              className="connection-overview"
              aria-labelledby="workspace-recovery-title"
              role="alert"
            >
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">RECOVERY REQUIRED</span>
              <h2 id="workspace-recovery-title">无法恢复上次工作区</h2>
              <p>{queryWorkspace.loadError}</p>
              <button
                className="button button--primary"
                disabled={queryWorkspace.loading}
                onClick={handleRetryWorkspaceRecovery}
                type="button"
              >
                {queryWorkspace.loading ? "正在恢复…" : "重新恢复"}
              </button>
            </section>
          ) : isAddingConnection && connectionFormEngine === null ? (
            <ConnectionTypePicker
              onCancel={handleCancelConnection}
              onSelect={handleSelectConnectionType}
            />
          ) : isAddingConnection && connectionFormEngine ? (
            <ConnectionForm
              engine={connectionFormEngine}
              onCancel={() => setConnectionFormEngine(null)}
              onSaved={handleConnectionSaved}
            />
          ) : queryWorkspace.loading ? (
            <p className="panel-status" role="status">
              正在恢复本地工作区…
            </p>
          ) : hasUsableWorkspace ? (
            <section className="workspace-stack" aria-label="已打开工作区">
              <WorkspaceTabs
                activeQueryTabId={queryWorkspace.activeTabId}
                activeTableTabId={activeTableTabId}
                busyQueryTabId={busyQueryTabId}
                dirtyTableTabIds={dirtyTableTabIds}
                newQueryConnectionName={newQueryProfile?.name ?? null}
                onCloseQuery={handleCloseQueryTab}
                onCloseTable={handleCloseTable}
                onCreateQuery={handleCreateQuery}
                onSelectQuery={handleSelectQueryTab}
                onSelectTable={handleSelectTableTab}
                queryTabs={queryWorkspace.tabs}
                tableTabs={openTableTabs}
              />
              <div className="workspace-tab-panels">
                {activeTableTabId === null && queryWorkspace.activeTab && activeQueryProfile?.engine === "my_sql" ? (
                  <QueryWorkspace
                    key={queryWorkspace.activeTab.id}
                    onRetryPersistence={queryWorkspace.retrySave}
                    onRunningChange={handleQueryRunningChange}
                    onSqlChange={queryWorkspace.updateTabSql}
                    persistenceError={queryWorkspace.saveError}
                    profile={activeQueryProfile}
                    tab={queryWorkspace.activeTab}
                    theme={theme.resolvedTheme}
                  />
                ) : null}
                {openTableTabs.map((tableTab) => {
                  const profile = connections.profiles.find((item) => item.id === tableTab.connectionId);
                  return profile?.engine === "my_sql" ? (
                    <div className="workspace-tab-panel" hidden={activeTableTabId !== tableTab.id} key={tableTab.id}>
                      <TableWorkspace
                        onDirtyChange={(dirty) => handleTableDirtyChange(tableTab.id, dirty)}
                        profile={profile}
                        tableName={tableTab.tableName}
                      />
                    </div>
                  ) : null;
                })}
              </div>
            </section>
          ) : queryWorkspace.activeTab ? (
            <section className="connection-overview" aria-labelledby="connection-overview-title">
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">CONNECTION UNAVAILABLE</span>
              <h2 id="connection-overview-title">无法恢复查询连接</h2>
              <p>此标签仍保留原连接标识，不会改绑到当前侧栏连接。</p>
            </section>
          ) : selectedProfile ? (
            <section className="connection-overview" aria-labelledby="connection-overview-title">
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">CONNECTION SELECTED</span>
              <h2 id="connection-overview-title">{selectedProfile.name}</h2>
              <p>{selectedProfile.engine === "redis" ? "Redis 连接已保存。命令工作台将在后续版本开放。" : "请选择一个 MySQL 连接继续。"}</p>
            </section>
          ) : (
            <section className="connection-overview" aria-labelledby="connection-overview-title">
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">GET STARTED</span>
              <h2 id="connection-overview-title">选择或创建一个数据库连接</h2>
              <p>连接会按数据库引擎独立整理。当前支持 MySQL 与 Redis。</p>
              <button className="button button--primary" onClick={handleAddConnection} type="button">
                <Plus size={16} aria-hidden="true" />
                添加连接
              </button>
            </section>
          )}
        </div>
      </main>
      <CommandPalette
        items={commandPaletteItems}
        onClose={closeCommandPalette}
        onSelect={handleCommandPaletteSelect}
        open={commandPaletteOpen}
      />
      <ShortcutHelpDialog
        initialView={shortcutDialogView}
        onClose={() => setShortcutHelpOpen(false)}
        open={shortcutHelpOpen}
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
