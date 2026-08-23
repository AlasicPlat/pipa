import { FileClock, FileCode2, Plus, Table2, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { getShortcutKeyLabels, useShortcutSettings } from "../commands/shortcutRegistry";
import type { WorkspaceTab } from "../query/useWorkspacePersistence";
import { isScreenPointOutsideWindow, type ScreenPoint } from "./detachedWorkspace";

export interface OpenTableTab {
  id: string;
  connectionId: string;
  tableName: string;
  title: string;
}

export interface UtilityWorkspaceTab {
  id: string;
  kind: "binlog";
  title: string;
}

export interface WorkspaceDetachRequest {
  kind: "query" | "table";
  point: ScreenPoint;
  tabId: string;
}

/** Which tab collection a drag or context menu currently refers to. */
type WorkspaceTabKind = "query" | "table" | "utility";

interface DragState {
  kind: WorkspaceTabKind;
  tabId: string;
}

interface DropTarget {
  kind: WorkspaceTabKind;
  index: number;
}

interface TabMenuState {
  kind: WorkspaceTabKind;
  tabId: string;
  x: number;
  y: number;
}

interface WorkspaceTabsProps {
  activeQueryTabId: string | null;
  activeTableTabId: string | null;
  activeUtilityTabId: string | null;
  busyQueryTabId: string | null;
  dirtyTableTabIds: ReadonlySet<string>;
  newQueryConnectionName: string | null;
  newQueryEngine?: "my_sql" | "redis" | null;
  queryTabs: WorkspaceTab[];
  tableTabs: OpenTableTab[];
  utilityTabs: readonly UtilityWorkspaceTab[];
  onCloseQuery: (tabId: string) => void;
  onCloseTable: (tabId: string) => void;
  onCloseUtility: (tabId: string) => void;
  onCreateQuery: () => void;
  onDetach?: (request: WorkspaceDetachRequest) => void;
  onReorderQuery?: (tabId: string, targetIndex: number) => void;
  onReorderTable?: (tabId: string, targetIndex: number) => void;
  onSelectQuery: (tabId: string) => void;
  onSelectTable: (tabId: string) => void;
  onSelectUtility: (tabId: string) => void;
}

/** Estimated menu box used to keep the context menu inside the viewport. */
const TAB_MENU_WIDTH = 208;
const TAB_MENU_HEIGHT = 176;

/**
 * Renders one shared tab strip for query, table, and connection-independent utility workspaces.
 *
 * Tabs reorder within their own group by drag, detach when dropped outside the
 * window, and expose bulk close actions through a right-click menu.
 * @param props - Open tabs, active identities, busy guard, and workspace actions.
 * @returns The global workspace tab strip.
 * Side effects: invokes parent actions after explicit user interaction.
 */
export function WorkspaceTabs({
  activeQueryTabId,
  activeTableTabId,
  activeUtilityTabId,
  busyQueryTabId,
  dirtyTableTabIds,
  newQueryConnectionName,
  newQueryEngine = "my_sql",
  queryTabs,
  tableTabs,
  utilityTabs,
  onCloseQuery,
  onCloseTable,
  onCloseUtility,
  onCreateQuery,
  onDetach,
  onReorderQuery,
  onReorderTable,
  onSelectQuery,
  onSelectTable,
  onSelectUtility,
}: WorkspaceTabsProps) {
  const shortcuts = useShortcutSettings();
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement>(null);
  const closeShortcut = getShortcutKeyLabels(shortcuts.bindings.closeWorkspace).join(" + ");
  const newQueryShortcut = getShortcutKeyLabels(shortcuts.bindings.newQuery).join(" + ");
  const newQueryKind = newQueryEngine === "redis" ? "Redis 工作区" : "SQL 查询";

  useEffect(() => {
    if (!tabMenu) {
      return;
    }
    firstMenuItemRef.current?.focus();
    /** Dismisses the menu on any interaction outside it. */
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".workspace-tab-menu")) {
        setTabMenu(null);
      }
    }
    /** Dismisses the menu with the platform-standard Escape key. */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setTabMenu(null);
      }
    }
    /** Drops the menu rather than leaving it detached from its tab. */
    function handleViewportChange(): void {
      setTabMenu(null);
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [tabMenu]);

  /** Starts one native move drag without triggering an expensive workspace rerender. */
  function handleWorkspaceDragStart(
    event: DragEvent<HTMLButtonElement>,
    kind: WorkspaceTabKind,
    tabId: string,
  ): void {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tabId);
    event.currentTarget.parentElement?.classList.add("is-dragging");
    setDragState({ kind, tabId });
  }

  /**
   * Marks the hovered slot as the pending drop position within the same group.
   * @param event - Native drag-over event from a tab.
   * @param kind - Collection that owns the hovered tab.
   * @param index - Index of the hovered tab in its own collection.
   * @returns Nothing (`void`).
   * Side effects: updates the drop indicator; ignores drags from another group.
   */
  function handleWorkspaceDragOver(
    event: DragEvent<HTMLSpanElement>,
    kind: WorkspaceTabKind,
    index: number,
  ): void {
    if (!dragState || dragState.kind !== kind) {
      return;
    }
    // Reordering is only defined within a single collection.
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget((current) => (
      current?.kind === kind && current.index === index ? current : { kind, index }
    ));
  }

  /**
   * Commits an in-window reorder for the dragged tab.
   * @param event - Native drop event from a tab slot.
   * @param kind - Collection that owns the drop slot.
   * @param index - Destination index within that collection.
   * @returns Nothing (`void`).
   * Side effects: invokes the matching reorder callback and clears drag state.
   */
  function handleWorkspaceDrop(
    event: DragEvent<HTMLSpanElement>,
    kind: WorkspaceTabKind,
    index: number,
  ): void {
    if (!dragState || dragState.kind !== kind) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (kind === "query") {
      onReorderQuery?.(dragState.tabId, index);
    } else if (kind === "table") {
      onReorderTable?.(dragState.tabId, index);
    }
    setDragState(null);
    setDropTarget(null);
  }

  /**
   * Requests detachment only when a native drag ends beyond the current window rectangle.
   * @param event - Native drag-end event from a tab.
   * @param kind - Detachable collection that owns the tab.
   * @param tabId - Tab that finished dragging.
   * @returns Nothing (`void`).
   * Side effects: may request one detached workspace, and always clears drag state.
   */
  function handleWorkspaceDragEnd(
    event: DragEvent<HTMLButtonElement>,
    kind: WorkspaceDetachRequest["kind"],
    tabId: string,
  ): void {
    event.currentTarget.parentElement?.classList.remove("is-dragging");
    const point = { x: event.screenX, y: event.screenY };
    if (onDetach && isScreenPointOutsideWindow(point)) {
      onDetach({ kind, point, tabId });
    }
    setDragState(null);
    setDropTarget(null);
  }

  /**
   * Opens the tab action menu inside the visible viewport.
   * @param event - Native context-menu event from a tab.
   * @param kind - Collection that owns the tab.
   * @param tabId - Tab whose actions should be shown.
   * @returns Nothing (`void`).
   * Side effects: positions and opens the menu.
   */
  function handleTabContextMenu(
    event: MouseEvent<HTMLElement>,
    kind: WorkspaceTabKind,
    tabId: string,
  ): void {
    event.preventDefault();
    setTabMenu({
      kind,
      tabId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - TAB_MENU_WIDTH - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - TAB_MENU_HEIGHT - 8)),
    });
  }

  /** Returns the ordered tab identifiers for one collection. */
  function tabIdsForKind(kind: WorkspaceTabKind): string[] {
    if (kind === "query") return queryTabs.map((tab) => tab.id);
    if (kind === "table") return tableTabs.map((tab) => tab.id);
    return utilityTabs.map((tab) => tab.id);
  }

  /**
   * 将关闭请求路由到对应集合，同时保护仍在执行 SQL 的查询标签。
   * @param kind - 标签所属集合。
   * @param tabId - 待关闭的标签标识。
   * @returns 无返回值。
   * Side effects: 非执行中的标签会触发父级关闭回调。
   */
  function closeTabOfKind(kind: WorkspaceTabKind, tabId: string): void {
    if (kind === "query") {
      if (busyQueryTabId === tabId) {
        return;
      }
      onCloseQuery(tabId);
    } else if (kind === "table") {
      onCloseTable(tabId);
    } else {
      onCloseUtility(tabId);
    }
  }

  /**
   * Closes every tab in the menu's collection except the invoking tab.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: issues one close request per remaining tab and closes the menu.
   */
  function handleCloseOthers(): void {
    if (!tabMenu) {
      return;
    }
    const { kind, tabId } = tabMenu;
    setTabMenu(null);
    for (const id of tabIdsForKind(kind)) {
      if (id !== tabId) {
        closeTabOfKind(kind, id);
      }
    }
  }

  /**
   * Closes every tab positioned after the invoking tab in its own collection.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: issues one close request per trailing tab and closes the menu.
   */
  function handleCloseToTheRight(): void {
    if (!tabMenu) {
      return;
    }
    const { kind, tabId } = tabMenu;
    setTabMenu(null);
    const ids = tabIdsForKind(kind);
    const anchorIndex = ids.indexOf(tabId);
    if (anchorIndex === -1) {
      return;
    }
    for (const id of ids.slice(anchorIndex + 1)) {
      closeTabOfKind(kind, id);
    }
  }

  /**
   * Closes every tab in the invoking tab's collection.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: issues one close request per tab and closes the menu.
   */
  function handleCloseAll(): void {
    if (!tabMenu) {
      return;
    }
    const { kind } = tabMenu;
    setTabMenu(null);
    for (const id of tabIdsForKind(kind)) {
      closeTabOfKind(kind, id);
    }
  }

  /**
   * Detaches the menu's tab into its own window without requiring a drag gesture.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: requests one detached workspace positioned near the menu.
   */
  function handleDetachFromMenu(): void {
    if (!tabMenu || !onDetach || tabMenu.kind === "utility") {
      return;
    }
    const { kind, tabId, x, y } = tabMenu;
    setTabMenu(null);
    onDetach({
      kind,
      point: { x: window.screenX + x, y: window.screenY + y },
      tabId,
    });
  }

  /** Reports whether a slot should render the active drop indicator. */
  function isDropSlot(kind: WorkspaceTabKind, index: number): boolean {
    return dropTarget?.kind === kind && dropTarget.index === index;
  }

  /**
   * 判断右移拖放是否应把落点标记画在目标标签右侧。
   * @param kind - 标签所属集合。
   * @param index - 当前目标标签索引。
   * @returns 右移到目标最终位置时返回 `true`。
   * Side effects: none.
   */
  function isDropAfter(kind: WorkspaceTabKind, index: number): boolean {
    if (!isDropSlot(kind, index) || dragState?.kind !== kind) {
      return false;
    }
    return tabIdsForKind(kind).indexOf(dragState.tabId) < index;
  }

  const menuTabCount = tabMenu ? tabIdsForKind(tabMenu.kind).length : 0;
  const menuTabIndex = tabMenu ? tabIdsForKind(tabMenu.kind).indexOf(tabMenu.tabId) : -1;
  const menuTabIsDirtyTable = Boolean(
    tabMenu && tabMenu.kind === "table" && dirtyTableTabIds.has(tabMenu.tabId),
  );
  const menuTabIsBusyQuery = Boolean(
    tabMenu && tabMenu.kind === "query" && busyQueryTabId === tabMenu.tabId,
  );

  return (
    <div className="query-tabs-bar">
      <div className="query-tabs" role="tablist" aria-label="工作区标签">
        {queryTabs.map((tab, index) => {
          const isActive = activeUtilityTabId === null
            && activeTableTabId === null
            && activeQueryTabId === tab.id;
          return (
            <span
              className={`query-tab${isActive ? " is-active" : ""}${
                isDropSlot("query", index) ? " is-drop-target" : ""
              }${isDropAfter("query", index) ? " is-drop-target-after" : ""}`}
              key={tab.id}
              onContextMenu={(event) => handleTabContextMenu(event, "query", tab.id)}
              onDragOver={(event) => handleWorkspaceDragOver(event, "query", index)}
              onDrop={(event) => handleWorkspaceDrop(event, "query", index)}
            >
              <button
                aria-selected={isActive}
                className="query-tab__select"
                data-workspace-tab-id={tab.id}
                draggable={Boolean(onDetach || onReorderQuery) && busyQueryTabId === null}
                onDragEnd={(event) => handleWorkspaceDragEnd(event, "query", tab.id)}
                onDragStart={(event) => handleWorkspaceDragStart(event, "query", tab.id)}
                onClick={() => onSelectQuery(tab.id)}
                role="tab"
                title={busyQueryTabId === null
                  ? "拖动可排序；拖出窗口可分离；右键查看更多操作"
                  : undefined}
                type="button"
              >
                <FileCode2 size={12} aria-hidden="true" />
                <span>{tab.title}</span>
              </button>
              <button
                aria-label={`关闭 ${tab.title}`}
                className="query-tab__close"
                disabled={busyQueryTabId === tab.id}
                onClick={() => onCloseQuery(tab.id)}
                title={isActive ? `关闭标签 · ${closeShortcut}` : "关闭标签"}
                type="button"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          );
        })}
        {tableTabs.map((tab, index) => {
          const isActive = activeUtilityTabId === null && activeTableTabId === tab.id;
          const isDirty = dirtyTableTabIds.has(tab.id);
          return (
            <span
              className={`query-tab query-tab--table${isActive ? " is-active" : ""}${
                isDirty ? " is-dirty" : ""
              }${isDropSlot("table", index) ? " is-drop-target" : ""}${
                isDropAfter("table", index) ? " is-drop-target-after" : ""
              }`}
              key={tab.id}
              onContextMenu={(event) => handleTabContextMenu(event, "table", tab.id)}
              onDragOver={(event) => handleWorkspaceDragOver(event, "table", index)}
              onDrop={(event) => handleWorkspaceDrop(event, "table", index)}
            >
              <button
                aria-label={`${tab.title}${isDirty ? "，有未提交修改" : ""}`}
                aria-selected={isActive}
                className="query-tab__select"
                data-workspace-tab-id={tab.id}
                draggable={Boolean(onDetach || onReorderTable) && busyQueryTabId === null && !isDirty}
                onDragEnd={(event) => handleWorkspaceDragEnd(event, "table", tab.id)}
                onDragStart={(event) => handleWorkspaceDragStart(event, "table", tab.id)}
                onClick={() => onSelectTable(tab.id)}
                role="tab"
                title={isDirty
                  ? "请先提交或撤销表修改，再拖出工作区"
                  : busyQueryTabId === null
                    ? "拖动可排序；拖出窗口可分离；右键查看更多操作"
                    : undefined}
                type="button"
              >
                <Table2 size={12} aria-hidden="true" />
                {isDirty ? <span className="query-tab__dirty" title="有未提交修改" aria-hidden="true" /> : null}
                <span>{tab.title}</span>
              </button>
              <button
                aria-label={`关闭表 ${tab.tableName}`}
                className="query-tab__close"
                onClick={() => onCloseTable(tab.id)}
                title={isActive ? `关闭表工作区 · ${closeShortcut}` : "关闭表工作区"}
                type="button"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          );
        })}
        {utilityTabs.map((tab) => {
          const isActive = activeUtilityTabId === tab.id;
          return (
            <span
              className={`query-tab query-tab--utility${isActive ? " is-active" : ""}`}
              key={tab.id}
              onContextMenu={(event) => handleTabContextMenu(event, "utility", tab.id)}
            >
              <button
                aria-controls={`workspace-panel-${tab.id}`}
                aria-label={tab.title}
                aria-selected={isActive}
                className="query-tab__select"
                data-workspace-tab-id={tab.id}
                id={`workspace-tab-${tab.id}`}
                onClick={() => onSelectUtility(tab.id)}
                role="tab"
                tabIndex={isActive ? 0 : -1}
                type="button"
              >
                <FileClock size={12} aria-hidden="true" />
                <span>{tab.title}</span>
              </button>
              <button
                aria-label={`关闭 ${tab.title}`}
                className="query-tab__close"
                onClick={() => onCloseUtility(tab.id)}
                title={isActive ? `关闭工作区 · ${closeShortcut}` : "关闭工作区"}
                type="button"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          );
        })}
      </div>
      <button
        aria-label={
          newQueryConnectionName
            ? `在当前已选 ${newQueryEngine === "redis" ? "Redis" : "MySQL"} 连接 ${newQueryConnectionName} 中新建${newQueryEngine === "redis" ? "工作区" : "查询"}`
            : "请选择 MySQL 连接后新建查询"
        }
        className="query-new-button"
        disabled={busyQueryTabId !== null || newQueryConnectionName === null}
        onClick={onCreateQuery}
        title={newQueryConnectionName ? `新建查询 · ${newQueryConnectionName} · ${newQueryShortcut}` : undefined}
        type="button"
      >
        <Plus size={13} aria-hidden="true" />
        <span>新建 {newQueryKind}</span>
        <kbd>{newQueryShortcut}</kbd>
      </button>

      {tabMenu ? (
        <div
          aria-label="工作区标签操作"
          className="workspace-tab-menu"
          role="menu"
          style={{ left: tabMenu.x, top: tabMenu.y }}
        >
          <button
            disabled={menuTabIsBusyQuery}
            onClick={() => {
              const { kind, tabId } = tabMenu;
              setTabMenu(null);
              closeTabOfKind(kind, tabId);
            }}
            ref={firstMenuItemRef}
            role="menuitem"
            title={menuTabIsBusyQuery ? "SQL 执行完成后才能关闭此标签" : undefined}
            type="button"
          >
            <X size={13} aria-hidden="true" />
            关闭
          </button>
          <button
            disabled={menuTabCount < 2}
            onClick={handleCloseOthers}
            role="menuitem"
            type="button"
          >
            关闭其他
          </button>
          <button
            disabled={menuTabIndex === -1 || menuTabIndex >= menuTabCount - 1}
            onClick={handleCloseToTheRight}
            role="menuitem"
            type="button"
          >
            关闭右侧标签
          </button>
          <button onClick={handleCloseAll} role="menuitem" type="button">
            全部关闭
          </button>
          {onDetach && tabMenu.kind !== "utility" ? (
            <>
              <span className="workspace-tab-menu__separator" role="separator" />
              <button
                disabled={menuTabIsDirtyTable || busyQueryTabId !== null}
                onClick={handleDetachFromMenu}
                role="menuitem"
                title={menuTabIsDirtyTable ? "请先提交或撤销表修改" : "在独立窗口中打开此工作区"}
                type="button"
              >
                在新窗口中打开
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
