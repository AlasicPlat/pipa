import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { Engine } from "../../bindings/Engine";
import type { Environment } from "../../bindings/Environment";

/** Engine groups in the order they are offered to the user. */
export const ENGINE_GROUPS: readonly { engine: Engine; label: string }[] = [
  { engine: "my_sql", label: "MySQL" },
  { engine: "postgre_sql", label: "PostgreSQL" },
  { engine: "mongo_db", label: "MongoDB" },
  { engine: "redis", label: "Redis" },
];

/** Returns the display label for one supported database engine. */
export function engineLabel(engine: Engine): string {
  return {
    my_sql: "MySQL",
    postgre_sql: "PostgreSQL",
    mongo_db: "MongoDB",
    redis: "Redis",
  }[engine];
}

/** Returns the compact badge label for one stored connection environment. */
export function environmentLabel(environment: Environment): string {
  return { production: "生产", development: "开发", unspecified: "未指定" }[environment];
}

/**
 * Returns whether a connection's identity fields match a normalized query.
 * @param profile - Saved connection profile.
 * @param normalizedQuery - Lowercased, trimmed search text.
 * @returns `true` when name, host, port, or database contains the query.
 * Side effects: none.
 */
export function connectionIdentityMatches(
  profile: ConnectionProfile,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) {
    return true;
  }
  return [profile.name, profile.host, String(profile.port), profile.database ?? ""]
    .join(" ")
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}
