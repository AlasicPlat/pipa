import { Check, Plus } from "lucide-react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { Engine } from "../../bindings/Engine";
import type { Environment } from "../../bindings/Environment";

interface ConnectionSidebarProps {
  profiles: ConnectionProfile[];
  selectedConnectionId: string | null;
  onSelectConnection: (id: string) => void;
  onAddConnection: () => void;
}

interface EngineGroup {
  engine: Engine;
  label: string;
}

const ENGINE_GROUPS: readonly EngineGroup[] = [
  { engine: "my_sql", label: "MySQL" },
  { engine: "postgre_sql", label: "PostgreSQL" },
  { engine: "mongo_db", label: "MongoDB" },
  { engine: "redis", label: "Redis" },
];

/**
 * Returns a compact, user-facing label for a profile environment.
 * @param environment - Generated environment value stored on the profile.
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
 * Renders visually independent connection groups and accessible full-row selectors.
 * @param props - Saved profiles, current selection, and sidebar callbacks.
 * @returns The engine-grouped connection navigation element.
 * Side effects: invokes callbacks only after explicit user actions.
 */
export function ConnectionSidebar({
  profiles,
  selectedConnectionId,
  onSelectConnection,
  onAddConnection,
}: ConnectionSidebarProps) {
  return (
    <div className="connection-groups">
      {ENGINE_GROUPS.map(({ engine, label }) => {
        const engineProfiles = profiles.filter((profile) => profile.engine === engine);

        return (
          <section
            className={`engine-section engine-section--${engine}`}
            aria-label={`${label} 连接`}
            key={engine}
          >
            <header className="engine-section__header">
              <span className="engine-section__identity">
                <span className="engine-section__indicator" aria-hidden="true" />
                <h2>{label}</h2>
                <span className="engine-section__count" aria-label={`${engineProfiles.length} 个连接`}>
                  {engineProfiles.length}
                </span>
              </span>
              {engine === "my_sql" ? (
                <button className="engine-section__add" type="button" onClick={onAddConnection}>
                  <Plus size={14} strokeWidth={2} aria-hidden="true" />
                  添加连接
                </button>
              ) : null}
            </header>

            {engineProfiles.length === 0 ? (
              <p className="engine-section__empty">暂无连接</p>
            ) : (
              <div className="connection-list" aria-label={`${label} 已保存连接`}>
                {engineProfiles.map((profile) => {
                  const isSelected = selectedConnectionId === profile.id;

                  return (
                    <button
                      aria-pressed={isSelected}
                      aria-selected={isSelected}
                      className={`connection-row${isSelected ? " is-selected" : ""}`}
                      key={profile.id}
                      onClick={() => onSelectConnection(profile.id)}
                      style={{ minHeight: "40px" }}
                      type="button"
                    >
                      <span className="connection-row__content">
                        <span className="connection-row__title-line">
                          <span className="connection-row__name">{profile.name}</span>
                          <span
                            className={`environment-badge environment-badge--${profile.environment}`}
                          >
                            {getEnvironmentLabel(profile.environment)}
                          </span>
                        </span>
                        <span className="connection-row__meta">
                          {profile.host}:{profile.port}
                          <span aria-hidden="true"> · </span>
                          {profile.database ?? "未指定数据库"}
                        </span>
                      </span>
                      <Check className="connection-row__check" size={15} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
