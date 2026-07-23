import { invoke } from "@tauri-apps/api/core";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import type { RecordQueryHistoryInput } from "../bindings/RecordQueryHistoryInput";
import type { SaveConnectionInput } from "../bindings/SaveConnectionInput";

/** Exact non-secret workspace-tab payload shared with the Rust persistence command. */
export interface WorkspaceTabPayload {
  id: string;
  connectionId: string;
  title: string;
  sqlText: string;
  position: number;
}

/**
 * Keeps the native desktop execute-query menu aligned with the configured web shortcut.
 * @param accelerator - Valid Tauri menu accelerator such as `CmdOrCtrl+R`.
 * @returns A promise that resolves after the operating-system menu is updated.
 * Side effects: invokes the Tauri `set_execute_query_accelerator` command.
 */
export function setExecuteQueryAccelerator(accelerator: string): Promise<void> {
  return invoke<void>("set_execute_query_accelerator", { accelerator });
}

/**
 * Loads every saved non-secret connection profile from the local desktop backend.
 * Parameters: none.
 * @returns A promise containing the saved connection profiles.
 * Side effects: invokes the Tauri `list_connections` command.
 */
export function listConnections(): Promise<ConnectionProfile[]> {
  return invoke<ConnectionProfile[]>("list_connections");
}

/**
 * Permanently deletes one connection and its related encrypted local data.
 * @param connectionId - Stable identifier of the connection to remove.
 * @returns A promise that resolves after the idempotent delete transaction commits.
 * Side effects: invokes the Tauri `delete_connection` command.
 */
export function deleteConnection(connectionId: string): Promise<void> {
  return invoke<void>("delete_connection", { connectionId });
}

/**
 * Renames one saved connection while leaving its encrypted credential untouched.
 * @param connectionId - Stable identifier of the connection to rename.
 * @param name - User-visible name; the backend trims and validates it.
 * @returns A promise containing the renamed non-secret profile.
 * Side effects: invokes the Tauri `rename_connection` command.
 */
export function renameConnection(
  connectionId: string,
  name: string,
): Promise<ConnectionProfile> {
  return invoke<ConnectionProfile>("rename_connection", { connectionId, name });
}

/**
 * Re-tests one saved connection with its credential read only by the desktop backend.
 * @param connectionId - Stable identifier of the connection to test again.
 * @returns A promise that resolves when the existing profile is reachable.
 * Side effects: invokes the Tauri `reconnect_connection` command without receiving a password.
 */
export function reconnectConnection(connectionId: string): Promise<void> {
  return invoke<void>("reconnect_connection", { connectionId });
}

/**
 * Tests a MySQL profile and its ephemeral password without persisting either value.
 * @param input - The non-secret profile and password to test.
 * @returns A promise that resolves when the backend confirms connectivity.
 * Side effects: invokes the Tauri `test_mysql_connection` command.
 */
export function testMySqlConnection(input: SaveConnectionInput): Promise<void> {
  return invoke<void>("test_mysql_connection", { input });
}

/**
 * Persists a MySQL profile and transfers its password directly to OS credential storage.
 * @param input - The non-secret profile and ephemeral password to save.
 * @returns A promise containing the backend-confirmed saved profile.
 * Side effects: invokes the Tauri `save_mysql_connection` command.
 */
export function saveMySqlConnection(input: SaveConnectionInput): Promise<ConnectionProfile> {
  return invoke<ConnectionProfile>("save_mysql_connection", { input });
}

/** Tests a Redis profile and ephemeral password without persisting either value. */
export function testRedisConnection(input: SaveConnectionInput): Promise<void> {
  return invoke<void>("test_redis_connection", { input });
}

/** Saves one backend-confirmed Redis profile and its encrypted local credential. */
export function saveRedisConnection(input: SaveConnectionInput): Promise<ConnectionProfile> {
  return invoke<ConnectionProfile>("save_redis_connection", { input });
}

/**
 * Loads ordered unsaved query tabs from encrypted local storage.
 * Parameters: none.
 * @returns A promise containing only safe workspace fields in display order.
 * Side effects: invokes the Tauri `load_workspace` command.
 */
export function loadWorkspace(): Promise<WorkspaceTabPayload[]> {
  return invoke<WorkspaceTabPayload[]>("load_workspace");
}

/**
 * Transactionally replaces the ordered local workspace snapshot.
 * @param tabs - Safe tab identity, immutable connection context, title, SQL, and position.
 * @returns A promise that resolves when encrypted local persistence completes.
 * Side effects: invokes the Tauri `save_workspace` command.
 */
export function saveWorkspace(tabs: WorkspaceTabPayload[]): Promise<void> {
  return invoke<void>("save_workspace", { tabs });
}

/**
 * Records a matching started query once using its stable query identifier.
 * @param input - Immutable connection, exact executed SQL, and stable query identifier.
 * @returns A promise that resolves after the backend stamps UTC time and stores the row.
 * Side effects: invokes the idempotent Tauri `record_query_history` command.
 */
export function recordQueryHistory(input: RecordQueryHistoryInput): Promise<void> {
  return invoke<void>("record_query_history", { input });
}
