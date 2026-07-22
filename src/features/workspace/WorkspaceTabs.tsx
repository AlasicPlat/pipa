import { FileCode2, Plus, Table2, X } from "lucide-react";
import { getShortcutKeyLabels, useShortcutSettings } from "../commands/shortcutRegistry";
import type { WorkspaceTab } from "../query/useWorkspacePersistence";

export interface OpenTableTab {
  id: string;
  connectionId: string;
  tableName: string;
  title: string;
}

interface WorkspaceTabsProps {
  activeQueryTabId: string | null;
  activeTableTabId: string | null;
  busyQueryTabId: string | null;
  dirtyTableTabIds: ReadonlySet<string>;
  newQueryConnectionName: string | null;
  queryTabs: WorkspaceTab[];
  tableTabs: OpenTableTab[];
  onCloseQuery: (tabId: string) => void;
  onCloseTable: (tabId: string) => void;
  onCreateQuery: () => void;
  onSelectQuery: (tabId: string) => void;
  onSelectTable: (tabId: string) => void;
}

/**
 * Renders one shared tab strip for SQL queries and table object workspaces.
 * @param props - Open tabs, active identities, busy guard, and workspace actions.
 * @returns The global workspace tab strip.
 * Side effects: invokes parent actions after explicit button interaction.
 */
export function WorkspaceTabs({
  activeQueryTabId,
  activeTableTabId,
  busyQueryTabId,
  dirtyTableTabIds,
  newQueryConnectionName,
  queryTabs,
  tableTabs,
  onCloseQuery,
  onCloseTable,
  onCreateQuery,
  onSelectQuery,
  onSelectTable,
}: WorkspaceTabsProps) {
  const shortcuts = useShortcutSettings();
  const closeShortcut = getShortcutKeyLabels(shortcuts.bindings.closeWorkspace).join(" + ");
  const newQueryShortcut = getShortcutKeyLabels(shortcuts.bindings.newQuery).join(" + ");
  return (
    <div className="query-tabs-bar">
      <div className="query-tabs" role="tablist" aria-label="工作区标签">
        {queryTabs.map((tab) => {
          const isActive = activeTableTabId === null && activeQueryTabId === tab.id;
          return (
            <span className={`query-tab${isActive ? " is-active" : ""}`} key={tab.id}>
              <button
                aria-selected={isActive}
                className="query-tab__select"
                disabled={busyQueryTabId !== null && !isActive}
                onClick={() => onSelectQuery(tab.id)}
                role="tab"
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
          const isActive = activeTableTabId === tab.id;
          const isDirty = dirtyTableTabIds.has(tab.id);
          return (
            <span className={`query-tab query-tab--table${isActive ? " is-active" : ""}${isDirty ? " is-dirty" : ""}`} key={tab.id}>
              <button
                aria-label={`${tab.title}${isDirty ? "，有未提交修改" : ""}`}
                aria-selected={isActive}
                className="query-tab__select"
                data-workspace-tab-id={tab.id}
                disabled={busyQueryTabId !== null}
                onClick={() => onSelectTable(tab.id)}
                role="tab"
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
      </div>
      <button
        aria-label={
          newQueryConnectionName
            ? `在当前已选 MySQL 连接 ${newQueryConnectionName} 中新建查询`
            : "请选择 MySQL 连接后新建查询"
        }
        className="query-new-button"
        disabled={busyQueryTabId !== null || newQueryConnectionName === null}
        onClick={onCreateQuery}
        title={newQueryConnectionName ? `新建查询 · ${newQueryConnectionName} · ${newQueryShortcut}` : undefined}
        type="button"
      >
        <Plus size={13} aria-hidden="true" />
        <span>新建 SQL</span>
        <kbd>{newQueryShortcut}</kbd>
      </button>
    </div>
  );
}
