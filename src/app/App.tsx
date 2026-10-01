import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Command as CommandIcon, FileClock, Keyboard, PanelLeft, RotateCw, Server } from "lucide-react";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import type { Engine } from "../bindings/Engine";
import { BinlogWorkspace } from "../features/binlog/BinlogWorkspace";
import { CommandPalette, type CommandPaletteItem } from "../features/commands/CommandPalette";
import {
  buildCommandPaletteItems,
  paletteTableItemId,
  parsePaletteTableItemId,
} from "../features/commands/commandPaletteItems";
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
import { ConnectionManager } from "../features/connections/ConnectionManager";
import {
  formatConnectionConfigExport,
  getConnectionActionError,
  getConnectionDeletionError,
} from "../features/connections/connectionErrors";
import {
  ConnectionOverview,
  WorkspaceRecoveryNotice,
} from "../features/connections/ConnectionOverview";
import { ConnectionPicker } from "../features/connections/ConnectionPicker";
import { ConnectionSidebar } from "../features/connections/ConnectionSidebar";
import { ConnectionTypePicker } from "../features/connections/ConnectionTypePicker";
import { CreateDatabaseDialog } from "../features/dialogs/CreateDatabaseDialog";
import { DeleteConnectionDialog } from "../features/dialogs/DeleteConnectionDialog";
import { DiscardTableChangesDialog } from "../features/dialogs/DiscardTableChangesDialog";
import { DropDatabaseDialog } from "../features/dialogs/DropDatabaseDialog";
import { RenameConnectionDialog } from "../features/dialogs/RenameConnectionDialog";
import { TableDdlPreviewDialog } from "../features/dialogs/TableDdlPreviewDialog";
import { TableDestructiveActionDialog } from "../features/dialogs/TableDestructiveActionDialog";
import { TableNameActionDialog, type TableNameActionRequest } from "../features/dialogs/TableNameActionDialog";
import { useConnections } from "../features/connections/useConnections";
import { useConnectionFormFlow } from "../features/connections/useConnectionFormFlow";
import { McpPanel } from "../features/mcp/McpPanel";
import { useMcpPendingApprovals } from "../features/mcp/useMcpState";
import { ThemeToggle } from "../features/preferences/ThemeToggle";
import { SidebarResizer } from "../features/preferences/SidebarResizer";
import {
  loadFocusedConnectionId,
  loadFocusedDatabases,
  persistFocusedConnectionId,
  persistFocusedDatabases,
} from "../features/preferences/workspaceFocus";
import { useSidebarLayout } from "../features/preferences/useSidebarLayout";
import { useDatabaseOperations } from "../features/connections/useDatabaseOperations";
import { useTableUtilityActions } from "../features/tables/useTableUtilityActions";
import { useAppToasts } from "./useAppToast";
import { loadPinnedTables, persistPinnedTables } from "../features/preferences/pinnedTables";
import { useThemePreference } from "../features/preferences/theme";
import { executeQueryOnce } from "../features/query/executeQueryOnce";
import {
  useWorkspacePersistence,
  type WorkspaceTab,
} from "../features/query/useWorkspacePersistence";
import {
  redisDatabaseFromWorkspaceTitle,
  redisKeyInspectionCommands,
  redisKeyWorkspaceTitle,
} from "../features/redis/redisKeyWorkspace";
import {
  tableTabId,
  tableTargetKey,
  type TableDestructiveAction,
  type TableQuickAction,
} from "../features/tables/TableActionMenu";
import {
  addTableToCatalog,
  buildDestructiveTableStatement,
  buildTableNameActionStatements,
  removePinnedTableKey,
  removeTableFromCatalog,
  renamePinnedTableKey,
  renameTableInCatalog,
  tableNameActionValidationError,
  togglePinnedTableKey,
} from "../features/tables/tableActions";
import { UpdateControl } from "../features/updater/UpdateControl";
import { QueryTabPanels, TableTabPanels } from "../features/workspace/WorkspacePanels";
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
  orderWorkspaceTabs,
  resolveWorkspaceTabCycle,
  resolveWorkspaceTabJump,
  type WorkspaceTabRef,
} from "../features/workspace/workspaceNavigation";
import { resolveWorkspaceShortcut } from "../features/commands/workspaceShortcuts";
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

const CONNECTION_MANAGER_TAB: UtilityWorkspaceTab = {
  id: "connection-manager",
  kind: "connections",
  title: "连接管理",
};

const BINLOG_WORKSPACE_TAB: UtilityWorkspaceTab = {
  id: "binlog-analysis",
  kind: "binlog",
  title: "Binlog 分析",
};

interface PendingTableDestructiveAction {
  action: TableDestructiveAction;
  connectionId: string;
  database: string;
  tableName: string;
}

