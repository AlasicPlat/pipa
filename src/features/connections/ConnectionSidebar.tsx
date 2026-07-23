import { Check, ChevronRight, Copy, LoaderCircle, Pencil, Plus, RefreshCw, Search, Table2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { CellValue } from "../../bindings/CellValue";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { Engine } from "../../bindings/Engine";
import type { Environment } from "../../bindings/Environment";
import { getShortcutKeyLabels, matchesShortcut, useShortcutSettings } from "../commands/shortcutRegistry";
import {
  loadEngineSectionCollapseOverrides,
  persistEngineSectionCollapseOverrides,
} from "../preferences/sidebarLayout";
import { useQuerySession } from "../query/useQuerySession";

interface ConnectionSidebarProps {
  discoverTables?: boolean;
  dirtyTables?: readonly { connectionId: string; tableName: string }[];
  focusConnectionId?: string | null;
  profiles: ConnectionProfile[];
  selectedConnectionId: string | null;
  tableCatalog?: Readonly<Record<string, readonly string[]>>;
  onFocusConnectionHandled?: () => void;
  onSelectConnection: (id: string) => void;
  onAddConnection: () => void;
  onCopyConfig?: (profile: ConnectionProfile) => void;
  onOpenTable?: (connectionId: string, tableName: string) => void;
  onReconnect?: (profile: ConnectionProfile) => void;
  onRequestRename?: (profile: ConnectionProfile) => void;
  onRequestDelete?: (profile: ConnectionProfile) => void;
  onTablesLoaded?: (connectionId: string, tableNames: string[]) => void;
  reconnectingConnectionId?: string | null;
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
  selected: boolean;
  tableFilter: string;
  onOpenTable?: (connectionId: string, tableName: string) => void;
  onOpenContextMenu: (profile: ConnectionProfile, x: number, y: number) => void;
  onSelect: (connectionId: string) => void;
  onTablesLoaded?: (connectionId: string, tableNames: string[]) => void;
  onToggle: (connectionId: string) => void;
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

const ENGINE_GROUPS: readonly EngineGroup[] = [
  { engine: "my_sql", label: "MySQL" },
  { engine: "postgre_sql", label: "PostgreSQL" },
  { engine: "mongo_db", label: "MongoDB" },
  { engine: "redis", label: "Redis" },
];

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
    return JSON.stringify(cell.value);
  }
  if (cell.kind === "binary") {
    return "Binary";
  }
  return String(cell.value);
}

/**
 * Renders one independently expandable connection and its lazily loaded table list.
 * @param props - Connection identity, drawer state, and navigation callbacks.
 * @returns One selectable connection drawer.
 * Side effects: issues an internal metadata query only after explicit expansion or refresh.
 */
