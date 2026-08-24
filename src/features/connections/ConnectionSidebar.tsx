import { Check, ChevronRight, Copy, Database, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Search, Table2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { CellValue } from "../../bindings/CellValue";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { Engine } from "../../bindings/Engine";
import type { Environment } from "../../bindings/Environment";
import { getShortcutKeyLabels, matchesShortcut, useShortcutSettings } from "../commands/shortcutRegistry";
import {
  loadEngineSectionCollapseOverrides,
  loadExpandedConnectionIds,
  persistEngineSectionCollapseOverrides,
  persistExpandedConnectionIds,
} from "../preferences/sidebarLayout";
import { executeQueryOnce } from "../query/executeQueryOnce";
import { useQuerySession } from "../query/useQuerySession";
import {
  TableActionMenu,
  tableTargetKey,
  type TableQuickAction,
} from "../tables/TableActionMenu";

interface ConnectionSidebarProps {
  discoverTables?: boolean;
  discoverTablesForConnectionId?: string | null;
  dirtyTables?: readonly { connectionId: string; tableName: string }[];
  focusConnectionId?: string | null;
  profiles: ConnectionProfile[];
  pinnedTableKeys?: ReadonlySet<string>;
  selectedConnectionId: string | null;
  /** Tables, views, and Redis keys already open as workspace tabs. */
  openObjects?: readonly { connectionId: string; objectName: string }[];
  tableCatalog?: Readonly<Record<string, readonly string[]>>;
  tableCatalogRefreshVersions?: Readonly<Record<string, number>>;
  onFocusConnectionHandled?: () => void;
  onFindTables?: (connectionId?: string) => void;
  onSelectConnection: (id: string) => void;
  onAddConnection: () => void;
  onCopyConfig?: (profile: ConnectionProfile) => void;
  onOpenRedisKey?: (connectionId: string, database: string, keyName: string) => void;
  onOpenTable?: (connectionId: string, tableName: string) => void;
  onReconnect?: (profile: ConnectionProfile) => void;
  onRequestRename?: (profile: ConnectionProfile) => void;
  onRequestDelete?: (profile: ConnectionProfile) => void;
  onSelectRedisDatabase?: (connectionId: string, database: string) => void;
  onRequestTableAction?: (
    connectionId: string,
    tableName: string,
    action: TableQuickAction,
  ) => void;
  onTablesLoaded?: (connectionId: string, tableNames: string[]) => void;
  reconnectingConnectionId?: string | null;
  selectedRedisDatabases?: Readonly<Record<string, string>>;
}

interface EngineGroup {
  engine: Engine;
  label: string;
}

interface ConnectionDrawerProps {
  discoverTables: boolean;
  dirtyTableNames: ReadonlySet<string>;
  expanded: boolean;
  profile: ConnectionProfile;
  pinnedTableKeys: ReadonlySet<string>;
  selected: boolean;
  tableFilter: string;
  tableCatalogRefreshVersion: number;
  /** Object names already open as workspace tabs for this connection. */
  openObjectNames: ReadonlySet<string>;
  /** Row that currently owns the navigator's single Tab stop. */
  activeRowKey: TreeRowKey | null;
  onActiveRowKeyChange: (rowKey: TreeRowKey) => void;
  onOpenRedisKey?: (connectionId: string, database: string, keyName: string) => void;
  onOpenTable?: (connectionId: string, tableName: string) => void;
  onFindTables?: (connectionId?: string) => void;
  onOpenContextMenu: (profile: ConnectionProfile, x: number, y: number) => void;
  onOpenTableContextMenu: (
    connectionId: string,
    tableName: string,
    x: number,
    y: number,
  ) => void;
  onSelect: (connectionId: string) => void;
  onSelectRedisDatabase?: (connectionId: string, database: string) => void;
  onTablesLoaded?: (connectionId: string, tableNames: string[]) => void;
  onToggle: (connectionId: string) => void;
  selectedRedisDatabase?: string;
}

interface RedisDatabaseInfo {
  database: string;
  keys: number;
  expires: number;
  averageTtlMs: number;
}

/**
 * Returns whether a connection's identity fields match a normalized navigator query.
 * @param profile - Saved connection profile.
 * @param normalizedQuery - Lowercased trimmed search text.
 * @returns `true` when name, host, port, or database contains the query.
 * Side effects: none.
 */
function connectionIdentityMatches(profile: ConnectionProfile, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }
  return [profile.name, profile.host, String(profile.port), profile.database ?? ""]
    .join(" ")
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}

interface ConnectionContextMenuState {
  profileId: string;
  x: number;
  y: number;
}

interface TableContextMenuState {
  connectionId: string;
  tableName: string;
  x: number;
  y: number;
}

/** Shared empty set so connections without open objects keep a stable prop reference. */
const EMPTY_NAME_SET: ReadonlySet<string> = new Set();

const ENGINE_GROUPS: readonly EngineGroup[] = [
  { engine: "my_sql", label: "MySQL" },
  { engine: "postgre_sql", label: "PostgreSQL" },
  { engine: "mongo_db", label: "MongoDB" },
  { engine: "redis", label: "Redis" },
];

/** Stable identity for one navigable sidebar row, used for roving tabindex. */
type TreeRowKey = string;

/** Builds the row key for one connection row. */
function connectionRowKey(connectionId: string): TreeRowKey {
  return `connection\u0000${connectionId}`;
}

/** Builds the row key for one table, view, or Redis key row. */
function objectRowKey(connectionId: string, objectName: string): TreeRowKey {
  return `object\u0000${connectionId}\u0000${objectName}`;
}

/** Builds the row key for one Redis database row. */
function redisDatabaseRowKey(connectionId: string, database: string): TreeRowKey {
  return `database\u0000${connectionId}\u0000${database}`;
}

/**
 * Moves focus to the adjacent visible tree row across every connection and its children.
 *
 * The sidebar renders each drawer's children directly after its connection row, so document
 * order already matches the visual tree order. Querying the whole navigator keeps a single
 * traversal ring instead of the per-container rings that previously trapped arrow keys.
 * @param origin - Row element the keyboard event started from.
 * @param target - Offset step, or an absolute end of the ring.
 * @returns The newly focused row element, or null when the ring has no such row.
 * Side effects: moves DOM focus and scrolls the row into view.
 */
