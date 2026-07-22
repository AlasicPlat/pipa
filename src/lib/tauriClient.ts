import { invoke } from "@tauri-apps/api/core";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import type { SaveConnectionInput } from "../bindings/SaveConnectionInput";

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