function ConnectionDrawer({
  discoverTables,
  dirtyTableNames,
  expanded,
  profile,
  selected,
  tableFilter,
  onOpenTable,
  onOpenContextMenu,
  onSelect,
  onTablesLoaded,
  onToggle,
}: ConnectionDrawerProps) {
  const tables = useQuerySession(profile.id, { recordHistory: false });
  const connectionButtonRef = useRef<HTMLButtonElement>(null);
  const canExplore = profile.engine === "my_sql" && Boolean(profile.database);
  const [selectedTableName, setSelectedTableName] = useState<string | null>(null);
  const normalizedTableFilter = tableFilter.trim().toLocaleLowerCase();
  const visibleTableRows = tables.state.rows.filter((row) =>
    cellText(row[0]).toLocaleLowerCase().includes(normalizedTableFilter),
  );

  useEffect(() => {
    if (!tables.state.queryId || tables.state.running || tables.state.error) {
      return;
    }
    onTablesLoaded?.(
      profile.id,
      tables.state.rows.map((row) => cellText(row[0])).filter(Boolean),
    );
  }, [onTablesLoaded, profile.id, tables.state.error, tables.state.queryId, tables.state.rows, tables.state.running]);

  useEffect(() => {
    if (discoverTables && canExplore && tables.state.queryId === null && !tables.state.running) {
      void tables.run("SHOW FULL TABLES;");
    }
  }, [canExplore, discoverTables, tables.run, tables.state.queryId, tables.state.running]);

  /**
   * Selects and toggles the drawer, loading table metadata only when it first opens.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: updates parent state and may start a MySQL metadata query.
   */
  function handleToggleRequested(): void {
    onSelect(profile.id);
    if (profile.engine !== "my_sql") {
      return;
    }
    onToggle(profile.id);
    if (!expanded && canExplore && tables.state.queryId === null) {
      void tables.run("SHOW FULL TABLES;");
    }
  }

  /** Moves focus and selection to the adjacent saved connection without wrapping. */
  function focusAdjacentConnection(currentTarget: HTMLButtonElement, offset: -1 | 1): void {
    const connectionButtons = Array.from(
      currentTarget
        .closest(".connection-groups")
        ?.querySelectorAll<HTMLButtonElement>(".connection-row[data-connection-id]") ?? [],
    );
    const currentIndex = connectionButtons.indexOf(currentTarget);
    const nextButton = connectionButtons[currentIndex + offset];
    if (!nextButton) {
      return;
    }
    nextButton.focus();
    const nextConnectionId = nextButton.dataset.connectionId;
    if (nextConnectionId) {
      onSelect(nextConnectionId);
    }
  }

  /**
   * Reloads table metadata while retaining the open connection drawer.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: starts a MySQL metadata query.
   */
  function handleRefresh(): void {
    if (canExplore && !tables.state.running) {
      void tables.run("SHOW FULL TABLES;");
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
      focusAdjacentConnection(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "ArrowRight" && !expanded) {
      event.preventDefault();
      handleToggleRequested();
      return;
    }

    if (event.key === "ArrowLeft" && expanded) {
      event.preventDefault();
      onToggle(profile.id);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      handleToggleRequested();
      return;
    }

    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      onToggle(profile.id);
    }
  }

  /** Moves within the visible table results while keeping keyboard focus and selection aligned. */
  function handleTableKeyDown(event: KeyboardEvent<HTMLButtonElement>, tableName: string): void {
    if (event.key === "Enter") {
      event.preventDefault();
      onOpenTable?.(profile.id, tableName);
      return;
    }

    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      onSelect(profile.id);
      if (expanded) {
        onToggle(profile.id);
      }
      connectionButtonRef.current?.focus();
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const tableButtons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(".table-tree__item") ?? [],
    );
    const currentIndex = tableButtons.indexOf(event.currentTarget);
    const nextButton = tableButtons[currentIndex + (event.key === "ArrowDown" ? 1 : -1)];
    if (!nextButton) {
      return;
    }
    nextButton.focus();
    setSelectedTableName(nextButton.dataset.tableName ?? null);
  }

  return (
    <div className={`connection-drawer${expanded ? " is-expanded" : ""}`}>
      <button
        aria-controls={profile.engine === "my_sql" ? `connection-tables-${profile.id}` : undefined}
        aria-expanded={profile.engine === "my_sql" ? expanded : undefined}
        aria-pressed={selected}
        aria-selected={selected}
        className={`connection-row${selected ? " is-selected" : ""}`}
        data-connection-id={profile.id}
        onClick={() => onSelect(profile.id)}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleToggleRequested}
        onKeyDown={handleConnectionKeyDown}
        ref={connectionButtonRef}
        style={{ minHeight: "40px" }}
        title={profile.engine === "my_sql" ? "双击或按 Enter 展开数据表" : undefined}
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
          <span className="connection-row__meta">
            {profile.host}:{profile.port}
            <span aria-hidden="true"> · </span>
            {profile.database ?? "未指定数据库"}
          </span>
        </span>
        {profile.engine === "my_sql" ? (
          <ChevronRight className="connection-row__chevron" size={14} aria-hidden="true" />
        ) : (
          <Check className="connection-row__check" size={15} aria-hidden="true" />
        )}
      </button>

      {expanded && profile.engine === "my_sql" ? (
        <div
          className="connection-drawer__body"
          aria-label={`${profile.name} 数据表`}
          id={`connection-tables-${profile.id}`}
        >
          <header className="connection-drawer__header">
            <span>数据表 <small>{tables.state.rows.length}</small></span>
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
          </header>
          {!profile.database ? (
            <p className="connection-drawer__status">请先在连接中指定数据库。</p>
          ) : tables.state.error ? (
            <p className="connection-drawer__status connection-drawer__status--error">
              无法读取数据表：{tables.state.error.message}
            </p>
          ) : tables.state.running && tables.state.rows.length === 0 ? (
            <p className="connection-drawer__status">正在读取数据表…</p>
          ) : tables.state.rows.length === 0 && tables.state.affectedRows !== null ? (
            <p className="connection-drawer__status">此数据库暂无数据表。</p>
          ) : visibleTableRows.length === 0 ? (
            <p className="connection-drawer__status">没有匹配的数据表。</p>
          ) : (
            <div className="table-tree" role="tree">
              {visibleTableRows.map((row, rowIndex) => {
                const tableName = cellText(row[0]);
                const objectType = cellText(row[1]);
                const isDirty = dirtyTableNames.has(tableName);
                return (
                  <button
                    aria-selected={selectedTableName === tableName}
                    className={`table-tree__item${selectedTableName === tableName ? " is-selected" : ""}`}
                    data-table-name={tableName}
                    key={`${tableName}-${rowIndex}`}
                    onClick={() => setSelectedTableName(tableName)}
                    onDoubleClick={() => onOpenTable?.(profile.id, tableName)}
                    onKeyDown={(event) => handleTableKeyDown(event, tableName)}
                    role="treeitem"
                    title="双击或按 Enter 打开表工作区"
                    type="button"
                  >
                    <Table2 size={13} strokeWidth={1.7} aria-hidden="true" />
                    <span>{tableName}</span>
                    {isDirty ? (
                      <span
                        aria-label={`${tableName} 有未提交修改`}
                        className="object-dirty-indicator"
                        title="有未提交修改"
                      />
                    ) : null}
                    {objectType === "VIEW" ? <small>视图</small> : null}
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
  dirtyTables = [],
  focusConnectionId = null,
  profiles,
  selectedConnectionId,
  tableCatalog = {},
  onFocusConnectionHandled,
  onSelectConnection,
  onAddConnection,
  onCopyConfig,
  onOpenTable,
  onReconnect,
  onRequestRename,
  onRequestDelete,
  onTablesLoaded,
  reconnectingConnectionId = null,
}: ConnectionSidebarProps) {
  const shortcuts = useShortcutSettings();
  const [expandedConnectionIds, setExpandedConnectionIds] = useState<Set<string>>(new Set());
  const [engineCollapseOverrides, setEngineCollapseOverrides] = useState<Map<Engine, boolean>>(
    loadEngineSectionCollapseOverrides,
  );
  const [navigatorFilter, setNavigatorFilter] = useState("");
  const [contextMenu, setContextMenu] = useState<ConnectionContextMenuState | null>(null);
  const contextMenuItemRef = useRef<HTMLButtonElement>(null);
  const navigatorSearchRef = useRef<HTMLInputElement>(null);
  const contextProfile = profiles.find((profile) => profile.id === contextMenu?.profileId) ?? null;
  const focusProfile = focusConnectionId
    ? profiles.find((profile) => profile.id === focusConnectionId) ?? null
    : null;
  const normalizedNavigatorFilter = navigatorFilter.trim().toLocaleLowerCase();

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

  /**
   * Toggles exactly one drawer while preserving every other expanded connection.
   * @param connectionId - Drawer connection identifier.
   * @returns Nothing (`void`).
   * Side effects: updates local expansion state.
   */
  function handleToggleConnection(connectionId: string): void {
    setExpandedConnectionIds((current) => {
      const next = new Set(current);
      if (next.has(connectionId)) {
        next.delete(connectionId);
      } else {
        next.add(connectionId);
      }
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
    setContextMenu({
      profileId: profile.id,
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
      <button className="connection-add-global" onClick={onAddConnection} type="button">
        <Plus size={14} aria-hidden="true" />
        添加连接
      </button>
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
                        discoverTables={discoverTables}
                        dirtyTableNames={new Set(
                          dirtyTables
                            .filter((table) => table.connectionId === profile.id)
                            .map((table) => table.tableName),
                        )}
                        expanded={forceExpandForTableMatch || expandedConnectionIds.has(profile.id)}
                        key={profile.id}
                        onOpenTable={onOpenTable}
                        onOpenContextMenu={handleOpenContextMenu}
                        onSelect={onSelectConnection}
                        onTablesLoaded={onTablesLoaded}
                        onToggle={handleToggleConnection}
                        profile={profile}
                        selected={selectedConnectionId === profile.id}
                        tableFilter={normalizedNavigatorFilter}
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
    </div>
  );
}
