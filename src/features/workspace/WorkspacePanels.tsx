import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { OpenTableTab } from "./WorkspaceTabs";
import type { WorkspaceTab } from "../query/useWorkspacePersistence";
import { QueryWorkspace } from "../query/QueryWorkspace";
import { RedisWorkspace } from "../redis/RedisWorkspace";
import { TableWorkspace } from "../tables/TableWorkspace";

export interface QueryTabPanelsProps {
  /** Identifier of the active query tab, when a query workspace is focused. */
  activeQueryTabId: string | null;
  /** Whether a table workspace is focused, which hides every query panel. */
  tableWorkspaceActive: boolean;
  /** Whether a utility workspace is focused, which hides every query panel. */
  utilityWorkspaceActive: boolean;
  /** Persisted query tabs, in strip order. */
  tabs: readonly WorkspaceTab[];
  /** Execution profile per tab id; a tab with no resolvable connection is skipped. */
  profiles: ReadonlyMap<string, ConnectionProfile | null>;
  /** Message shown when persisting tab contents failed. */
  persistenceError: string | null;
  /** Editor colour scheme. */
  theme: "dark" | "light";
  /** Records which Redis logical database a workspace switched to. */
  onDatabaseChange: (connectionId: string, database: string) => void;
  /** Retries the failed workspace save. */
  onRetryPersistence: () => Promise<void>;
  /** Reports that one tab started or finished executing. */
  onRunningChange: (tabId: string, running: boolean) => void;
  /** Persists edited editor contents. */
  onSqlChange: (tabId: string, sqlText: string) => void;
}

/**
 * Renders one panel per query tab, keeping inactive panels mounted but hidden.
 *
 * Panels stay mounted so a query keeps running, and its results stay scrolled where the user left
 * them, while they work in another tab.
 * @param props - Tab collection, per-tab profiles, and the workspace callbacks.
 * @returns One hidden-or-visible panel per resolvable tab.
 */
export function QueryTabPanels({
  activeQueryTabId,
  onDatabaseChange,
  onRetryPersistence,
  onRunningChange,
  onSqlChange,
  persistenceError,
  profiles,
  tableWorkspaceActive,
  tabs,
  theme,
  utilityWorkspaceActive,
}: QueryTabPanelsProps): React.JSX.Element {
  return (
    <>
      {tabs.map((tab) => {
        const profile = profiles.get(tab.id) ?? null;
        if (!profile) {
          return null;
        }
        const isActive = !utilityWorkspaceActive
          && !tableWorkspaceActive
          && activeQueryTabId === tab.id;
        return (
          <div
            aria-labelledby={`workspace-tab-${encodeURIComponent(tab.id)}`}
            className="workspace-tab-panel"
            hidden={!isActive}
            id={`workspace-panel-${encodeURIComponent(tab.id)}`}
            key={tab.id}
            role="tabpanel"
          >
            {profile.engine === "redis" ? (
              <RedisWorkspace
                active={isActive}
                onDatabaseChange={(database) => onDatabaseChange(profile.id, database)}
                onRetryPersistence={onRetryPersistence}
                onRunningChange={onRunningChange}
                onSqlChange={onSqlChange}
                persistenceError={persistenceError}
                profile={profile}
                tab={tab}
                theme={theme}
              />
            ) : (
              <QueryWorkspace
                active={isActive}
                onRetryPersistence={onRetryPersistence}
                onRunningChange={onRunningChange}
                onSqlChange={onSqlChange}
                persistenceError={persistenceError}
                profile={profile}
                tab={tab}
                theme={theme}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export interface TableTabPanelsProps {
  /** Identifier of the active table tab, when a table workspace is focused. */
  activeTableTabId: string | null;
  /** Whether a utility workspace is focused, which hides every table panel. */
  utilityWorkspaceActive: boolean;
  /** Open table tabs, in strip order. */
  tabs: readonly OpenTableTab[];
  /** Every saved profile, used to resolve each tab's connection. */
  profiles: readonly ConnectionProfile[];
  /** Reports whether one table workspace holds uncommitted changes. */
  onDirtyChange: (tabId: string, dirty: boolean) => void;
}

/**
 * Renders one panel per open table tab, keeping inactive panels mounted but hidden.
 *
 * Staying mounted is what preserves a table's uncommitted cell edits and structure changes while the
 * user looks at something else.
 * @param props - Tab collection, saved profiles, and the dirty-state callback.
 * @returns One hidden-or-visible panel per tab whose connection is a live MySQL profile.
 */
export function TableTabPanels({
  activeTableTabId,
  onDirtyChange,
  profiles,
  tabs,
  utilityWorkspaceActive,
}: TableTabPanelsProps): React.JSX.Element {
  return (
    <>
      {tabs.map((tab) => {
        const profile = profiles.find((item) => item.id === tab.connectionId);
        return profile?.engine === "my_sql" ? (
          <div
            aria-labelledby={`workspace-tab-${encodeURIComponent(tab.id)}`}
            className="workspace-tab-panel"
            hidden={utilityWorkspaceActive || activeTableTabId !== tab.id}
            id={`workspace-panel-${encodeURIComponent(tab.id)}`}
            key={tab.id}
            role="tabpanel"
          >
            <TableWorkspace
              database={tab.database}
              onDirtyChange={(dirty) => onDirtyChange(tab.id, dirty)}
              profile={profile}
              tableName={tab.tableName}
            />
          </div>
        ) : null;
      })}
    </>
  );
}