function focusAdjacentTreeRow(
  origin: HTMLElement,
  target: -1 | 1 | "first" | "last",
): HTMLElement | null {
  // Collapsed engine sections stay mounted behind `hidden`, so they must be skipped; every other
  // collapsed level is unmounted and therefore absent from the query already.
  const rows = Array.from(
    origin.closest(".connection-groups")?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? [],
  ).filter((row) => row === origin || row.closest("[hidden]") === null);
  if (rows.length === 0) {
    return null;
  }
  const nextRow = target === "first"
    ? rows[0]
    : target === "last"
      ? rows[rows.length - 1]
      : rows[rows.indexOf(origin) + target];
  if (!nextRow || nextRow === origin) {
    return null;
  }
  nextRow.focus();
  nextRow.scrollIntoView?.({ block: "nearest" });
  return nextRow;
}

/**
 * Returns a compact, user-facing label for a profile environment.
 * @param environment - Stored connection environment.
 * @returns The corresponding Chinese badge label.
 * Side effects: none.
 */
function getEnvironmentLabel(environment: Environment): string {
  const labels: Record<Environment, string> = {
    production: "生产",
    development: "开发",
    unspecified: "未指定",
  };
  return labels[environment];
}

/**
 * Converts a streamed metadata cell into text without losing exact numeric values.
 * @param cell - Optional transport-safe database cell.
 * @returns Compact table-tree text.
 * Side effects: none.
 */
function cellText(cell: CellValue | undefined): string {
  if (!cell || cell.kind === "null") {
    return "";
  }
  if (cell.kind === "boolean") {
    return cell.value ? "true" : "false";
  }
  if (cell.kind === "json") {
    return cell.value;
  }
  if (cell.kind === "binary") {
    return "Binary";
  }
  return String(cell.value);
}

/**
 * Returns the metadata command used to populate one MySQL connection drawer.
 * Parameters: none.
 * @returns Native MySQL table metadata command.
 * Side effects: none.
 */
function metadataCommand(): string {
  return "SHOW FULL TABLES;";
}

/**
 * Extracts the table identity from one MySQL metadata result row.
 * @param row - Streamed result row.
 * @returns MySQL table name.
 * Side effects: none.
 */
function objectName(row: CellValue[]): string {
  return cellText(row[0]);
}

/**
 * Parses Redis INFO keyspace text and always retains the effective default database.
 * @param infoText - Raw INFO keyspace response.
 * @param fallbackDatabase - Configured database, or Redis' implicit DB 0.
 * @returns Numerically ordered database summaries.
 * Side effects: none.
 */
function parseRedisDatabases(
  infoText: string,
  fallbackDatabase: string,
): RedisDatabaseInfo[] {
  const databases = new Map<string, RedisDatabaseInfo>();
  for (const line of infoText.split(/\r?\n/u)) {
    const match = line.match(/^db(\d+):keys=(\d+),expires=(\d+),avg_ttl=(\d+)$/u);
    if (!match) {
      continue;
    }
    const [, database, keys, expires, averageTtlMs] = match;
    if (database === undefined || keys === undefined || expires === undefined || averageTtlMs === undefined) {
      continue;
    }
    databases.set(database, {
      database,
      keys: Number(keys),
      expires: Number(expires),
      averageTtlMs: Number(averageTtlMs),
    });
  }
  if (!databases.has(fallbackDatabase)) {
    databases.set(fallbackDatabase, {
      database: fallbackDatabase,
      keys: 0,
      expires: 0,
      averageTtlMs: 0,
    });
  }
  return [...databases.values()].sort(
    (left, right) => Number(left.database) - Number(right.database),
  );
}

/**
 * Renders one independently expandable connection and its lazily loaded object list.
 * @param props - Connection identity, drawer state, and navigation callbacks.
 * @returns One selectable connection drawer.
 * Side effects: issues an internal metadata query only after explicit expansion or refresh.
 */
