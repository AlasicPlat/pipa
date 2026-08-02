import { FileClock, FileCode2, Plus, Table2, X } from "lucide-react";
import { type DragEvent } from "react";
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
  onSelectQuery: (tabId: string) => void;
  onSelectTable: (tabId: string) => void;
  onSelectUtility: (tabId: string) => void;
}

/**
 * Renders one shared tab strip for query, table, and connection-independent utility workspaces.
 * @param props - Open tabs, active identities, busy guard, and workspace actions.
 * @returns The global workspace tab strip.
 * Side effects: invokes parent actions after explicit button interaction.
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
  onSelectQuery,
  onSelectTable,
  onSelectUtility,
}: WorkspaceTabsProps) {
  const shortcuts = useShortcutSettings();
  const closeShortcut = getShortcutKeyLabels(shortcuts.bindings.closeWorkspace).join(" + ");
  const newQueryShortcut = getShortcutKeyLabels(shortcuts.bindings.newQuery).join(" + ");
  const newQueryKind = newQueryEngine === "redis" ? "Redis 工作区" : "SQL 查询";

  /** Starts one native move drag without triggering an expensive workspace rerender. */
  function handleWorkspaceDragStart(
    event: DragEvent<HTMLButtonElement>,
    tabId: string,
  ): void {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tabId);
    event.currentTarget.parentElement?.classList.add("is-dragging");
  }

  /** Requests detachment only when a native drag ends beyond the current window rectangle. */
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
  }

  return (
    <div className="query-tabs-bar">
      <div className="query-tabs" role="tablist" aria-label="工作区标签">
        {queryTabs.map((tab) => {
          const isActive = activeUtilityTabId === null
            && activeTableTabId === null
            && activeQueryTabId === tab.id;
          return (
            <span className={`query-tab${isActive ? " is-active" : ""}`} key={tab.id}>
              <button
                aria-selected={isActive}
                className="query-tab__select"
                disabled={busyQueryTabId !== null && busyQueryTabId !== tab.id}
                draggable={Boolean(onDetach) && busyQueryTabId === null}
                onDragEnd={(event) => handleWorkspaceDragEnd(event, "query", tab.id)}
                onDragStart={(event) => handleWorkspaceDragStart(event, tab.id)}
                onClick={() => onSelectQuery(tab.id)}
                role="tab"
                title={onDetach && busyQueryTabId === null ? "拖出当前窗口以分离工作区" : undefined}
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
        {tableTabs.map((tab) => {
          const isActive = activeUtilityTabId === null && activeTableTabId === tab.id;
          const isDirty = dirtyTableTabIds.has(tab.id);
          return (
            <span className={`query-tab query-tab--table${isActive ? " is-active" : ""}${isDirty ? " is-dirty" : ""}`} key={tab.id}>
              <button
                aria-label={`${tab.title}${isDirty ? "，有未提交修改" : ""}`}
                aria-selected={isActive}
                className="query-tab__select"
                data-workspace-tab-id={tab.id}
                disabled={busyQueryTabId !== null}
                draggable={Boolean(onDetach) && busyQueryTabId === null && !isDirty}
                onDragEnd={(event) => handleWorkspaceDragEnd(event, "table", tab.id)}
                onDragStart={(event) => handleWorkspaceDragStart(event, tab.id)}
                onClick={() => onSelectTable(tab.id)}
                role="tab"
                title={isDirty
                  ? "请先提交或撤销表修改，再拖出工作区"
                  : onDetach && busyQueryTabId === null ? "拖出当前窗口以分离工作区" : undefined}
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
            <span className={`query-tab query-tab--utility${isActive ? " is-active" : ""}`} key={tab.id}>
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
    </div>
  );
}
