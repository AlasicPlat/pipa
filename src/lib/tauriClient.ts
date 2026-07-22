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
 * Loads every saved non-secret connection profile from the local desktop backend.
 * Parameters: none.
 * @returns A promise containing the saved connection profiles.
 * Side effects: invokes the Tauri `list_connections` command.
 */
export function listConnections(): Promise<ConnectionProfile[]> {
  return invoke<ConnectionProfile[]>("list_connections");
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