function ConnectionDrawer({
  discoverTables,
  dirtyTableNames,
  expanded,
  profile,
  pinnedTableKeys,
  selected,
  tableFilter,
  tableCatalogRefreshVersion,
  openObjectNames,
  activeRowKey,
  onActiveRowKeyChange,
  onOpenRedisKey,
  onOpenTable,
  onFindTables,
  onOpenContextMenu,
  onOpenTableContextMenu,
  onSelect,
  onSelectRedisDatabase,
  onTablesLoaded,
  onToggle,
  selectedRedisDatabase,
}: ConnectionDrawerProps) {
  const tables = useQuerySession(profile.id, { recordHistory: false });
  const connectionButtonRef = useRef<HTMLButtonElement>(null);
  const supportsExplorer = profile.engine === "my_sql" || profile.engine === "redis";
  const canExplore = profile.engine === "redis"
    || (profile.engine === "my_sql" && Boolean(profile.database));
  const isRedis = profile.engine === "redis";

  const [redisDatabases, setRedisDatabases] = useState<RedisDatabaseInfo[]>([]);
  const [expandedRedisDatabase, setExpandedRedisDatabase] = useState<string | null>(null);
  const [redisKeys, setRedisKeys] = useState<string[]>([]);
  const [redisDatabasesLoading, setRedisDatabasesLoading] = useState(false);
  const [redisKeysLoading, setRedisKeysLoading] = useState(false);
  const [redisExplorerError, setRedisExplorerError] = useState<string | null>(null);
  const redisDatabaseRequestIdRef = useRef(0);
  const redisKeyRequestIdRef = useRef(0);
  const tableCatalogRefreshVersionRef = useRef(0);
  const normalizedTableFilter = tableFilter.trim().toLocaleLowerCase();
  const objectRows = tables.state.rows.filter((row) => Boolean(objectName(row)));
  const visibleTableRows = objectRows
    .filter((row) => objectName(row).toLocaleLowerCase().includes(normalizedTableFilter))
    .sort((left, right) => (
      Number(pinnedTableKeys.has(tableTargetKey(profile.id, objectName(right))))
      - Number(pinnedTableKeys.has(tableTargetKey(profile.id, objectName(left))))
    ));
  const visibleRedisKeys = redisKeys.filter((key) =>
    key.toLocaleLowerCase().includes(normalizedTableFilter),
  );
  const effectiveRedisDatabase = selectedRedisDatabase ?? profile.database ?? "0";
  const displayedRedisDatabases = redisDatabases.some(
    (databaseInfo) => databaseInfo.database === effectiveRedisDatabase,
  )
    ? redisDatabases
    : [
        ...redisDatabases,
        {
          database: effectiveRedisDatabase,
          keys: 0,
          expires: 0,
          averageTtlMs: 0,
        },
      ].sort((left, right) => Number(left.database) - Number(right.database));

  useEffect(() => {
    if (
      profile.engine !== "my_sql"
      || !tables.state.queryId
      || tables.state.running
      || tables.state.error
    ) {
      return;
    }
    onTablesLoaded?.(
      profile.id,
      tables.state.rows.map((row) => cellText(row[0])).filter(Boolean),
    );
  }, [onTablesLoaded, profile.engine, profile.id, tables.state.error, tables.state.queryId, tables.state.rows, tables.state.running]);

  useEffect(() => {
    if (
      discoverTables
      && profile.engine === "my_sql"
      && canExplore
      && tables.state.queryId === null
      && !tables.state.running
    ) {
      void tables.run(metadataCommand());
    }
  }, [canExplore, discoverTables, profile, tables.run, tables.state.queryId, tables.state.running]);

  useEffect(() => {
    if (
      tableCatalogRefreshVersion === 0
      || tableCatalogRefreshVersionRef.current === tableCatalogRefreshVersion
      || profile.engine !== "my_sql"
      || !canExplore
      || tables.state.running
    ) {
      return;
    }
    tableCatalogRefreshVersionRef.current = tableCatalogRefreshVersion;
    void tables.run(metadataCommand());
  }, [canExplore, profile.engine, tableCatalogRefreshVersion, tables.run, tables.state.running]);

  /**
   * Loads the Redis database summaries without scanning any database keys.
   * Parameters: none.
   * @returns A promise settled after the latest INFO request updates the tree.
   * Side effects: executes INFO keyspace and updates Redis explorer state.
   */
  async function loadRedisDatabases(): Promise<void> {
    const requestId = redisDatabaseRequestIdRef.current + 1;
    redisDatabaseRequestIdRef.current = requestId;
    setRedisDatabasesLoading(true);
    setRedisExplorerError(null);
    try {
      const result = await executeQueryOnce(profile.id, "INFO keyspace");
      if (redisDatabaseRequestIdRef.current !== requestId) {
        return;
      }
      setRedisDatabases(parseRedisDatabases(
        cellText(result.rows[0]?.[0]),
        profile.database ?? "0",
      ));
    } catch (error: unknown) {
      if (redisDatabaseRequestIdRef.current !== requestId) {
        return;
      }
      setRedisExplorerError(
        typeof error === "object"
        && error !== null
        && "message" in error
        && typeof error.message === "string"
          ? error.message
          : "无法读取 Redis 数据库信息。",
      );
    } finally {
      if (redisDatabaseRequestIdRef.current === requestId) {
        setRedisDatabasesLoading(false);
      }
    }
  }

  /**
   * Selects one Redis database and loads only that database's first key page.
   * @param database - Redis logical database number.
   * @param forceRefresh - Whether an already open database should remain open and reload.
   * @returns A promise settled after the latest SCAN request updates the tree.
   * Side effects: updates the active database and executes a database-scoped SCAN.
   */
  async function openRedisDatabase(
    database: string,
    forceRefresh = false,
  ): Promise<void> {
    onSelect(profile.id);
    onSelectRedisDatabase?.(profile.id, database);
    if (expandedRedisDatabase === database && !forceRefresh) {
      setExpandedRedisDatabase(null);
      return;
    }

    const requestId = redisKeyRequestIdRef.current + 1;
    redisKeyRequestIdRef.current = requestId;
    setExpandedRedisDatabase(database);
    setRedisKeys([]);
    setRedisKeysLoading(true);
    setRedisExplorerError(null);
    try {
      const result = await executeQueryOnce(
        profile.id,
        'SCAN 0 MATCH "*" COUNT 500',
        database,
      );
      if (redisKeyRequestIdRef.current !== requestId) {
        return;
      }
      setRedisKeys(result.rows
        .map((row) => cellText(row[1]))
        .filter(Boolean));
    } catch (error: unknown) {
      if (redisKeyRequestIdRef.current !== requestId) {
        return;
      }
      setRedisExplorerError(
        typeof error === "object"
        && error !== null
        && "message" in error
        && typeof error.message === "string"
          ? error.message
          : `无法读取 DB ${database} 的键。`,
      );
    } finally {
      if (redisKeyRequestIdRef.current === requestId) {
        setRedisKeysLoading(false);
      }
    }
  }

  /**
   * Selects and toggles the drawer, loading table metadata only when it first opens.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: updates parent state and may start an engine-native metadata query.
   */
  function handleToggleRequested(): void {
    onSelect(profile.id);
    if (profile.engine !== "my_sql" && profile.engine !== "redis") {
      return;
    }
    onToggle(profile.id);
    if (expanded || !canExplore) {
      return;
    }
    if (isRedis) {
      if (redisDatabases.length === 0 && !redisDatabasesLoading) {
        void loadRedisDatabases();
      }
    } else if (tables.state.queryId === null) {
      void tables.run(metadataCommand());
    }
  }

  /**
   * Selects and toggles one connection on the first click of a click sequence.
   * @param event - Pointer click raised by the connection row.
   * @returns Nothing (`void`).
   * Side effects: may select the connection, toggle its drawer, and load object metadata.
   */
  function handleConnectionClick(event: MouseEvent<HTMLButtonElement>): void {
    if (event.detail > 1) {
      return;
    }
    handleToggleRequested();
  }

  /**
   * Moves focus to the adjacent row anywhere in the navigator and claims the Tab stop.
   * @param origin - Row the keyboard event started from.
   * @param target - Offset step, or an absolute end of the traversal ring.
   * @returns Nothing (`void`).
   * Side effects: moves focus and updates the roving tabindex owner.
   */
  function moveTreeFocus(origin: HTMLElement, target: -1 | 1 | "first" | "last"): void {
    const nextRow = focusAdjacentTreeRow(origin, target);
    if (!nextRow) {
      return;
    }
    const nextRowKey = nextRow.dataset.treeRow;
    if (nextRowKey) {
      onActiveRowKeyChange(nextRowKey);
    }
    // Landing on a connection row also makes it current, since the selected connection is what
    // new queries and the workspace scope follow.
    const nextConnectionId = nextRow.classList.contains("connection-row")
      ? nextRow.dataset.connectionId
      : undefined;
    if (nextConnectionId) {
      onSelect(nextConnectionId);
    }
  }

  /**
   * Reloads object metadata while retaining the open connection drawer.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: starts an engine-native metadata query.
   */
  function handleRefresh(): void {
    if (!canExplore) {
      return;
    }
    if (isRedis) {
      void loadRedisDatabases();
      if (expandedRedisDatabase) {
        void openRedisDatabase(expandedRedisDatabase, true);
      }
    } else if (!tables.state.running) {
      void tables.run(metadataCommand());
    }
  }

  /** Opens the connection action menu at the pointer location. */
  function handleContextMenu(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    onSelect(profile.id);
    onOpenContextMenu(profile, event.clientX, event.clientY);
  }

  /** Opens the same action menu from the platform context-menu keyboard shortcut. */
  function handleConnectionKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      onSelect(profile.id);
      onOpenContextMenu(profile, bounds.left + 24, bounds.bottom - 4);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveTreeFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveTreeFocus(event.currentTarget, event.key === "Home" ? "first" : "last");
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      // Right on an open drawer steps into its children rather than doing nothing.
      if (expanded) {
        moveTreeFocus(event.currentTarget, 1);
      } else {
        handleToggleRequested();
      }
      return;
    }

    if (event.key === "ArrowLeft" && expanded) {
      event.preventDefault();
      onToggle(profile.id);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleToggleRequested();
      return;
    }

    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      onToggle(profile.id);
    }
  }

  /**
   * Handles table-row navigation, opening, collapse, and the keyboard context menu.
   * @param event - Keyboard event raised by one table row.
   * @param tableName - Exact database-reported table name.
   * @param allowDestructiveActions - Whether the row is a base table rather than a view.
   * @returns Nothing (`void`).
   * Side effects: may move focus, select/open a table, collapse its drawer, or open its action menu.
   */
  function handleTableKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    tableName: string,
    allowDestructiveActions: boolean,
  ): void {
    if (
      allowDestructiveActions
      && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    ) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      onSelect(profile.id);
      onActiveRowKeyChange(objectRowKey(profile.id, tableName));
      onOpenTableContextMenu(profile.id, tableName, bounds.left + 24, bounds.bottom - 4);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      onOpenTable?.(profile.id, tableName);
      return;
    }

    if (event.key === "ArrowLeft") {
      // Left collapses back to the owning connection without discarding the drawer's contents
      // for the rest of the tree, matching the standard tree pattern.
      event.preventDefault();
      event.stopPropagation();
      onSelect(profile.id);
      onActiveRowKeyChange(connectionRowKey(profile.id));
      connectionButtonRef.current?.focus();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onSelect(profile.id);
      if (expanded) {
        onToggle(profile.id);
      }
      onActiveRowKeyChange(connectionRowKey(profile.id));
      connectionButtonRef.current?.focus();
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveTreeFocus(event.currentTarget, event.key === "Home" ? "first" : "last");
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    moveTreeFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
  }

  /**
   * Opens destructive table shortcuts without triggering the table workspace.
   * @param event - Native context-menu mouse event from the table row.
   * @param tableName - Exact database-reported table name.
   * @returns Nothing (`void`).
   * Side effects: selects the connection and table, then opens the positioned action menu.
   */
  function handleTableContextMenu(
    event: MouseEvent<HTMLButtonElement>,
    tableName: string,
  ): void {
    event.preventDefault();
    onSelect(profile.id);
    onActiveRowKeyChange(objectRowKey(profile.id, tableName));
    onOpenTableContextMenu(profile.id, tableName, event.clientX, event.clientY);
  }

  /**
   * Supports keyboard expansion and collapse for one Redis database row.
   * @param event - Keyboard event raised by the database tree item.
   * @param database - Redis logical database number.
   * @returns Nothing (`void`).
   * Side effects: may select a database and run its bounded SCAN query.
   */
  function handleRedisDatabaseKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    database: string,
  ): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void openRedisDatabase(database);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (expandedRedisDatabase === database) {
        moveTreeFocus(event.currentTarget, 1);
      } else {
        void openRedisDatabase(database);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (expandedRedisDatabase === database) {
        void openRedisDatabase(database);
        return;
      }
      onActiveRowKeyChange(connectionRowKey(profile.id));
      connectionButtonRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveTreeFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveTreeFocus(event.currentTarget, event.key === "Home" ? "first" : "last");
    }
  }

  /**
   * Opens one Redis key from the currently expanded database with Enter.
   * @param event - Keyboard event raised by the key tree item.
   * @param database - Owning Redis database.
   * @param keyName - Exact Redis key name.
   * @returns Nothing (`void`).
   * Side effects: activates the key workspace callback.
   */
  function handleRedisKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    database: string,
    keyName: string,
  ): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenRedisKey?.(profile.id, database, keyName);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveTreeFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveTreeFocus(event.currentTarget, event.key === "Home" ? "first" : "last");
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onActiveRowKeyChange(redisDatabaseRowKey(profile.id, database));
      const databaseRow = event.currentTarget
        .closest(".connection-groups")
        ?.querySelector<HTMLElement>(
          `[data-tree-row="${CSS.escape(redisDatabaseRowKey(profile.id, database))}"]`,
        );
      databaseRow?.focus();
    }
  }

  return (
    <div className={`connection-drawer${expanded ? " is-expanded" : ""}`}>
      <button
        aria-controls={supportsExplorer ? `connection-objects-${profile.id}` : undefined}
        aria-expanded={supportsExplorer ? expanded : undefined}
        aria-pressed={selected}
        aria-selected={selected}
        className={`connection-row${selected ? " is-selected" : ""}`}
        data-connection-id={profile.id}
        data-tree-row={connectionRowKey(profile.id)}
        onClick={handleConnectionClick}
        onContextMenu={handleContextMenu}
        onFocus={() => onActiveRowKeyChange(connectionRowKey(profile.id))}
        onKeyDown={handleConnectionKeyDown}
        ref={connectionButtonRef}
        tabIndex={activeRowKey === connectionRowKey(profile.id) ? 0 : -1}
        title={supportsExplorer
          ? `单击或按 Enter ${expanded ? "收起" : "展开"}${isRedis ? "数据库" : "数据表"}`
          : undefined}
        type="button"
      >
        <span className="connection-row__content">
          <span className="connection-row__title-line">
            <span className="connection-row__name">{profile.name}</span>
            <span className={`environment-badge environment-badge--${profile.environment}`}>
              {getEnvironmentLabel(profile.environment)}
            </span>
            {dirtyTableNames.size > 0 ? (
              <span
                aria-label={`${profile.name} 下有未提交修改`}
                className="object-dirty-indicator"
                title="此连接下有未提交的表修改"
              />
            ) : null}
          </span>
          <span
            className="connection-row__meta"
            title={isRedis
              ? `DB ${effectiveRedisDatabase} · ${profile.host}:${profile.port}`
              : `${profile.database ?? "未指定数据库"} · ${profile.host}:${profile.port}`}
          >
            {isRedis
              ? `DB ${effectiveRedisDatabase}${
                  selectedRedisDatabase === undefined && !profile.database ? "（默认）" : ""
                }`
              : profile.database ?? "未指定数据库"}
            <span aria-hidden="true"> · </span>
            {profile.host}:{profile.port}
          </span>
        </span>
        {supportsExplorer ? (
          <ChevronRight className="connection-row__chevron" size={14} aria-hidden="true" />
        ) : (
          <Check className="connection-row__check" size={15} aria-hidden="true" />
        )}
      </button>

      {expanded && supportsExplorer && isRedis ? (
        <div
          className="connection-drawer__body"
          aria-label={`${profile.name} 数据库`}
          id={`connection-objects-${profile.id}`}
        >
          <header className="connection-drawer__header">
            <span>数据库 <small>{displayedRedisDatabases.length}</small></span>
            <button
              aria-label={`刷新 ${profile.name} 数据库`}
              disabled={redisDatabasesLoading || redisKeysLoading}
              onClick={handleRefresh}
              type="button"
            >
              {redisDatabasesLoading || redisKeysLoading ? (
                <LoaderCircle className="spin" size={12} aria-hidden="true" />
              ) : (
                <RefreshCw size={12} aria-hidden="true" />
              )}
            </button>
          </header>
          {redisDatabasesLoading && redisDatabases.length === 0 ? (
            <p className="connection-drawer__status">正在读取数据库信息…</p>
          ) : redisExplorerError && redisDatabases.length === 0 ? (
            <p className="connection-drawer__status connection-drawer__status--error">
              {redisExplorerError}
            </p>
          ) : (
            <div className="redis-database-tree" role="tree">
              {displayedRedisDatabases.map((databaseInfo) => {
                const databaseExpanded = expandedRedisDatabase === databaseInfo.database;
                const databaseSelected = effectiveRedisDatabase === databaseInfo.database;
                return (
                  <div className="redis-database-tree__branch" key={databaseInfo.database}>
                    <button
                      aria-expanded={databaseExpanded}
                        aria-selected={databaseSelected}
                      className={`redis-database-tree__database${databaseSelected ? " is-selected" : ""}`}
                      data-tree-row={redisDatabaseRowKey(profile.id, databaseInfo.database)}
                      onClick={() => void openRedisDatabase(databaseInfo.database)}
                      onFocus={() => onActiveRowKeyChange(
                        redisDatabaseRowKey(profile.id, databaseInfo.database),
                      )}
                      onKeyDown={(event) => handleRedisDatabaseKeyDown(event, databaseInfo.database)}
                      role="treeitem"
                      tabIndex={activeRowKey === redisDatabaseRowKey(profile.id, databaseInfo.database)
                        ? 0
                        : -1}
                      title={`单击切换到 DB ${databaseInfo.database} 并浏览键；${
                        databaseInfo.keys
                      } 个键，${databaseInfo.expires} 个带过期时间${
                        databaseInfo.averageTtlMs > 0
                          ? `，平均 TTL ${databaseInfo.averageTtlMs} ms`
                          : ""
                      }`}
                      type="button"
                    >
                      <ChevronRight size={12} aria-hidden="true" />
                      <Database size={13} strokeWidth={1.7} aria-hidden="true" />
                      <span>DB {databaseInfo.database}</span>
                      <small>
                        {databaseInfo.keys} 键
                        {databaseInfo.expires > 0 ? ` · ${databaseInfo.expires} TTL` : ""}
                      </small>
                    </button>
                    {databaseExpanded ? (
                      <div
                        aria-label={`DB ${databaseInfo.database} 键`}
                        className="redis-database-tree__keys"
                        role="group"
                      >
                        {redisKeysLoading ? (
                          <p className="connection-drawer__status">正在读取 DB {databaseInfo.database} 的键…</p>
                        ) : redisExplorerError ? (
                          <p className="connection-drawer__status connection-drawer__status--error">
                            {redisExplorerError}
                          </p>
                        ) : visibleRedisKeys.length === 0 ? (
                          <p className="connection-drawer__status">
                            {redisKeys.length === 0 ? "此数据库暂无键。" : "没有匹配的键。"}
                          </p>
                        ) : visibleRedisKeys.map((keyName) => (
                          <button
                            aria-selected={activeRowKey === objectRowKey(profile.id, keyName)}
                            className={`table-tree__item redis-database-tree__key${openObjectNames.has(keyName) ? " is-open" : ""}`}
                            data-table-name={keyName}
                            data-tree-row={objectRowKey(profile.id, keyName)}
                            key={keyName}
                            onClick={() => {
                              onActiveRowKeyChange(objectRowKey(profile.id, keyName));
                              onOpenRedisKey?.(
                                profile.id,
                                databaseInfo.database,
                                keyName,
                              );
                            }}
                            onFocus={() => onActiveRowKeyChange(objectRowKey(profile.id, keyName))}
                            onKeyDown={(event) => handleRedisKeyDown(
                              event,
                              databaseInfo.database,
                              keyName,
                            )}
                            role="treeitem"
                            tabIndex={activeRowKey === objectRowKey(profile.id, keyName) ? 0 : -1}
                            title="单击或按 Enter 打开键工作区"
                            type="button"
                          >
                            <KeyRound size={13} strokeWidth={1.7} aria-hidden="true" />
                            <span>{keyName}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : expanded && supportsExplorer ? (
        <div
          className="connection-drawer__body"
          aria-label={`${profile.name} 数据表`}
          id={`connection-objects-${profile.id}`}
        >
          <header className="connection-drawer__header">
            <span>数据表 <small>{objectRows.length}</small></span>
            <span className="connection-drawer__actions">
              <button
                aria-label={`在 ${profile.name} 中查找数据表`}
                disabled={!canExplore}
                onClick={() => onFindTables?.(profile.id)}
                title="在完整列表中模糊查找"
                type="button"
              >
                <Search size={12} aria-hidden="true" />
              </button>
              <button
                aria-label={`刷新 ${profile.name} 数据表`}
                disabled={!canExplore || tables.state.running}
                onClick={handleRefresh}
                type="button"
              >
                {tables.state.running ? (
                  <LoaderCircle className="spin" size={12} aria-hidden="true" />
                ) : (
                  <RefreshCw size={12} aria-hidden="true" />
                )}
              </button>
            </span>
          </header>
          {!profile.database ? (
            <p className="connection-drawer__status">请先在连接中指定数据库。</p>
          ) : tables.state.error ? (
            <p className="connection-drawer__status connection-drawer__status--error">
              无法读取数据表：{tables.state.error.message}
            </p>
          ) : tables.state.running && tables.state.rows.length === 0 ? (
            <p className="connection-drawer__status">正在读取数据表…</p>
          ) : objectRows.length === 0 && tables.state.affectedRows !== null ? (
            <p className="connection-drawer__status">此数据库暂无数据表。</p>
          ) : visibleTableRows.length === 0 ? (
            <p className="connection-drawer__status">没有匹配的数据表。</p>
          ) : (
            <div className="table-tree" role="tree">
              {visibleTableRows.map((row, rowIndex) => {
                const tableName = objectName(row);
                const objectType = cellText(row[1]);
                const isDirty = dirtyTableNames.has(tableName);
                const isPinned = pinnedTableKeys.has(tableTargetKey(profile.id, tableName));
                return (
                  <button
                    aria-selected={activeRowKey === objectRowKey(profile.id, tableName)}
                    className={`table-tree__item${openObjectNames.has(tableName) ? " is-open" : ""}`}
                    data-connection-id={profile.id}
                    data-table-name={tableName}
                    data-tree-row={objectRowKey(profile.id, tableName)}
                    key={`${tableName}-${rowIndex}`}
                    onClick={() => {
                      onActiveRowKeyChange(objectRowKey(profile.id, tableName));
                      onOpenTable?.(profile.id, tableName);
                    }}
                    onContextMenu={objectType === "VIEW"
                      ? undefined
                      : (event) => handleTableContextMenu(event, tableName)}
                    onFocus={() => onActiveRowKeyChange(objectRowKey(profile.id, tableName))}
                    onKeyDown={(event) => handleTableKeyDown(
                      event,
                      tableName,
                      objectType !== "VIEW",
                    )}
                    role="treeitem"
                    tabIndex={activeRowKey === objectRowKey(profile.id, tableName) ? 0 : -1}
                    title={`${openObjectNames.has(tableName) ? "已在工作区打开；" : ""}${
                      objectType === "VIEW"
                        ? "单击或按 Enter 打开视图工作区"
                        : "单击或按 Enter 打开表工作区；右键可执行表操作"
                    }`}
                    type="button"
                  >
                    <Table2 size={13} strokeWidth={1.7} aria-hidden="true" />
                    <span>{tableName}</span>
                    <span className="table-tree__badges">
                      {isDirty ? (
                        <span
                          aria-label={`${tableName} 有未提交修改`}
                          className="object-dirty-indicator"
                          title="有未提交修改"
                        />
                      ) : null}
                      {isPinned ? <small>置顶</small> : null}
                      {objectType === "VIEW" ? <small>视图</small> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders engine groups with independently open connection drawers.
 * @param props - Saved profiles, selection, and connection/table actions.
 * @returns The engine-grouped connection navigator.
 * Side effects: owns only local drawer expansion state.
 */
export function ConnectionSidebar({
  discoverTables = false,
  discoverTablesForConnectionId = null,
  dirtyTables = [],
  focusConnectionId = null,
  pinnedTableKeys = new Set(),
  profiles,
  selectedConnectionId,
  openObjects = [],
  tableCatalog = {},
  tableCatalogRefreshVersions = {},
  onFocusConnectionHandled,
  onFindTables,
  onSelectConnection,
  onAddConnection,
  onCopyConfig,
  onOpenRedisKey,
  onOpenTable,
  onReconnect,
  onRequestRename,
  onRequestDelete,
  onRequestTableAction,
  onSelectRedisDatabase,
  onTablesLoaded,
  reconnectingConnectionId = null,
  selectedRedisDatabases = {},
}: ConnectionSidebarProps) {
  const shortcuts = useShortcutSettings();
  const [expandedConnectionIds, setExpandedConnectionIds] = useState<Set<string>>(
    loadExpandedConnectionIds,
  );
  const [engineCollapseOverrides, setEngineCollapseOverrides] = useState<Map<Engine, boolean>>(
    loadEngineSectionCollapseOverrides,
  );
  const [navigatorFilter, setNavigatorFilter] = useState("");
  const [activeRowKey, setActiveRowKey] = useState<TreeRowKey | null>(null);
  const [contextMenu, setContextMenu] = useState<ConnectionContextMenuState | null>(null);
  const [tableContextMenu, setTableContextMenu] = useState<TableContextMenuState | null>(null);
  const contextMenuItemRef = useRef<HTMLButtonElement>(null);
  const tableContextMenuItemRef = useRef<HTMLButtonElement>(null);
  const navigatorSearchRef = useRef<HTMLInputElement>(null);
  const contextProfile = profiles.find((profile) => profile.id === contextMenu?.profileId) ?? null;
  const focusProfile = focusConnectionId
    ? profiles.find((profile) => profile.id === focusConnectionId) ?? null
    : null;
  const normalizedNavigatorFilter = navigatorFilter.trim().toLocaleLowerCase();
  const openObjectNamesByConnection = useMemo(() => {
    const grouped = new Map<string, Set<string>>();
    for (const object of openObjects) {
      const names = grouped.get(object.connectionId) ?? new Set<string>();
      names.add(object.objectName);
      grouped.set(object.connectionId, names);
    }
    return grouped;
  }, [openObjects]);
  // Exactly one row owns the Tab stop. Before the user touches the tree, that is the first
  // visible connection, so tabbing in never lands on a row buried far down the list.
  const firstNavigableConnectionId = useMemo(() => {
    for (const { engine } of ENGINE_GROUPS) {
      const candidate = profiles.find((profile) => profile.engine === engine
        && (!normalizedNavigatorFilter || connectionIdentityMatches(profile, normalizedNavigatorFilter)));
      if (candidate) {
        return candidate.id;
      }
    }
    return null;
  }, [normalizedNavigatorFilter, profiles]);
  const effectiveActiveRowKey = activeRowKey
    ?? (firstNavigableConnectionId ? connectionRowKey(firstNavigableConnectionId) : null);

  useEffect(() => {
    // Restored expansion must not keep ids for connections the user has since deleted.
    if (profiles.length === 0) {
      return;
    }
    setExpandedConnectionIds((current) => {
      const pruned = new Set(
        [...current].filter((id) => profiles.some((profile) => profile.id === id)),
      );
      if (pruned.size === current.size) {
        return current;
      }
      persistExpandedConnectionIds(pruned);
      return pruned;
    });
  }, [profiles]);

  useEffect(() => {
    if (!focusConnectionId) {
      return;
    }
    if (focusProfile) {
      setEngineCollapseOverrides((current) => {
        if (current.get(focusProfile.engine) === false) {
          return current;
        }
        const next = new Map(current);
        next.set(focusProfile.engine, false);
        persistEngineSectionCollapseOverrides(next);
        return next;
      });
    }
    setExpandedConnectionIds((current) => {
      if (current.has(focusConnectionId)) {
        return current;
      }
      const next = new Set(current);
      next.add(focusConnectionId);
      persistExpandedConnectionIds(next);
      return next;
    });
    // Wait a frame so the panel can leave `inert` before focusing the row.
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const trigger = document.querySelector<HTMLButtonElement>(
          `.connection-row[data-connection-id="${focusConnectionId}"]`,
        );
        trigger?.focus();
        trigger?.scrollIntoView?.({ block: "nearest" });
        onFocusConnectionHandled?.();
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusConnectionId, focusProfile, onFocusConnectionHandled]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const contextProfileId = contextMenu.profileId;
    contextMenuItemRef.current?.focus();

    /** Closes the menu after an outside pointer action. */
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".connection-context-menu")) {
        setContextMenu(null);
      }
    }

    /** Closes the menu with Escape while leaving destructive action explicit. */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        const trigger = document.querySelector<HTMLButtonElement>(
          `[data-connection-id="${contextProfileId}"]`,
        );
        setContextMenu(null);
        window.requestAnimationFrame(() => trigger?.focus());
      }
    }

    /** Closes the position-bound menu when its viewport geometry changes. */
    function handleViewportChange(): void {
      setContextMenu(null);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("blur", handleViewportChange);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("blur", handleViewportChange);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!tableContextMenu) {
      return;
    }
    const { connectionId, tableName } = tableContextMenu;
    tableContextMenuItemRef.current?.focus();

    /**
     * Closes the table menu after an outside pointer action.
     * @param event - Document-level pointer event.
     * @returns Nothing (`void`).
     * Side effects: may clear the active table menu.
     */
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".table-context-menu")) {
        setTableContextMenu(null);
      }
    }

    /**
     * Closes the table menu with Escape and returns focus to its table row.
     * @param event - Document-level keyboard event.
     * @returns Nothing (`void`).
     * Side effects: clears the active menu and schedules focus restoration.
     */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape") {
        return;
      }
      const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>(
        ".table-tree__item[data-connection-id][data-table-name]",
      )).find((item) => (
        item.dataset.connectionId === connectionId
        && item.dataset.tableName === tableName
      ));
      setTableContextMenu(null);
      window.requestAnimationFrame(() => trigger?.focus());
    }

    /**
     * Closes the position-bound table menu when viewport geometry changes.
     * Parameters: none.
     * @returns Nothing (`void`).
     * Side effects: clears the active table menu.
     */
    function handleViewportChange(): void {
      setTableContextMenu(null);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("blur", handleViewportChange);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("blur", handleViewportChange);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [tableContextMenu]);

  /**
   * Toggles exactly one drawer while preserving every other expanded connection.
   * @param connectionId - Drawer connection identifier.
   * @returns Nothing (`void`).
   * Side effects: updates expansion state and persists it for the next session.
   */
  function handleToggleConnection(connectionId: string): void {
    setExpandedConnectionIds((current) => {
      const next = new Set(current);
      if (next.has(connectionId)) {
        next.delete(connectionId);
      } else {
        next.add(connectionId);
      }
      persistExpandedConnectionIds(next);
      return next;
    });
  }

  /**
   * Returns whether an engine section should render collapsed.
   * Empty groups collapse by default; search hits and locate-focus force open.
   * @param engine - Engine group identifier.
   * @param totalCount - Saved connections for that engine.
   * @param visibleCount - Connections still visible under the navigator filter.
   * @returns `true` when the section body should be hidden.
   * Side effects: none.
   */
  function isEngineSectionCollapsed(
    engine: Engine,
    totalCount: number,
    visibleCount: number,
  ): boolean {
    if (normalizedNavigatorFilter && visibleCount > 0) {
      return false;
    }
    if (focusProfile?.engine === engine) {
      return false;
    }
    const override = engineCollapseOverrides.get(engine);
    if (override !== undefined) {
      return override;
    }
    return totalCount === 0;
  }

  /**
   * Toggles one engine section and remembers the choice across sessions.
   * @param engine - Engine group to collapse or expand.
   * @param currentlyCollapsed - Current effective collapsed state before the click.
   * @returns Nothing (`void`).
   * Side effects: updates React state and persists the override map.
   */
  function handleToggleEngineSection(engine: Engine, currentlyCollapsed: boolean): void {
    setEngineCollapseOverrides((current) => {
      const next = new Map(current);
      next.set(engine, !currentlyCollapsed);
      persistEngineSectionCollapseOverrides(next);
      return next;
    });
  }

  /** Opens the compact action menu within the visible application viewport. */
  function handleOpenContextMenu(profile: ConnectionProfile, x: number, y: number): void {
    const menuWidth = 190;
    const menuHeight = 154;
    setTableContextMenu(null);
    setContextMenu({
      profileId: profile.id,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    });
  }

  /**
   * Opens the compact destructive-action menu for one exact table.
   * @param connectionId - Connection that owns the table.
   * @param tableName - Database-reported table name.
   * @param x - Viewport pointer or keyboard anchor position.
   * @param y - Viewport pointer or keyboard anchor position.
   * @returns Nothing (`void`).
   * Side effects: closes the connection menu and positions the table menu inside the viewport.
   */
  function handleOpenTableContextMenu(
    connectionId: string,
    tableName: string,
    x: number,
    y: number,
  ): void {
    const menuWidth = 220;
    const menuHeight = 390;
    setContextMenu(null);
    setTableContextMenu({
      connectionId,
      tableName,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    });
  }

  /**
   * Returns catalog table names under one connection that match the navigator query.
   * @param connectionId - Saved connection identifier.
   * @returns Matching table names from the already-loaded catalog.
   * Side effects: none.
   */
  function matchingCatalogTables(connectionId: string): readonly string[] {
    if (!normalizedNavigatorFilter) {
      return [];
    }
    return (tableCatalog[connectionId] ?? []).filter((tableName) => (
      tableName.toLocaleLowerCase().includes(normalizedNavigatorFilter)
    ));
  }

  /**
   * Returns whether one connection should remain visible under the current navigator filter.
   * @param profile - Candidate connection.
   * @returns `true` when identity or loaded table names match.
   * Side effects: none.
   */
  function profileVisibleInNavigator(profile: ConnectionProfile): boolean {
    if (!normalizedNavigatorFilter) {
      return true;
    }
    return connectionIdentityMatches(profile, normalizedNavigatorFilter)
      || matchingCatalogTables(profile.id).length > 0;
  }

  /** Focuses the sidebar-wide navigator search from the contextual find shortcut. */
  function handleSidebarKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!matchesShortcut(event, shortcuts.bindings.find)) {
      return;
    }
    event.preventDefault();
    navigatorSearchRef.current?.focus();
    navigatorSearchRef.current?.select();
  }

  return (
    <div className="connection-groups" onKeyDown={handleSidebarKeyDown}>
      <label className="connection-navigator-search">
        <Search size={12} aria-hidden="true" />
        <input
          aria-label="搜索连接或已加载的数据表"
          onChange={(event) => setNavigatorFilter(event.target.value)}
          placeholder="搜索连接或表"
          ref={navigatorSearchRef}
          title={`搜索连接或表（${getShortcutKeyLabels(shortcuts.bindings.find).join(" + ")}）`}
          type="search"
          value={navigatorFilter}
        />
      </label>
      <div className="connection-primary-actions">
        <button
          className="connection-find-global"
          onClick={() => onFindTables?.()}
          title="加载并模糊搜索所有 SQL 连接中的数据表"
          type="button"
        >
          <Search size={14} aria-hidden="true" />
          查找表
        </button>
        <button className="connection-add-global" onClick={onAddConnection} type="button">
          <Plus size={14} aria-hidden="true" />
          添加连接
        </button>
      </div>
      {ENGINE_GROUPS.map(({ engine, label }) => {
        const engineProfiles = profiles.filter((profile) => profile.engine === engine);
        const visibleProfiles = engineProfiles.filter(profileVisibleInNavigator);
        const sectionCollapsed = isEngineSectionCollapsed(
          engine,
          engineProfiles.length,
          visibleProfiles.length,
        );

        return (
          <section
            className={`engine-section engine-section--${engine}${sectionCollapsed ? " is-collapsed" : ""}`}
            aria-label={`${label} 连接`}
            key={engine}
          >
            <h2 className="engine-section__heading">
              <button
                aria-controls={`engine-section-body-${engine}`}
                aria-expanded={!sectionCollapsed}
                aria-label={`${sectionCollapsed ? "展开" : "收起"} ${label} 连接分组`}
                className="engine-section__toggle"
                onClick={() => handleToggleEngineSection(engine, sectionCollapsed)}
                type="button"
              >
                <span className="engine-section__identity">
                  <span className="engine-section__indicator" aria-hidden="true" />
                  <span className="engine-section__label">{label}</span>
                  <span className="engine-section__count" aria-label={`${engineProfiles.length} 个连接`}>
                    {engineProfiles.length}
                  </span>
                </span>
                <ChevronRight className="engine-section__chevron" size={14} aria-hidden="true" />
              </button>
            </h2>

            <div className="engine-section__body" id={`engine-section-body-${engine}`} hidden={sectionCollapsed}>
              {engineProfiles.length === 0 ? (
                <p className="engine-section__empty">暂无连接</p>
              ) : visibleProfiles.length === 0 ? (
                <p className="engine-section__empty">无匹配连接或表</p>
              ) : (
                <div className="connection-list" aria-label={`${label} 已保存连接`}>
                  {visibleProfiles.map((profile) => {
                    const catalogTableMatches = matchingCatalogTables(profile.id);
                    const forceExpandForTableMatch = catalogTableMatches.length > 0;
                    return (
                      <ConnectionDrawer
                        discoverTables={discoverTables && (
                          discoverTablesForConnectionId === null
                          || discoverTablesForConnectionId === profile.id
                        )}
                        dirtyTableNames={new Set(
                          dirtyTables
                            .filter((table) => table.connectionId === profile.id)
                            .map((table) => table.tableName),
                        )}
                        activeRowKey={effectiveActiveRowKey}
                        expanded={forceExpandForTableMatch || expandedConnectionIds.has(profile.id)}
                        key={profile.id}
                        onActiveRowKeyChange={setActiveRowKey}
                        openObjectNames={openObjectNamesByConnection.get(profile.id) ?? EMPTY_NAME_SET}
                        onOpenRedisKey={onOpenRedisKey}
                        onOpenTable={onOpenTable}
                        onFindTables={onFindTables}
                        onOpenContextMenu={handleOpenContextMenu}
                        onOpenTableContextMenu={handleOpenTableContextMenu}
                        onSelect={onSelectConnection}
                        onSelectRedisDatabase={onSelectRedisDatabase}
                        onTablesLoaded={onTablesLoaded}
                        onToggle={handleToggleConnection}
                        profile={profile}
                        pinnedTableKeys={pinnedTableKeys}
                        selected={selectedConnectionId === profile.id}
                        selectedRedisDatabase={selectedRedisDatabases[profile.id]}
                        tableFilter={normalizedNavigatorFilter}
                        tableCatalogRefreshVersion={tableCatalogRefreshVersions[profile.id] ?? 0}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        );
      })}
      {contextMenu && contextProfile ? (
        <div
          aria-label={`${contextProfile.name} 操作`}
          className="connection-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            disabled={!onRequestRename}
            onClick={() => {
              setContextMenu(null);
              onRequestRename?.(contextProfile);
            }}
            ref={contextMenuItemRef}
            role="menuitem"
            type="button"
          >
            <Pencil size={13} aria-hidden="true" />
            重命名…
          </button>
          <button
            disabled={!onCopyConfig}
            onClick={() => {
              setContextMenu(null);
              onCopyConfig?.(contextProfile);
            }}
            role="menuitem"
            type="button"
          >
            <Copy size={13} aria-hidden="true" />
            复制连接配置
          </button>
          <button
            disabled={!onReconnect || reconnectingConnectionId === contextProfile.id}
            onClick={() => {
              setContextMenu(null);
              onReconnect?.(contextProfile);
            }}
            role="menuitem"
            type="button"
          >
            <RefreshCw className={reconnectingConnectionId === contextProfile.id ? "spin" : undefined} size={13} aria-hidden="true" />
            {reconnectingConnectionId === contextProfile.id ? "正在重新连接…" : "重新连接"}
          </button>
          <span className="connection-context-menu__separator" role="separator" />
          <button
            className="connection-context-menu__danger"
            disabled={!onRequestDelete}
            onClick={() => {
              setContextMenu(null);
              onRequestDelete?.(contextProfile);
            }}
            role="menuitem"
            type="button"
          >
            <Trash2 size={13} aria-hidden="true" />
            删除连接…
          </button>
        </div>
      ) : null}
      {tableContextMenu ? (
        <TableActionMenu
          className="table-context-menu"
          firstItemRef={tableContextMenuItemRef}
          onAction={(action) => {
            const target = tableContextMenu;
            setTableContextMenu(null);
            onRequestTableAction?.(target.connectionId, target.tableName, action);
          }}
          pinned={pinnedTableKeys.has(tableTargetKey(
            tableContextMenu.connectionId,
            tableContextMenu.tableName,
          ))}
          style={{ left: tableContextMenu.x, top: tableContextMenu.y }}
          tableName={tableContextMenu.tableName}
        />
      ) : null}
    </div>
  );
}