interface PendingTableNameAction {
  action: "rename" | "duplicate";
  connectionId: string;
  database: string;
  tableName: string;
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
  const mcpPendingApprovals = useMcpPendingApprovals();
  const detachedTableTab = workspaceWindowContext.descriptor?.kind === "table"
    ? workspaceWindowContext.descriptor
    : null;
  const connectionForm = useConnectionFormFlow(!queryWorkspace.recoveryBlocked);
  const [openTableTabs, setOpenTableTabs] = useState<OpenTableTab[]>(() => detachedTableTab
    ? [{
      id: detachedTableTab.id,
      connectionId: detachedTableTab.connectionId,
      database: detachedTableTab.database,
      tableName: detachedTableTab.tableName,
      title: detachedTableTab.title,
    }]
    : []);
  const [activeTableTabId, setActiveTableTabId] = useState<string | null>(detachedTableTab?.id ?? null);
  const [binlogWorkspaceOpen, setBinlogWorkspaceOpen] = useState(false);
  const [connectionManagerOpen, setConnectionManagerOpen] = useState(false);
  // Bumped after a schema is created or dropped so the manager reloads its list.
  const [databaseRefreshVersion, setDatabaseRefreshVersion] = useState(0);
  // Which connection and view the manager should land on when opened from a shortcut.
  const [connectionManagerRequest, setConnectionManagerRequest] = useState<{
    connectionId: string | null;
    view: "profile" | "databases";
  } | null>(null);
  const [connectionManagerRequestToken, setConnectionManagerRequestToken] = useState(0);
  const [activeUtilityTabId, setActiveUtilityTabId] = useState<string | null>(null);
  const [busyQueryTabId, setBusyQueryTabId] = useState<string | null>(null);
  const [dirtyTableTabIds, setDirtyTableTabIds] = useState<Set<string>>(new Set());
  const [pendingCloseTableId, setPendingCloseTableId] = useState<string | null>(null);
  const [pendingTableAction, setPendingTableAction] = useState<PendingTableDestructiveAction | null>(null);
  const [pendingTableNameAction, setPendingTableNameAction] = useState<PendingTableNameAction | null>(null);
  const [executingTableNameAction, setExecutingTableNameAction] = useState(false);
  const [tableNameActionError, setTableNameActionError] = useState<string | null>(null);
  const [pinnedTableKeys, setPinnedTableKeys] = useState(loadPinnedTables);
  const [tableActionError, setTableActionError] = useState<string | null>(null);
  const [executingTableAction, setExecutingTableAction] = useState(false);
  const [tableCatalogRefreshVersions, setTableCatalogRefreshVersions] = useState<Record<string, number>>({});
  const [deleteCandidate, setDeleteCandidate] = useState<ConnectionProfile | null>(null);
  const [deletingConnectionId, setDeletingConnectionId] = useState<string | null>(null);
  const [connectionDeletionError, setConnectionDeletionError] = useState<string | null>(null);
  const toasts = useAppToasts();
  const [renameCandidate, setRenameCandidate] = useState<ConnectionProfile | null>(null);
  const [renamingConnectionId, setRenamingConnectionId] = useState<string | null>(null);
  const [reconnectingConnectionId, setReconnectingConnectionId] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteConnectionId, setCommandPaletteConnectionId] = useState<string | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [shortcutDialogView, setShortcutDialogView] = useState<ShortcutDialogView>("help");
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false);
  const sidebar = useSidebarLayout();
  const [focusConnectionId, setFocusConnectionId] = useState<string | null>(null);
  // Table names per connection, then per schema, so same-named tables in different schemas stay
  // distinct in global search.
  const [tableCatalog, setTableCatalog] = useState<Record<string, Record<string, string[]>>>({});
  const [selectedRedisDatabases, setSelectedRedisDatabases] = useState<Record<string, string>>({});
  // Which schema each MySQL connection is browsing; absent entries fall back to the profile default.
  const [selectedDatabases, setSelectedDatabases] = useState<Record<string, string>>(
    loadFocusedDatabases,
  );

  // The navigator shows one connection at a time, so the focus itself is worth remembering.
  useEffect(() => {
    persistFocusedConnectionId(connections.selectedConnectionId);
  }, [connections.selectedConnectionId]);

  useEffect(() => {
    persistFocusedDatabases(selectedDatabases);
  }, [selectedDatabases]);

  // The navigator shows one connection, so there must always be one in focus once profiles load:
  // the remembered choice when it still exists, otherwise the first saved connection.
  const focusRestoredRef = useRef(false);
  useEffect(() => {
    if (
      focusRestoredRef.current
      || connections.loading
      || connections.profiles.length === 0
      || connections.selectedConnectionId
    ) {
      return;
    }
    focusRestoredRef.current = true;
    const savedId = loadFocusedConnectionId();
    const restored = savedId && connections.profiles.some((profile) => profile.id === savedId)
      ? savedId
      : connections.profiles[0]?.id;
    if (restored) {
      connections.selectConnection(restored);
    }
  }, [connections]);

  /**
   * Records the schema one MySQL connection is browsing and keeps the navigator in sync.
   * @param connectionId - Saved MySQL connection whose schema changed.
   * @param database - Schema selected in the switcher.
   * @returns Nothing (`void`).
   * Side effects: selects the connection and replaces its browsed schema.
   */
  function handleSelectDatabase(connectionId: string, database: string): void {
    connections.selectConnection(connectionId);
    setSelectedDatabases((current) => (
      current[connectionId] === database
        ? current
        : { ...current, [connectionId]: database }
    ));
  }
  const [recentItemTimestamps, setRecentItemTimestamps] = useState<Record<string, number>>({});
  const [detachingWorkspaceId, setDetachingWorkspaceId] = useState<string | null>(null);
  const paletteReturnFocusRef = useRef<HTMLElement | null>(null);
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
        toasts.error.show("部分独立工作窗口无法恢复，请重新拖出对应工作区。");
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
        toasts.error.show(getConnectionActionError(
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
        toasts.error.show("无法监听独立工作窗口关闭事件，请重试。");
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
  const activeTableTab = openTableTabs.find((tab) => tab.id === activeTableTabId);
  const pendingCloseTable = openTableTabs.find((tab) => tab.id === pendingCloseTableId) ?? null;
  const pendingTableActionProfile = pendingTableAction
    ? connections.profiles.find((profile) => profile.id === pendingTableAction.connectionId) ?? null
    : null;
  const pendingTableNameActionProfile = pendingTableNameAction
    ? connections.profiles.find((profile) => profile.id === pendingTableNameAction.connectionId) ?? null
    : null;
  /*
   * `handleOpenTable` is a hoisted function declaration, so the same-window fallback can reach it
   * from here even though it is defined further down the component.
   */
  const tableUtilityActions = useTableUtilityActions({
    clearError: toasts.error.clear,
    openTableInCurrentWindow: (connectionId, database, tableName) => {
      handleOpenTable(connectionId, database, tableName);
    },
    showError: toasts.error.show,
    showNotice: toasts.notice.show,
  });

  /*
   * `closeTableImmediately` is a hoisted function declaration, so the drop callback can reach it
   * from here even though it is defined further down the component.
   */
  const databaseOperations = useDatabaseOperations({
    clearError: toasts.error.clear,
    findProfile: (connectionId) => connections.profiles.find(
      (profile) => profile.id === connectionId,
    ),
    onDatabaseCreated: (connectionId) => {
      // The navigator lists only the connection's default schema, so refresh it in case the new
      // database is that schema's name and metadata is now stale.
      setTableCatalogRefreshVersions((current) => ({
        ...current,
        [connectionId]: (current[connectionId] ?? 0) + 1,
      }));
    },
    onDatabaseDropped: (connectionId, database) => {
      // Every table workspace bound to the dropped schema can no longer resolve, so close them.
      for (const tab of openTableTabs) {
        if (tab.connectionId === connectionId && tab.database === database) {
          closeTableImmediately(tab.id);
        }
      }
      setTableCatalog((current) => {
        const perDatabase = current[connectionId];
        if (!perDatabase || !(database in perDatabase)) {
          return current;
        }
        const { [database]: _dropped, ...remaining } = perDatabase;
        return { ...current, [connectionId]: remaining };
      });
      setSelectedDatabases((current) => {
        if (current[connectionId] !== database) {
          return current;
        }
        const { [connectionId]: _cleared, ...remaining } = current;
        return remaining;
      });
      setDatabaseRefreshVersion((current) => current + 1);
    },
    selectConnection: connections.selectConnection,
    showNotice: toasts.notice.show,
  });
  const pendingTableActionTabId = pendingTableAction
    ? `${pendingTableAction.connectionId}:${pendingTableAction.tableName}`
    : null;
  const pendingTableActionHasDirtyWorkspace = pendingTableActionTabId
    ? dirtyTableTabIds.has(pendingTableActionTabId)
    : false;
  const pendingTableNameActionHasDirtyWorkspace = pendingTableNameAction
    ? dirtyTableTabIds.has(`${pendingTableNameAction.connectionId}:${pendingTableNameAction.tableName}`)
    : false;
  // Lets the navigator mark rows that are genuinely open instead of guessing from local clicks.
  const openTableObjects = useMemo(() => openTableTabs.map((tab) => ({
    connectionId: tab.connectionId,
    objectName: tab.tableName,
  })), [openTableTabs]);
  const dirtyTables = useMemo(() => openTableTabs
    .filter((tab) => dirtyTableTabIds.has(tab.id))
    .map((tab) => ({ connectionId: tab.connectionId, tableName: tab.tableName })), [
    dirtyTableTabIds,
    openTableTabs,
  ]);
  /*
   * Redis workspaces execute against a profile whose database comes from the navigator rather than
   * the saved default, so resolution allocates a new profile object. Memoizing keeps that object
   * identity stable across unrelated renders, which the workspace panels depend on.
   */
  const queryWorkspaceProfiles = useMemo(
    () => new Map(queryWorkspace.tabs.map((tab) => [
      tab.id,
      resolveQueryWorkspaceProfile(
        connections.profiles.find((profile) => profile.id === tab.connectionId),
        tab,
        selectedRedisDatabases,
      ),
    ])),
    [connections.profiles, queryWorkspace.tabs, selectedRedisDatabases],
  );
  const activeTableProfile = connections.profiles.find((profile) => profile.id === activeTableTab?.connectionId);
  const isBinlogWorkspaceActive = binlogWorkspaceOpen
    && activeUtilityTabId === BINLOG_WORKSPACE_TAB.id;
  const isConnectionManagerActive = connectionManagerOpen
    && activeUtilityTabId === CONNECTION_MANAGER_TAB.id;
  // The navigator follows the selected connection regardless of which workspace tab is active, so
  // the picker keeps reporting the user's place even inside Binlog or the manager.
  const activeNavigatorProfile = connections.profiles.find(
    (profile) => profile.id === connections.selectedConnectionId,
  ) ?? null;
  const openUtilityTabs: UtilityWorkspaceTab[] = useMemo(() => [
    ...(connectionManagerOpen ? [CONNECTION_MANAGER_TAB] : []),
    ...(binlogWorkspaceOpen ? [BINLOG_WORKSPACE_TAB] : []),
  ], [binlogWorkspaceOpen, connectionManagerOpen]);
  const newQueryProfile = selectedProfile
    ? matchesRunnableEngine(selectedProfile.engine) ? selectedProfile : null
    : activeTableProfile?.engine === "my_sql"
      ? activeTableProfile
      : activeQueryProfile && matchesRunnableEngine(activeQueryProfile.engine)
        ? activeQueryProfile
        : null;
  const hasUsableWorkspace = binlogWorkspaceOpen
    || connectionManagerOpen
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
  const shortcutLabel = useCallback(
    (actionId: ShortcutActionId): string =>
      getShortcutKeyLabels(shortcuts.bindings[actionId]).join(" + "),
    [shortcuts.bindings],
  );
  /*
   * Building this list walks every table in `tableCatalog`, measured at 10.7 ms for 15k tables and
   * 32 ms for 50k. It previously ran on every App render even while the palette was closed, so it
   * stays memoized and gated on `commandPaletteOpen`.
   */
  const commandPaletteItems: CommandPaletteItem[] = useMemo(
    () => commandPaletteOpen
      ? buildCommandPaletteItems({
        activeQueryProfile,
        activeQueryTabId: queryWorkspace.activeTabId,
        activeTableTabId,
        activeUtilityTabId,
        binlogWorkspaceOpen,
        binlogWorkspaceTab: BINLOG_WORKSPACE_TAB,
        busyQueryTabId,
        connectionManagerOpen,
        connectionManagerTab: CONNECTION_MANAGER_TAB,
        newQueryProfile,
        openTableTabs,
        openUtilityTabCount: openUtilityTabs.length,
        profiles: connections.profiles,
        queryTabs: queryWorkspace.tabs,
        recentItemTimestamps,
        selectedProfile,
        shortcutLabel,
        sidebarCollapsed: sidebar.collapsed,
        tableCatalog,
      })
      : [],
    [
      activeQueryProfile,
      activeTableTabId,
      activeUtilityTabId,
      binlogWorkspaceOpen,
      busyQueryTabId,
      commandPaletteOpen,
      connectionManagerOpen,
      connections.profiles,
      newQueryProfile,
      openTableTabs,
      openUtilityTabs.length,
      queryWorkspace.activeTabId,
      queryWorkspace.tabs,
      recentItemTimestamps,
      selectedProfile,
      shortcutLabel,
      sidebar.collapsed,
      tableCatalog,
    ],
  );

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
    connectionForm.close();
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
    connectionForm.close();
    setBinlogWorkspaceOpen(true);
    setActiveUtilityTabId(BINLOG_WORKSPACE_TAB.id);
    markPaletteItemRecent(`workspace:utility:${BINLOG_WORKSPACE_TAB.id}`);
  }

  /**
   * Opens or reactivates the singleton connection manager.
   *
   * Configuration is a full workspace rather than a dialog because it is a place users stay in
   * while comparing servers and schemas, not a one-shot confirmation.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: cancels an unfinished connection form and activates the manager tab.
   */
  function handleOpenConnectionManager(connectionId?: string, view?: "profile" | "databases"): void {
    connectionForm.close();
    setConnectionManagerOpen(true);
    setActiveUtilityTabId(CONNECTION_MANAGER_TAB.id);
    // Landing on the requested connection avoids making the user find it again in the manager.
    if (connectionId) {
      connections.selectConnection(connectionId);
    }
    setConnectionManagerRequest({ connectionId: connectionId ?? null, view: view ?? "profile" });
    setConnectionManagerRequestToken((current) => current + 1);
    markPaletteItemRecent(`workspace:utility:${CONNECTION_MANAGER_TAB.id}`);
  }

  /**
   * Activates an already-open connection-independent utility workspace.
   * @param tabId - Utility workspace identifier from the shared tab strip.
   * @returns Nothing (`void`).
   * Side effects: updates only the active utility identity and session-local recency.
   */
  function handleSelectUtilityTab(tabId: string): void {
    const isOpen = (tabId === BINLOG_WORKSPACE_TAB.id && binlogWorkspaceOpen)
      || (tabId === CONNECTION_MANAGER_TAB.id && connectionManagerOpen);
    if (!isOpen) {
      return;
    }
    setActiveUtilityTabId(tabId);
    markPaletteItemRecent(`workspace:utility:${tabId}`);
  }

  /**
   * Closes one utility workspace while preserving all query and table bindings.
   * @param tabId - Utility workspace identifier from the shared tab strip.
   * @returns Nothing (`void`).
   * Side effects: unmounts that workspace and reveals the retained query, table, or empty state.
   */
  function handleCloseUtilityTab(tabId: string): void {
    if (tabId === BINLOG_WORKSPACE_TAB.id) {
      setBinlogWorkspaceOpen(false);
    } else if (tabId === CONNECTION_MANAGER_TAB.id) {
      setConnectionManagerOpen(false);
    } else {
      return;
    }
    // Falling back to the other utility tab keeps a visible workspace when one remains open.
    const fallbackUtilityId = tabId === BINLOG_WORKSPACE_TAB.id && connectionManagerOpen
      ? CONNECTION_MANAGER_TAB.id
      : tabId === CONNECTION_MANAGER_TAB.id && binlogWorkspaceOpen
        ? BINLOG_WORKSPACE_TAB.id
        : null;
    setActiveUtilityTabId((current) => current === tabId ? fallbackUtilityId : current);
  }

  /** Retains table names discovered by explicitly expanded connections for global fuzzy lookup. */
  const handleTablesLoaded = useCallback((
    connectionId: string,
    database: string,
    tableNames: string[],
  ): void => {
    setTableCatalog((current) => {
      const previous = current[connectionId]?.[database] ?? [];
      if (previous.length === tableNames.length && previous.every((name, index) => name === tableNames[index])) {
        return current;
      }
      return {
        ...current,
        [connectionId]: { ...current[connectionId], [database]: tableNames },
      };
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
    sidebar.toggle(nextCollapsed);
  }

  /** Runs the command or navigation represented by one selected palette item. */
  function handleCommandPaletteSelect(item: CommandPaletteItem): void {
    markPaletteItemRecent(item.id);
    if (item.type === "connection") {
      sidebar.ensureExpanded();
      handleSelectConnection(item.id.slice("connection:".length));
      return;
    }
    if (item.type === "table") {
      const target = parsePaletteTableItemId(item.id);
      if (target) {
        sidebar.ensureExpanded();
        handleOpenTable(target.connectionId, target.database, target.tableName);
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
        connectionForm.start();
        break;
      case "command:create-database":
        if (selectedProfile) {
          databaseOperations.requestCreate(selectedProfile);
        }
        break;
      case "command:new-query":
        handleCreateQuery();
        break;
      case "command:open-binlog":
        handleOpenBinlogWorkspace();
        break;
      case "command:open-connection-manager":
        handleOpenConnectionManager();
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
    database: string,
    tableName: string,
    action: TableQuickAction,
  ): void {
    setCommandPaletteOpen(false);
    handleRequestTableAction(connectionId, database, tableName, action);
  }

  /** Opens the rename dialog with the exact current non-secret profile name. */
  function handleRequestRenameConnection(profile: ConnectionProfile): void {
    toasts.error.clear();
    setRenameCandidate(profile);
  }

  /** Cancels connection renaming without mutating local or persisted state. */
  function handleCancelRenameConnection(): void {
    setRenameCandidate(null);
    toasts.error.clear();
  }

  /**
   * Persists a validated connection name and updates generated workspace labels.
   * @param name - Draft name owned by the dialog; trimmed by the backend command.
   * @returns A promise settled after the rename attempt.
   * Side effects: persists the profile and rewrites dependent tab titles.
   */
  async function handleConfirmRenameConnection(name: string): Promise<void> {
    if (!renameCandidate || renamingConnectionId || !name.trim()) {
      return;
    }
    const previousProfile = renameCandidate;
    setRenamingConnectionId(previousProfile.id);
    toasts.error.clear();
    try {
      const renamedProfile = await renameConnection(previousProfile.id, name);
      connections.addProfile(renamedProfile);
      queryWorkspace.renameConnectionTabTitles(previousProfile.id, previousProfile.name, renamedProfile.name);
      setOpenTableTabs((current) => current.map((tab) => (
        tab.connectionId === previousProfile.id
          ? { ...tab, title: `${renamedProfile.name} · ${tab.database}.${tab.tableName}` }
          : tab
      )));
      setRenameCandidate(null);
      toasts.notice.show(`已将连接重命名为“${renamedProfile.name}”。`);
    } catch (error: unknown) {
      toasts.error.show(getConnectionActionError(error, "重命名失败，请重试。"));
    } finally {
      setRenamingConnectionId(null);
    }
  }

  /**
   * Applies a profile edited in the manager to every surface that shows its identity.
   * @param profile - Backend-confirmed non-secret profile.
   * @returns Nothing (`void`).
   * Side effects: updates the profile list, workspace tab titles, and a confirmation toast.
   */
  function handleConnectionProfileUpdated(profile: ConnectionProfile): void {
    const previousProfile = connections.profiles.find((item) => item.id === profile.id);
    connections.addProfile(profile);
    if (previousProfile && previousProfile.name !== profile.name) {
      queryWorkspace.renameConnectionTabTitles(profile.id, previousProfile.name, profile.name);
      setOpenTableTabs((current) => current.map((tab) => (
        tab.connectionId === profile.id
          ? { ...tab, title: `${profile.name} · ${tab.database}.${tab.tableName}` }
          : tab
      )));
    }
    toasts.notice.show(`已更新连接“${profile.name}”的配置。`);
  }

  /** Copies only the non-secret connection profile fields as formatted JSON. */
  async function handleCopyConnectionConfig(profile: ConnectionProfile): Promise<void> {
    toasts.error.clear();
    try {
      await writeText(formatConnectionConfigExport(profile));
      toasts.notice.show(`已复制“${profile.name}”的非敏感连接配置。`);
    } catch (error: unknown) {
      toasts.error.show(getConnectionActionError(error, "复制失败，请检查系统剪贴板权限。"));
    }
  }

  /** Re-tests one profile through the backend-owned encrypted credential. */
  async function handleReconnectConnection(profile: ConnectionProfile): Promise<void> {
    if (reconnectingConnectionId) {
      return;
    }
    setReconnectingConnectionId(profile.id);
    toasts.error.clear();
    try {
      await reconnectConnection(profile.id);
      toasts.notice.show(`连接“${profile.name}”可用。`);
    } catch (error: unknown) {
      toasts.error.show(getConnectionActionError(error, `无法重新连接“${profile.name}”。`));
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
      toasts.notice.show(`已删除连接“${profile.name}”及其本地数据。`);
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
  function handleOpenTable(connectionId: string, database: string, tableName: string): void {
    const profile = connections.profiles.find((item) => item.id === connectionId);
    if (profile?.engine !== "my_sql" || !database) {
      return;
    }
    connections.selectConnection(connectionId);
    const tabId = tableTabId(connectionId, database, tableName);
    setOpenTableTabs((current) => current.some((tab) => tab.id === tabId)
      ? current
      : [...current, {
        id: tabId,
        connectionId,
        database,
        tableName,
        title: `${profile.name} · ${database}.${tableName}`,
      }]);
    setActiveTableTabId(tabId);
    setActiveUtilityTabId(null);
    markPaletteItemRecent(paletteTableItemId(connectionId, database, tableName));
    markPaletteItemRecent(`workspace:table:${tabId}`);
  }

  /**
   * Toggles one table pin and persists the exact connection-bound identity locally.
   * @param connectionId - Saved connection identifier.
   * @param database - Schema that owns the table.
   * @param tableName - Exact database-reported table name.
   * @returns Nothing (`void`).
   * Side effects: updates React state, local preferences, ordering, and feedback.
   */
  function togglePinnedTable(connectionId: string, database: string, tableName: string): void {
    /*
     * Persisting and announcing happen here rather than inside the state updater. React invokes
     * updaters twice under StrictMode, which previously wrote to local storage and queued the toast
     * twice per click.
     */
    const toggle = togglePinnedTableKey(
      pinnedTableKeys,
      tableTargetKey(connectionId, database, tableName),
    );
    setPinnedTableKeys(toggle.keys);
    persistPinnedTables(toggle.keys);
    toasts.notice.show(toggle.pinned ? `已置顶表“${tableName}”。` : `已取消置顶表“${tableName}”。`);
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
    database: string,
    tableName: string,
    action: TableQuickAction,
  ): void {
    const profile = connections.profiles.find((item) => item.id === connectionId);
    if (profile?.engine !== "my_sql" || !database) {
      return;
    }
    connections.selectConnection(connectionId);
    toasts.error.clear();
    if (action === "copy_name") {
      void tableUtilityActions.copyText(tableName, `已复制表名“${tableName}”。`);
    } else if (action === "rename" || action === "duplicate") {
      setTableNameActionError(null);
      setPendingTableNameAction({ action, connectionId, database, tableName });
    } else if (action === "truncate" || action === "drop") {
      setTableActionError(null);
      setPendingTableAction({ action, connectionId, database, tableName });
    } else if (action === "toggle_pin") {
      togglePinnedTable(connectionId, database, tableName);
    } else if (action === "open_window") {
      void tableUtilityActions.openInNewWindow(profile, database, tableName);
    } else if (action === "show_create") {
      void tableUtilityActions.showCreateTable(profile, database, tableName);
    } else if (action === "copy_create") {
      void tableUtilityActions.copyCreateTable(profile, database, tableName);
    } else {
      void tableUtilityActions.exportTable(profile, database, tableName, action);
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
    const sql = buildDestructiveTableStatement(target.action, database, target.tableName);
    setExecutingTableAction(true);
    setTableActionError(null);
    try {
      await executeQueryOnce(target.connectionId, sql);
      closeTableImmediately(tableTabId(target.connectionId, target.database, target.tableName));
      if (target.action === "drop") {
        setTableCatalog((current) => removeTableFromCatalog(
          current,
          target.connectionId,
          target.database,
          target.tableName,
        ));
        const unpinned = removePinnedTableKey(
          pinnedTableKeys,
          tableTargetKey(target.connectionId, target.database, target.tableName),
        );
        if (unpinned.changed) {
          setPinnedTableKeys(unpinned.keys);
          persistPinnedTables(unpinned.keys);
        }
      }
      setTableCatalogRefreshVersions((current) => ({
        ...current,
        [target.connectionId]: (current[target.connectionId] ?? 0) + 1,
      }));
      setPendingTableAction(null);
      toasts.notice.show(target.action === "drop"
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
    setTableNameActionError(null);
  }

  /**
   * Renames or duplicates one table after validating the destination identifier.
   * @param request - Destination name and copy-data choice drafted in the dialog.
   * @returns A promise settled after SQL execution and local catalog reconciliation.
   * Side effects: mutates MySQL schema/data and updates table tabs, pins, and cached metadata.
   */
  async function handleConfirmTableNameAction(request: TableNameActionRequest): Promise<void> {
    const target = pendingTableNameAction;
    const profile = pendingTableNameActionProfile;
    const database = profile?.database;
    const nextTableName = request.tableName.trim();
    if (!target || !profile || !database || executingTableNameAction) {
      return;
    }
    const validationError = tableNameActionValidationError(
      target.action,
      target.tableName,
      nextTableName,
      pendingTableNameActionHasDirtyWorkspace,
    );
    if (validationError) {
      setTableNameActionError(validationError);
      return;
    }
    const statements = buildTableNameActionStatements(
      target.action,
      database,
      target.tableName,
      nextTableName,
      request.copyData,
    );
    let duplicateStructureCreated = false;
    setExecutingTableNameAction(true);
    setTableNameActionError(null);
    try {
      if (target.action === "rename") {
        await executeQueryOnce(target.connectionId, statements.primary);
        const previousTabId = tableTabId(target.connectionId, target.database, target.tableName);
        const nextTabId = tableTabId(target.connectionId, target.database, nextTableName);
        setOpenTableTabs((current) => current.map((tab) => tab.id === previousTabId
          ? {
            ...tab,
            id: nextTabId,
            tableName: nextTableName,
            title: `${profile.name} · ${target.database}.${nextTableName}`,
          }
          : tab));
        setActiveTableTabId((current) => current === previousTabId ? nextTabId : current);
        const repinned = renamePinnedTableKey(
          pinnedTableKeys,
          tableTargetKey(target.connectionId, target.database, target.tableName),
          tableTargetKey(target.connectionId, target.database, nextTableName),
        );
        if (repinned.changed) {
          setPinnedTableKeys(repinned.keys);
          persistPinnedTables(repinned.keys);
        }
        setTableCatalog((current) => renameTableInCatalog(
          current,
          target.connectionId,
          target.database,
          target.tableName,
          nextTableName,
        ));
        toasts.notice.show(`已将表“${target.tableName}”重命名为“${nextTableName}”。`);
      } else {
        await executeQueryOnce(target.connectionId, statements.primary);
        duplicateStructureCreated = true;
        setTableCatalog((current) => addTableToCatalog(
          current,
          target.connectionId,
          target.database,
          nextTableName,
        ));
        if (statements.copyRows) {
          await executeQueryOnce(target.connectionId, statements.copyRows);
        }
        toasts.notice.show(request.copyData
          ? `已复制表“${target.tableName}”及其数据为“${nextTableName}”。`
          : `已复制表“${target.tableName}”的结构为“${nextTableName}”。`);
      }
      setTableCatalogRefreshVersions((current) => ({
        ...current,
        [target.connectionId]: (current[target.connectionId] ?? 0) + 1,
      }));
      setPendingTableNameAction(null);
    } catch (error: unknown) {
      if (target.action === "duplicate" && duplicateStructureCreated) {
        setPendingTableNameAction(null);
        setTableCatalogRefreshVersions((current) => ({
          ...current,
          [target.connectionId]: (current[target.connectionId] ?? 0) + 1,
        }));
        toasts.error.show(
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
    const inspectionSql = redisKeyInspectionCommands(keyName);
    connections.selectConnection(connectionId);
    setSelectedRedisDatabases((current) => ({ ...current, [connectionId]: database }));
    const title = redisKeyWorkspaceTitle(profile.name, database, keyName);
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

  /**
   * Moves one open table tab to a new position in the shared tab strip.
   * @param tabId - Table tab being dragged.
   * @param targetIndex - Destination index among the open table tabs.
   * @returns Nothing (`void`).
   * Side effects: reorders session-local table tabs without touching their workspaces.
   */
  function handleReorderTableTab(tabId: string, targetIndex: number): void {
    setOpenTableTabs((current) => {
      const fromIndex = current.findIndex((tab) => tab.id === tabId);
      if (fromIndex === -1) {
        return current;
      }
      const toIndex = Math.min(Math.max(targetIndex, 0), current.length - 1);
      if (fromIndex === toIndex) {
        return current;
      }
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) {
        return current;
      }
      next.splice(toIndex, 0, moved);
      return next;
    });
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
    toasts.error.clear();
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
        toasts.error.show(getConnectionActionError(error, "无法分离查询工作区，请重试。"));
      } finally {
        setDetachingWorkspaceId(null);
      }
      return;
    }

    const tableTab = openTableTabs.find((tab) => tab.id === request.tabId);
    if (!tableTab || dirtyTableTabIds.has(tableTab.id)) {
      toasts.error.show("请先提交或撤销表修改，再分离该工作区。");
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
      toasts.error.show(getConnectionActionError(error, "无法分离表工作区，请重试。"));
    } finally {
      setDetachingWorkspaceId(null);
    }
  }

  /**
   * Lists every open workspace in the exact order the shared tab strip renders it.
   * Parameters: none.
   * @returns Ordered tab identities across the query, table, and utility collections.
   * Side effects: none.
   */
  function orderedWorkspaceTabs(): WorkspaceTabRef[] {
    return orderWorkspaceTabs({
      queryTabIds: queryWorkspace.tabs.map((tab) => tab.id),
      tableTabIds: openTableTabs.map((tab) => tab.id),
      utilityTabIds: openUtilityTabs.map((tab) => tab.id),
    });
  }

  /**
   * Activates one workspace by its identity and collection.
   * @param tab - Ordered tab identity resolved from the shared strip.
   * @returns Nothing (`void`).
   * Side effects: updates the active workspace and session-local recency.
   */
  function activateWorkspaceTab(tab: WorkspaceTabRef): void {
    if (tab.type === "query") {
      handleSelectQueryTab(tab.id);
    } else if (tab.type === "table") {
      handleSelectTableTab(tab.id);
    } else {
      handleSelectUtilityTab(tab.id);
    }
  }

  /**
   * Jumps directly to the nth open workspace in the shared tab strip.
   * @param position - One-based position; 9 always selects the last tab.
   * @returns `true` when a tab was activated, so the caller can consume the event.
   * Side effects: activates one workspace; a running query keeps executing in the background.
   */
  function jumpToWorkspaceTab(position: number): boolean {
    const targetTab = resolveWorkspaceTabJump(orderedWorkspaceTabs(), position);
    if (!targetTab) {
      return false;
    }
    activateWorkspaceTab(targetTab);
    return true;
  }

  /**
   * Cycles through every open workspace tab.
   *
   * A running query keeps executing while hidden, so navigation stays available.
   * @param reverse - Whether to move to the previous tab instead of the next.
   * @returns Nothing (`void`).
   * Side effects: activates the adjacent workspace.
   */
  function cycleWorkspaceTabs(reverse: boolean): void {
    const currentId = activeUtilityTabId ?? activeTableTabId ?? queryWorkspace.activeTabId;
    const nextTab = resolveWorkspaceTabCycle(orderedWorkspaceTabs(), currentId, reverse);
    if (nextTab) {
      activateWorkspaceTab(nextTab);
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
        connectionForm.open ||
        deleteCandidate ||
        pendingCloseTableId ||
        pendingTableAction ||
        renameCandidate ||
        databaseOperations.createTarget ||
        databaseOperations.dropTarget ||
        commandPaletteOpen ||
        mcpPanelOpen ||
        shortcutHelpOpen
      ) {
        return;
      }
      if (handleScopedSelectAll(event, (candidate) => matchesShortcut(candidate, "Mod+A"))) {
        return;
      }
      const intent = resolveWorkspaceShortcut(event, shortcuts.bindings);
      if (!intent) {
        return;
      }
      if (intent.kind === "openCommandPalette") {
        event.preventDefault();
        openCommandPalette();
        return;
      }
      if (intent.kind === "openShortcutHelp") {
        event.preventDefault();
        openShortcutDialog("help");
        return;
      }
      if (intent.kind === "toggleSidebar") {
        event.preventDefault();
        handleToggleSidebar();
        return;
      }
      if (intent.kind === "newQuery") {
        event.preventDefault();
        // A running query owns the only tab that must stay mounted, so creating one is deferred.
        if (busyQueryTabId === null) {
          handleCreateQuery();
        }
        return;
      }
      if (intent.kind === "closeWorkspace") {
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
      if (intent.kind === "jumpToTab") {
        // Only consume the press when a tab actually occupies that position.
        if (jumpToWorkspaceTab(intent.position)) {
          event.preventDefault();
        }
        return;
      }
      event.preventDefault();
      cycleWorkspaceTabs(intent.reverse);
    }
    document.addEventListener("keydown", handleWorkspaceShortcut, true);
    return () => document.removeEventListener("keydown", handleWorkspaceShortcut, true);
  });

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
    connectionForm.close();
    void queryWorkspace.retryLoad();
  }

  return (
    <div
      className={`app-shell${sidebar.collapsed ? " app-shell--sidebar-collapsed" : ""}`}
      style={{ "--sidebar-width": `${sidebar.width}px` } as CSSProperties}
      role="application"
      aria-label="Pipa 数据库工作台"
    >
      <aside className="activity-rail" aria-label="主功能">
        <span className="product-mark" aria-label="Pipa">P</span>
        <button
          aria-controls="connection-panel"
          aria-expanded={!sidebar.collapsed}
          aria-label={sidebar.collapsed ? "展开连接侧边栏" : "收起连接侧边栏"}
          className={`activity-rail__toggle${sidebar.collapsed ? "" : " is-active"}`}
          onClick={() => handleToggleSidebar()}
          ref={sidebar.toggleRef}
          title={`连接侧边栏（${shortcutLabel("toggleSidebar")}）`}
          type="button"
        >
          <PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </aside>
      <nav
        aria-hidden={sidebar.collapsed || undefined}
        aria-label="数据库连接"
        className="connection-panel"
        id="connection-panel"
        inert={sidebar.collapsed}
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
          onAddConnection={connectionForm.start}
          onFindTables={openTableFinder}
          onFocusConnectionHandled={() => setFocusConnectionId(null)}
          onOpenConnectionManager={handleOpenConnectionManager}
          onOpenRedisKey={handleOpenRedisKey}
          onOpenTable={handleOpenTable}
          onRequestCreateDatabase={databaseOperations.requestCreate}
          onRequestTableAction={handleRequestTableAction}
          onSelectRedisDatabase={handleSelectRedisDatabase}
          onTablesLoaded={handleTablesLoaded}
          openObjects={openTableObjects}
          pinnedTableKeys={pinnedTableKeys}
          profiles={connections.profiles}
          selectedConnectionId={connections.selectedConnectionId}
          selectedRedisDatabases={selectedRedisDatabases}
          selectedDatabases={selectedDatabases}
          onSelectDatabase={handleSelectDatabase}
          tableCatalog={tableCatalog}
          tableCatalogRefreshVersions={tableCatalogRefreshVersions}
        />
      </nav>
      <SidebarResizer
        onWidthChange={sidebar.setWidth}
        onWidthCommit={sidebar.commitWidth}
        width={sidebar.width}
      />

      <main className="workspace" aria-label="查询工作区">
        <header className="workspace__topbar">
          {/*
            * The picker is always present, even inside a utility workspace: it states which
            * connection the navigator is on and is the one place to switch or manage connections.
            */}
          <ConnectionPicker
            activeDatabase={activeNavigatorProfile
              ? selectedDatabases[activeNavigatorProfile.id]
                ?? activeNavigatorProfile.database
                ?? null
              : null}
            activeProfile={activeNavigatorProfile}
            onAddConnection={connectionForm.start}
            onCopyConfig={(profile) => void handleCopyConnectionConfig(profile)}
            onEditConnection={(profile) => handleOpenConnectionManager(profile.id, "profile")}
            onOpenConnectionManager={() => handleOpenConnectionManager()}
            onReconnect={(profile) => void handleReconnectConnection(profile)}
            onRequestCreateDatabase={databaseOperations.requestCreate}
            onRequestDelete={handleRequestDeleteConnection}
            onRequestRename={handleRequestRenameConnection}
            onSelectConnection={handleSelectConnection}
            profiles={connections.profiles}
            reconnectingConnectionId={reconnectingConnectionId}
          />
          <span className="workspace__topbar-actions">
            {/* Primary global entry point: everything else is reachable from here. */}
            <button
              aria-label={`打开命令面板（${shortcutLabel("commandPalette")}）`}
              className="workspace__topbar-primary"
              onClick={openCommandPalette}
              title={`打开命令面板（${shortcutLabel("commandPalette")}）`}
              type="button"
            >
              <CommandIcon size={13} aria-hidden="true" />
              命令
              <kbd>{shortcutLabel("commandPalette")}</kbd>
            </button>

            <span className="workspace__topbar-divider" aria-hidden="true" />

            {/* Workspace destinations. */}
            <button
              aria-label="打开连接管理"
              className={isConnectionManagerActive ? "is-active" : undefined}
              onClick={() => handleOpenConnectionManager()}
              title="管理连接配置与数据库"
              type="button"
            >
              <Server size={14} aria-hidden="true" />
              连接
            </button>
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
              aria-label={mcpPendingApprovals > 0
                ? `打开 MCP 控制台，${mcpPendingApprovals} 条 SQL 待确认`
                : "打开 MCP 控制台"}
              className={`workspace__topbar-icon${
                mcpPendingApprovals > 0 ? " has-pending" : ""
              }`}
              onClick={() => setMcpPanelOpen(true)}
              title={mcpPendingApprovals > 0
                ? `MCP 控制台 · ${mcpPendingApprovals} 条 SQL 等待确认`
                : "MCP 控制台"}
              type="button"
            >
              <Server size={14} aria-hidden="true" />
              {mcpPendingApprovals > 0 ? (
                <span className="workspace__topbar-pending" aria-hidden="true">
                  {mcpPendingApprovals > 9 ? "9+" : mcpPendingApprovals}
                </span>
              ) : null}
            </button>

            <span className="workspace__topbar-divider" aria-hidden="true" />

            {/* Application preferences and status. */}
            <button
              aria-label="打开快捷键设置"
              className="workspace__topbar-icon"
              onClick={() => openShortcutDialog("settings")}
              title={`快捷键设置（${shortcutLabel("shortcutHelp")}）`}
              type="button"
            >
              <Keyboard size={14} aria-hidden="true" />
            </button>
            <UpdateControl />
            <ThemeToggle preference={theme.preference} onChange={theme.setPreference} />
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
            <WorkspaceRecoveryNotice
              error={queryWorkspace.loadError}
              onRetry={handleRetryWorkspaceRecovery}
              retrying={queryWorkspace.loading}
            />
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
                onReorderQuery={queryWorkspace.reorderTab}
                onReorderTable={handleReorderTableTab}
                onSelectQuery={handleSelectQueryTab}
                onSelectTable={handleSelectTableTab}
                onSelectUtility={handleSelectUtilityTab}
                queryTabs={queryWorkspace.tabs}
                tableTabs={openTableTabs}
                utilityTabs={openUtilityTabs}
              />
              <div className="workspace-tab-panels">
                <QueryTabPanels
                  activeQueryTabId={queryWorkspace.activeTabId}
                  onDatabaseChange={handleSelectRedisDatabase}
                  onRetryPersistence={queryWorkspace.retrySave}
                  onRunningChange={handleQueryRunningChange}
                  onSqlChange={queryWorkspace.updateTabSql}
                  persistenceError={queryWorkspace.saveError}
                  profiles={queryWorkspaceProfiles}
                  tableWorkspaceActive={activeTableTabId !== null}
                  tabs={queryWorkspace.tabs}
                  theme={theme.resolvedTheme}
                  utilityWorkspaceActive={activeUtilityTabId !== null}
                />
                <TableTabPanels
                  activeTableTabId={activeTableTabId}
                  onDirtyChange={handleTableDirtyChange}
                  profiles={connections.profiles}
                  tabs={openTableTabs}
                  utilityWorkspaceActive={activeUtilityTabId !== null}
                />
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
                {connectionManagerOpen ? (
                  <div
                    aria-labelledby={`workspace-tab-${CONNECTION_MANAGER_TAB.id}`}
                    className="workspace-tab-panel"
                    hidden={!isConnectionManagerActive}
                    id={`workspace-panel-${CONNECTION_MANAGER_TAB.id}`}
                    role="tabpanel"
                  >
                    <ConnectionManager
                      databaseRefreshVersion={databaseRefreshVersion}
                      requestToken={connectionManagerRequestToken}
                      requestedView={connectionManagerRequest?.view ?? null}
                      onAddConnection={connectionForm.start}
                      onProfileUpdated={handleConnectionProfileUpdated}
                      onRequestCreateDatabase={databaseOperations.requestCreate}
                      onRequestDeleteConnection={handleRequestDeleteConnection}
                      onRequestDeleteDatabase={databaseOperations.requestDrop}
                      onSelectConnection={handleSelectConnection}
                      profiles={connections.profiles}
                      selectedConnectionId={connections.selectedConnectionId}
                    />
                  </div>
                ) : null}
              </div>
            </section>
          ) : (
            <ConnectionOverview
              newQueryProfile={newQueryProfile}
              onAddConnection={connectionForm.start}
              onCreateQuery={handleCreateQuery}
              onOpenBinlog={handleOpenBinlogWorkspace}
              onOpenCommandPalette={openCommandPalette}
              onOpenMcp={() => setMcpPanelOpen(true)}
              onOpenShortcutHelp={() => openShortcutDialog("help")}
              orphanedQueryWorkspace={Boolean(queryWorkspace.activeTab)}
              selectedProfile={selectedProfile ?? null}
              shortcutLabel={shortcutLabel}
            />
          )}
        </div>
      </main>
      {connectionForm.open ? (
        <div
          aria-labelledby={connectionForm.engine ? "connection-form-title" : "connection-type-title"}
          aria-modal="true"
          className="connection-flow-backdrop"
          role="dialog"
        >
          {connectionForm.engine ? (
            <ConnectionForm
              engine={connectionForm.engine}
              onCancel={connectionForm.clearEngine}
              onSaved={handleConnectionSaved}
            />
          ) : (
            <ConnectionTypePicker
              onCancel={connectionForm.close}
              onSelect={connectionForm.selectEngine}
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
      <RenameConnectionDialog
        error={toasts.error.message}
        key={renameCandidate?.id ?? "none"}
        onCancel={handleCancelRenameConnection}
        onConfirm={(name) => void handleConfirmRenameConnection(name)}
        profile={renameCandidate}
        saving={renamingConnectionId !== null}
      />
      <CreateDatabaseDialog
        creating={databaseOperations.creating}
        error={databaseOperations.createError}
        key={`create-${databaseOperations.createTarget?.id ?? "none"}`}
        onCancel={databaseOperations.cancelCreate}
        onConfirm={(request) => void databaseOperations.confirmCreate(request)}
        profile={databaseOperations.createTarget}
      />
      <DropDatabaseDialog
        database={databaseOperations.dropTargetDatabase}
        dropping={databaseOperations.dropping}
        error={databaseOperations.dropError}
        key={`drop-${databaseOperations.dropTarget?.id ?? "none"}-${databaseOperations.dropTargetDatabase ?? ""}`}
        onCancel={databaseOperations.cancelDrop}
        onConfirm={() => void databaseOperations.confirmDrop()}
        profile={databaseOperations.dropTarget}
      />
      <TableNameActionDialog
        action={pendingTableNameAction?.action ?? null}
        error={tableNameActionError}
        executing={executingTableNameAction}
        hasDirtyWorkspace={pendingTableNameActionHasDirtyWorkspace}
        key={`table-name-${pendingTableNameAction?.action ?? "none"}-${pendingTableNameAction?.tableName ?? ""}`}
        onCancel={handleCancelTableNameAction}
        onConfirm={(request) => void handleConfirmTableNameAction(request)}
        profile={pendingTableNameActionProfile}
        tableName={pendingTableNameAction?.tableName ?? null}
      />
      <TableDdlPreviewDialog
        onClose={tableUtilityActions.closeDdlPreview}
        onCopy={(sql, message) => void tableUtilityActions.copyText(sql, message)}
        preview={tableUtilityActions.ddlPreview}
      />
      <TableDestructiveActionDialog
        action={pendingTableAction?.action ?? null}
        error={tableActionError}
        executing={executingTableAction}
        hasDirtyWorkspace={pendingTableActionHasDirtyWorkspace}
        onCancel={handleCancelTableAction}
        onConfirm={() => void handleConfirmTableAction()}
        profile={pendingTableActionProfile}
        tableName={pendingTableAction?.tableName ?? null}
      />
      <DeleteConnectionDialog
        blockedByRunningQuery={deleteBlockedByRunningQuery}
        deleting={deletingConnectionId !== null}
        error={connectionDeletionError}
        onCancel={handleCancelDeleteConnection}
        onConfirm={() => void handleConfirmDeleteConnection()}
        profile={deleteCandidate}
        workspaceCount={deleteCandidateWorkspaceCount}
      />
      <DiscardTableChangesDialog
        onCancel={cancelPendingTableClose}
        onDiscard={() => {
          const tabId = pendingCloseTable?.id;
          setPendingCloseTableId(null);
          if (tabId) {
            closeTableImmediately(tabId);
          }
        }}
        tableName={pendingCloseTable?.tableName ?? null}
      />
      {toasts.notice.message ? <p className="app-toast" role="status">{toasts.notice.message}</p> : null}
      {toasts.error.message && !renameCandidate ? <p className="app-toast app-toast--error" role="alert">{toasts.error.message}</p> : null}
    </div>
  );
}
