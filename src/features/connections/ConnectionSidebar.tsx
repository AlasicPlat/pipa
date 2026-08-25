import { Check, ChevronRight, Database, DatabasePlus, KeyRound, LoaderCircle, Plus, RefreshCw, Search, Settings2, Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { CellValue } from "../../bindings/CellValue";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { getShortcutKeyLabels, matchesShortcut, useShortcutSettings } from "../commands/shortcutRegistry";
import { executeQueryOnce } from "../query/executeQueryOnce";
import { useQuerySession } from "../query/useQuerySession";
import {
  TableActionMenu,
  tableTargetKey,
  type TableQuickAction,
} from "../tables/TableActionMenu";
import {
  buildShowTablesStatement,
  listMySqlDatabases,
  type MySqlDatabaseInfo,
} from "./mysqlDatabases";

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
  /** Loaded table names per connection, then per schema. */
  tableCatalog?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  tableCatalogRefreshVersions?: Readonly<Record<string, number>>;
  onFocusConnectionHandled?: () => void;
  onFindTables?: (connectionId?: string) => void;
  onAddConnection: () => void;
  /** Opens the connection manager, optionally landing on one connection's databases. */
  onOpenConnectionManager?: (connectionId?: string, view?: "profile" | "databases") => void;
  onOpenRedisKey?: (connectionId: string, database: string, keyName: string) => void;
  onOpenTable?: (connectionId: string, database: string, tableName: string) => void;
  onRequestCreateDatabase?: (profile: ConnectionProfile) => void;
  onSelectRedisDatabase?: (connectionId: string, database: string) => void;
  /** Records the schema the navigator is browsing for one MySQL connection. */
  onSelectDatabase?: (connectionId: string, database: string) => void;
  onRequestTableAction?: (
    connectionId: string,
    database: string,
    tableName: string,
    action: TableQuickAction,
  ) => void;
  onTablesLoaded?: (connectionId: string, database: string, tableNames: string[]) => void;
  selectedRedisDatabases?: Readonly<Record<string, string>>;
  /** Schema currently browsed per MySQL connection; falls back to each profile default. */
  selectedDatabases?: Readonly<Record<string, string>>;
}



interface ConnectionDrawerProps {
  discoverTables: boolean;
  dirtyTableNames: ReadonlySet<string>;
  profile: ConnectionProfile;
  pinnedTableKeys: ReadonlySet<string>;
  tableFilter: string;
  tableCatalogRefreshVersion: number;
  /** Object names already open as workspace tabs for this connection. */
  openObjectNames: ReadonlySet<string>;
  /** Row that currently owns the navigator's single Tab stop. */
  activeRowKey: TreeRowKey | null;
  onActiveRowKeyChange: (rowKey: TreeRowKey) => void;
  onOpenRedisKey?: (connectionId: string, database: string, keyName: string) => void;
  onOpenTable?: (connectionId: string, database: string, tableName: string) => void;
  onFindTables?: (connectionId?: string) => void;
  onRequestCreateDatabase?: (profile: ConnectionProfile) => void;
  onOpenTableContextMenu: (
    connectionId: string,
    database: string,
    tableName: string,
    x: number,
    y: number,
  ) => void;
  onSelectRedisDatabase?: (connectionId: string, database: string) => void;
  onSelectDatabase?: (connectionId: string, database: string) => void;
  onTablesLoaded?: (connectionId: string, database: string, tableNames: string[]) => void;
  /** Returns focus to the navigator's search box when the user steps out of the object list. */
  onLeaveObjectList: () => void;
  selectedRedisDatabase?: string;
  /** Schema this drawer is browsing, when it differs from the profile default. */
  selectedDatabase?: string;
}

interface RedisDatabaseInfo {
  database: string;
  keys: number;
  expires: number;
  averageTtlMs: number;
}

interface TableContextMenuState {
  connectionId: string;
  database: string;
  tableName: string;
  x: number;
  y: number;
}




