import type { ConnectionProfile } from "../../bindings/ConnectionProfile";

/**
 * Reads the backend-supplied message from an unknown IPC rejection.
 * @param error - Rejection value, which Tauri may deliver as a plain object.
 * @returns The message when present, otherwise `null`.
 */
function backendMessage(error: unknown): string | null {
  return typeof error === "object"
      && error !== null
      && "message" in error
      && typeof error.message === "string"
    ? error.message
    : null;
}

/**
 * Returns a safe connection-deletion error message from an unknown IPC rejection.
 *
 * The fallback states that nothing was removed, because a failed delete must not leave the user
 * believing their connection and its local data are gone.
 * @param error - Rejection raised by the delete command.
 * @returns A message safe to render in the confirmation dialog.
 */
export function getConnectionDeletionError(error: unknown): string {
  return backendMessage(error)
    ?? "删除失败。连接和相关数据均未从当前界面移除，请重试。";
}

/**
 * Returns a safe message for a non-destructive connection action.
 * @param error - Rejection raised by the action.
 * @param fallback - Message to use when the rejection carries none.
 * @returns A message safe to render in a toast.
 */
export function getConnectionActionError(error: unknown, fallback: string): string {
  return backendMessage(error) ?? fallback;
}

/**
 * Serializes only the non-secret fields of one connection profile.
 *
 * Credentials live in the backend's encrypted store and are deliberately absent here, so the
 * result is safe to place on the system clipboard.
 * @param profile - Saved non-secret profile.
 * @returns Formatted JSON describing how to reach the server, without any password.
 */
export function formatConnectionConfigExport(profile: ConnectionProfile): string {
  return JSON.stringify({
    engine: profile.engine,
    name: profile.name,
    environment: profile.environment,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    database: profile.database,
    tlsMode: profile.tlsMode,
  }, null, 2);
}
