/**
 * Quotes one Redis key for the command editor without changing its UTF-8 content.
 *
 * Only the characters that would otherwise terminate or reinterpret the argument are escaped, so a
 * key containing spaces, quotes, or newlines round-trips through the editor unchanged.
 * @param value - Key name returned by Redis SCAN.
 * @returns Double-quoted redis-cli argument with control characters escaped.
 */
export function quoteRedisArgument(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, "\\\"")
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")}"`;
}

/**
 * Builds the title identifying one key-inspection workspace.
 *
 * The logical database is embedded in the title because a persisted workspace stores only its
 * connection; {@link redisDatabaseFromWorkspaceTitle} recovers it after a restart.
 * @param connectionName - Current non-secret connection name.
 * @param database - Redis logical database number.
 * @param keyName - Exact key name returned by SCAN.
 * @returns The workspace title.
 */
export function redisKeyWorkspaceTitle(
  connectionName: string,
  database: string,
  keyName: string,
): string {
  return `${connectionName} · DB ${database} · ${keyName}`;
}

/**
 * Builds the non-mutating commands that describe one key.
 * @param keyName - Exact key name returned by SCAN.
 * @returns Editor contents inspecting the key's type, expiry, and size.
 */
export function redisKeyInspectionCommands(keyName: string): string {
  const key = quoteRedisArgument(keyName);
  return `TYPE ${key};\nTTL ${key};\nMEMORY USAGE ${key};`;
}

/**
 * Recovers the Redis database embedded in a persisted key-workspace title.
 * @param title - Persisted workspace title created by the Redis navigator.
 * @returns The logical database number, or `null` for generic workspaces.
 */
export function redisDatabaseFromWorkspaceTitle(title: string): string | null {
  return title.match(/ · DB (\d+) · /u)?.[1] ?? null;
}