/** Stable identity for one navigable sidebar row, used for roving tabindex. */
type TreeRowKey = string;

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

interface DatabaseSwitcherProps {
  activeDatabase: string;
  defaultDatabase: string | null;
  profile: ConnectionProfile;
  onSelectDatabase: (database: string) => void;
  onRequestCreateDatabase?: (profile: ConnectionProfile) => void;
}

/**
 * Renders the current schema as a switcher that swaps the table list in place.
 *
 * A switcher rather than a tree level: only one schema is browsed at a time, so listing every
 * schema as a permanently collapsed node would add depth without adding reachable content.
 * @param props - Current and default schema, owning profile, and selection callbacks.
 * @returns One collapsed control that expands into the connection's visible schema list.
 * Side effects: loads the schema list from the server the first time it is opened.
 */
function DatabaseSwitcher({
  activeDatabase,
  defaultDatabase,
  profile,
  onSelectDatabase,
  onRequestCreateDatabase,
}: DatabaseSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [databases, setDatabases] = useState<MySqlDatabaseInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const userDatabases = databases.filter((database) => !database.system);
  const systemDatabases = databases.filter((database) => database.system);

  /** Loads the connection's visible schema list on demand. */
  const loadDatabases = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setDatabases(await listMySqlDatabases(profile.id));
    } catch (loadError: unknown) {
      setError(
        typeof loadError === "object"
        && loadError !== null
        && "message" in loadError
        && typeof loadError.message === "string"
          ? loadError.message
          : "无法读取数据库列表。",
      );
    } finally {
      setLoading(false);
    }
  }, [profile.id]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (databases.length === 0 && !loading) {
      void loadDatabases();
    }
    firstItemRef.current?.focus();
  }, [databases.length, loadDatabases, loading, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    /** Closes the list after a pointer action outside it. */
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".database-switcher")) {
        setOpen(false);
      }
    }
    /** Closes the list with Escape and restores focus to its trigger. */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  /** Applies one schema choice and collapses the list. */
  function handleSelect(database: string): void {
    setOpen(false);
    triggerRef.current?.focus();
    if (database !== activeDatabase) {
      onSelectDatabase(database);
    }
  }

  return (
    <div className="database-switcher">
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`数据库：${activeDatabase || "未选择"}（${profile.name}）；点击切换`}
        className="database-switcher__trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title="切换此连接浏览的数据库"
        type="button"
      >
        <Database size={13} strokeWidth={1.7} aria-hidden="true" />
        <span>{activeDatabase || "选择数据库"}</span>
        {activeDatabase && activeDatabase === defaultDatabase ? <small>默认</small> : null}
        <ChevronRight className="database-switcher__chevron" size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="database-switcher__panel" role="listbox" aria-label={`${profile.name} 数据库`}>
          {loading && databases.length === 0 ? (
            <p className="database-switcher__status">正在读取数据库…</p>
          ) : error ? (
            <p className="database-switcher__status database-switcher__status--error" role="alert">
              {error}
            </p>
          ) : (
            <>
              {userDatabases.length === 0 ? (
                <p className="database-switcher__status">此连接没有可浏览的数据库。</p>
              ) : userDatabases.map((database, index) => (
                <button
                  aria-selected={database.name === activeDatabase}
                  className="database-switcher__item"
                  key={database.name}
                  onClick={() => handleSelect(database.name)}
                  ref={index === 0 ? firstItemRef : undefined}
                  role="option"
                  title={`${database.charset} · ${database.collation}`}
                  type="button"
                >
                  {database.name === activeDatabase
                    ? <Check size={12} aria-hidden="true" />
                    : <span className="database-switcher__item-spacer" aria-hidden="true" />}
                  <span>{database.name}</span>
                  {database.name === defaultDatabase ? <small>默认</small> : null}
                </button>
              ))}
              {systemDatabases.length > 0 ? (
                <>
                  <span className="database-switcher__separator" role="separator" />
                  <button
                    aria-expanded={showSystem}
                    className="database-switcher__system-toggle"
                    onClick={() => setShowSystem((current) => !current)}
                    type="button"
                  >
                    <ChevronRight
                      className={showSystem ? "is-expanded" : undefined}
                      size={12}
                      aria-hidden="true"
                    />
                    系统库 <small>{systemDatabases.length}</small>
                  </button>
                  {showSystem ? systemDatabases.map((database) => (
                    <button
                      aria-selected={database.name === activeDatabase}
                      className="database-switcher__item"
                      key={database.name}
                      onClick={() => handleSelect(database.name)}
                      role="option"
                      type="button"
                    >
                      {database.name === activeDatabase
                        ? <Check size={12} aria-hidden="true" />
                        : <span className="database-switcher__item-spacer" aria-hidden="true" />}
                      <span>{database.name}</span>
                    </button>
                  )) : null}
                </>
              ) : null}
              {onRequestCreateDatabase ? (
                <>
                  <span className="database-switcher__separator" role="separator" />
                  <button
                    className="database-switcher__create"
                    onClick={() => {
                      setOpen(false);
                      onRequestCreateDatabase(profile);
                    }}
                    type="button"
                  >
                    <DatabasePlus size={12} aria-hidden="true" />
                    新建数据库…
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
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
  profile,
  pinnedTableKeys,
  tableFilter,
  tableCatalogRefreshVersion,
  openObjectNames,
  activeRowKey,
  onActiveRowKeyChange,
  onOpenRedisKey,
  onOpenTable,
  onFindTables,
  onRequestCreateDatabase,
  onOpenTableContextMenu,
  onSelectRedisDatabase,
  onSelectDatabase,
  onTablesLoaded,
  onLeaveObjectList,
  selectedRedisDatabase,
  selectedDatabase,
}: ConnectionDrawerProps) {
  const tables = useQuerySession(profile.id, { recordHistory: false });
  const supportsExplorer = profile.engine === "my_sql" || profile.engine === "redis";
  const isRedis = profile.engine === "redis";
  // The switcher's choice wins over the profile default, so a connection saved without one can
  // still browse as soon as a database is picked.
  const activeDatabase = isRedis
    ? null
    : selectedDatabase ?? profile.database ?? null;
  const canExplore = isRedis || Boolean(activeDatabase);

  const [redisDatabases, setRedisDatabases] = useState<RedisDatabaseInfo[]>([]);
  const [expandedRedisDatabase, setExpandedRedisDatabase] = useState<string | null>(null);
  const [redisKeys, setRedisKeys] = useState<string[]>([]);
  const [redisDatabasesLoading, setRedisDatabasesLoading] = useState(false);
  const [redisKeysLoading, setRedisKeysLoading] = useState(false);
  const [redisExplorerError, setRedisExplorerError] = useState<string | null>(null);
  const redisDatabaseRequestIdRef = useRef(0);
  const redisKeyRequestIdRef = useRef(0);
  const tableCatalogRefreshVersionRef = useRef(0);
  const loadedDatabaseRef = useRef<string | null>(null);
  const normalizedTableFilter = tableFilter.trim().toLocaleLowerCase();
  const objectRows = tables.state.rows.filter((row) => Boolean(objectName(row)));
  const visibleTableRows = objectRows
    .filter((row) => objectName(row).toLocaleLowerCase().includes(normalizedTableFilter))
    .sort((left, right) => (
      Number(pinnedTableKeys.has(tableTargetKey(profile.id, activeDatabase ?? "", objectName(right))))
      - Number(pinnedTableKeys.has(tableTargetKey(profile.id, activeDatabase ?? "", objectName(left))))
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
    if (!activeDatabase) {
      return;
    }
    onTablesLoaded?.(
      profile.id,
      activeDatabase,
      tables.state.rows.map((row) => cellText(row[0])).filter(Boolean),
    );
  }, [activeDatabase, onTablesLoaded, profile.engine, profile.id, tables.state.error, tables.state.queryId, tables.state.rows, tables.state.running]);

  useEffect(() => {
    if (
      discoverTables
      && profile.engine === "my_sql"
      && canExplore
      && tables.state.queryId === null
      && !tables.state.running
      && activeDatabase
    ) {
      void tables.run(buildShowTablesStatement(activeDatabase));
    }
  }, [activeDatabase, canExplore, discoverTables, profile, tables.run, tables.state.queryId, tables.state.running]);

  useEffect(() => {
    if (
      tableCatalogRefreshVersion === 0
      || tableCatalogRefreshVersionRef.current === tableCatalogRefreshVersion
      || profile.engine !== "my_sql"
      || !canExplore
      || tables.state.running
      || !activeDatabase
    ) {
      return;
    }
    tableCatalogRefreshVersionRef.current = tableCatalogRefreshVersion;
    void tables.run(buildShowTablesStatement(activeDatabase));
  }, [activeDatabase, canExplore, profile.engine, tableCatalogRefreshVersion, tables.run, tables.state.running]);

  // Switching databases replaces the visible tables in place, without collapsing the navigator.
  useEffect(() => {
    if (profile.engine !== "my_sql" || !activeDatabase || tables.state.running) {
      return;
    }
    if (loadedDatabaseRef.current === activeDatabase) {
      return;
    }
    loadedDatabaseRef.current = activeDatabase;
    void tables.run(buildShowTablesStatement(activeDatabase));
  }, [activeDatabase, profile.engine, tables.run, tables.state.running]);

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
    onSelectRedisDatabase?.(profile.id, database);
    if (expandedRedisDatabase === database && !forceRefresh) {
      setExpandedRedisDatabase(null);
      return;
    }
    await scanRedisKeys(database);
  }

  /**
   * Lists one Redis database's keys with a bounded SCAN and shows them under that database.
   * @param database - Redis logical database number to scan.
   * @returns A promise settled after the latest SCAN request updates the tree.
   * Side effects: replaces the expanded database and its key list.
   */
  async function scanRedisKeys(database: string): Promise<void> {
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

  // Redis summaries load as soon as the focused connection is a Redis one, because the navigator
  // no longer has an expand step to trigger them.
  useEffect(() => {
    if (!isRedis || redisDatabases.length > 0 || redisDatabasesLoading) {
      return;
    }
    void loadRedisDatabases();
    // Mounting per focused connection means this runs once for that connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRedis]);

  // A workspace can switch the logical database on its own, so the key list follows that choice
  // instead of showing keys from whichever database was last clicked here.
  useEffect(() => {
    if (!isRedis || !selectedRedisDatabase || selectedRedisDatabase === expandedRedisDatabase) {
      return;
    }
    void scanRedisKeys(selectedRedisDatabase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRedis, selectedRedisDatabase]);

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
    } else if (!tables.state.running && activeDatabase) {
      void tables.run(buildShowTablesStatement(activeDatabase));
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
      onActiveRowKeyChange(objectRowKey(profile.id, tableName));
      if (activeDatabase) {
        onOpenTableContextMenu(
          profile.id,
          activeDatabase,
          tableName,
          bounds.left + 24,
          bounds.bottom - 4,
        );
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (activeDatabase) {
        onOpenTable?.(profile.id, activeDatabase, tableName);
      }
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "Escape") {
      // The navigator's root is now the search box, so leaving the list returns focus there.
      event.preventDefault();
      event.stopPropagation();
      onLeaveObjectList();
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
    onActiveRowKeyChange(objectRowKey(profile.id, tableName));
    if (activeDatabase) {
      onOpenTableContextMenu(profile.id, activeDatabase, tableName, event.clientX, event.clientY);
    }
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
      onLeaveObjectList();
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

  if (!supportsExplorer) {
    return (
      <p className="connection-drawer__status">
        {`${profile.name} 使用的引擎暂不支持对象浏览。`}
      </p>
    );
  }

  return (
    <div className="connection-drawer is-expanded">
      {isRedis ? (
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
      ) : (
        <div
          className="connection-drawer__body"
          aria-label={`${profile.name} 数据表`}
          id={`connection-objects-${profile.id}`}
        >
          <DatabaseSwitcher
            activeDatabase={activeDatabase ?? ""}
            defaultDatabase={profile.database}
            onRequestCreateDatabase={onRequestCreateDatabase}
            onSelectDatabase={(database) => onSelectDatabase?.(profile.id, database)}
            profile={profile}
          />
          <header className="connection-drawer__header">
            <span>数据表 <small>{objectRows.length}</small></span>
            <span className="connection-drawer__actions">
              {/* Creating a schema belongs to the database switcher above, not this table header. */}
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
          {!activeDatabase ? (
            <p className="connection-drawer__status">请先选择一个数据库。</p>
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
                const isPinned = pinnedTableKeys.has(
                  tableTargetKey(profile.id, activeDatabase ?? "", tableName),
                );
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
                      if (activeDatabase) {
                        onOpenTable?.(profile.id, activeDatabase, tableName);
                      }
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
      )}
    </div>
  );
}

/**
 * Renders the object explorer for the one connection currently in focus.
 *
 * Only the focused connection appears: switching connections is the picker's job, so the navigator
 * stays a single list of the objects the user is actually working with.
 * @param props - The focused profile, its browsed schema, and object actions.
 * @returns The focused connection's object navigator.
 * Side effects: owns only local search, focus-row, and menu state.
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
  onAddConnection,
  onOpenConnectionManager,
  onOpenRedisKey,
  onOpenTable,
  onRequestCreateDatabase,
  onRequestTableAction,
  onSelectRedisDatabase,
  onSelectDatabase,
  onTablesLoaded,
  selectedRedisDatabases = {},
  selectedDatabases = {},
}: ConnectionSidebarProps) {
  const shortcuts = useShortcutSettings();
  const [navigatorFilter, setNavigatorFilter] = useState("");
  const [activeRowKey, setActiveRowKey] = useState<TreeRowKey | null>(null);
  const [tableContextMenu, setTableContextMenu] = useState<TableContextMenuState | null>(null);
  const tableContextMenuItemRef = useRef<HTMLButtonElement>(null);
  const navigatorSearchRef = useRef<HTMLInputElement>(null);
  const normalizedNavigatorFilter = navigatorFilter.trim().toLocaleLowerCase();
  const activeProfile = profiles.find((profile) => profile.id === selectedConnectionId) ?? null;
  const openObjectNames = useMemo(() => new Set(
    openObjects
      .filter((object) => object.connectionId === selectedConnectionId)
      .map((object) => object.objectName),
  ), [openObjects, selectedConnectionId]);
  const dirtyTableNames = useMemo(() => new Set(
    dirtyTables
      .filter((table) => table.connectionId === selectedConnectionId)
      .map((table) => table.tableName),
  ), [dirtyTables, selectedConnectionId]);
  // Tables already loaded from schemas other than the focused one. The navigator only lists the
  // focused schema, so these are surfaced separately rather than silently dropped from search.
  const otherSchemaMatches = useMemo(() => {
    if (!normalizedNavigatorFilter || !selectedConnectionId) {
      return [];
    }
    const browsedDatabase = selectedDatabases[selectedConnectionId]
      ?? activeProfile?.database
      ?? null;
    return Object.entries(tableCatalog[selectedConnectionId] ?? {})
      .filter(([database]) => database !== browsedDatabase)
      .flatMap(([database, tableNames]) => tableNames
        .filter((tableName) => tableName.toLocaleLowerCase().includes(normalizedNavigatorFilter))
        .map((tableName) => ({ database, tableName })))
      .slice(0, 50);
  }, [
    activeProfile,
    normalizedNavigatorFilter,
    selectedConnectionId,
    selectedDatabases,
    tableCatalog,
  ]);

  useEffect(() => {
    if (!focusConnectionId) {
      return;
    }
    // Focus now means "reveal the already-current connection's objects", because switching is
    // handled by the picker. One frame lets the panel leave `inert` before focusing.
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        navigatorSearchRef.current?.focus();
        onFocusConnectionHandled?.();
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusConnectionId, onFocusConnectionHandled]);

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
    database: string,
    tableName: string,
    x: number,
    y: number,
  ): void {
    const menuWidth = 220;
    const menuHeight = 390;
    setTableContextMenu({
      connectionId,
      database,
      tableName,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    });
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
      {/* Adding a connection lives in the picker; the navigator stays about objects. */}
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
        {/* A permanent entry point, so managing connections is never more than one click away. */}
        <button
          className="connection-manage-global"
          onClick={() => onOpenConnectionManager?.()}
          title="管理连接配置与数据库"
          type="button"
        >
          <Settings2 size={14} aria-hidden="true" />
          管理连接
        </button>
      </div>
      {activeProfile ? (
        <ConnectionDrawer
          activeRowKey={activeRowKey}
          dirtyTableNames={dirtyTableNames}
          discoverTables={discoverTables && (
            discoverTablesForConnectionId === null
            || discoverTablesForConnectionId === activeProfile.id
          )}
          key={activeProfile.id}
          onActiveRowKeyChange={setActiveRowKey}
          onFindTables={onFindTables}
          onOpenRedisKey={onOpenRedisKey}
          onOpenTable={onOpenTable}
          onOpenTableContextMenu={handleOpenTableContextMenu}
          onRequestCreateDatabase={onRequestCreateDatabase}
          onLeaveObjectList={() => navigatorSearchRef.current?.focus()}
          onSelectDatabase={onSelectDatabase}
          onSelectRedisDatabase={onSelectRedisDatabase}
          onTablesLoaded={onTablesLoaded}
          openObjectNames={openObjectNames}
          pinnedTableKeys={pinnedTableKeys}
          profile={activeProfile}
          selectedDatabase={selectedDatabases[activeProfile.id]}
          selectedRedisDatabase={selectedRedisDatabases[activeProfile.id]}
          tableCatalogRefreshVersion={tableCatalogRefreshVersions[activeProfile.id] ?? 0}
          tableFilter={normalizedNavigatorFilter}
        />
      ) : (
        <div className="connection-navigator__empty">
          <p>{profiles.length === 0 ? "还没有保存任何连接。" : "请先在顶部选择一个连接。"}</p>
          {profiles.length === 0 ? (
            <button className="connection-add-global" onClick={onAddConnection} type="button">
              <Plus size={14} aria-hidden="true" />
              添加连接
            </button>
          ) : null}
        </div>
      )}
      {otherSchemaMatches.length > 0 && activeProfile ? (
        <section className="navigator-other-matches" aria-label="其他数据库中的匹配表">
          <h2>其他数据库 <small>{otherSchemaMatches.length}</small></h2>
          {otherSchemaMatches.map(({ database, tableName }) => (
            <button
              key={`${database}\u0000${tableName}`}
              onClick={() => onOpenTable?.(activeProfile.id, database, tableName)}
              title={`打开 ${database}.${tableName}`}
              type="button"
            >
              <Table2 size={12} aria-hidden="true" />
              <span>{tableName}</span>
              <small>{database}</small>
            </button>
          ))}
        </section>
      ) : null}
      {tableContextMenu ? (
        <TableActionMenu
          className="table-context-menu"
          firstItemRef={tableContextMenuItemRef}
          onAction={(action) => {
            const target = tableContextMenu;
            setTableContextMenu(null);
            onRequestTableAction?.(
              target.connectionId,
              target.database,
              target.tableName,
              action,
            );
          }}
          pinned={pinnedTableKeys.has(tableTargetKey(
            tableContextMenu.connectionId,
            tableContextMenu.database,
            tableContextMenu.tableName,
          ))}
          style={{ left: tableContextMenu.x, top: tableContextMenu.y }}
          tableName={tableContextMenu.tableName}
        />
      ) : null}
    </div>
  );
}
