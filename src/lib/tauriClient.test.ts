import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import type { SaveConnectionInput } from "../bindings/SaveConnectionInput";
import {
  listConnections,
  loadWorkspace,
  recordQueryHistory,
  saveMySqlConnection,
  saveWorkspace,
  testMySqlConnection,
  type WorkspaceTabPayload,
} from "./tauriClient";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const PROFILE: ConnectionProfile = {
  id: "66558eca-2d4d-4092-a9c0-5ea92a15f8f9",
  name: "测试连接",
  engine: "my_sql",
  environment: "development",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  database: "pipa",
  tlsMode: "preferred",
};
const INPUT: SaveConnectionInput = { profile: PROFILE, password: "ephemeral" };

/**
 * Verifies the exact Rust command names and camel-case Tauri input envelope.
 * Parameters: none.
 * @returns A promise that resolves after all three typed commands are asserted.
 * Side effects: calls the mocked Tauri invoke boundary three times.
 */
async function assertExactConnectionCommands(): Promise<void> {
  vi.mocked(invoke)
    .mockResolvedValueOnce([PROFILE])
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(PROFILE);

  await expect(listConnections()).resolves.toEqual([PROFILE]);
  await expect(testMySqlConnection(INPUT)).resolves.toBeUndefined();
  await expect(saveMySqlConnection(INPUT)).resolves.toEqual(PROFILE);

  expect(invoke).toHaveBeenNthCalledWith(1, "list_connections");
  expect(invoke).toHaveBeenNthCalledWith(2, "test_mysql_connection", { input: INPUT });
  expect(invoke).toHaveBeenNthCalledWith(3, "save_mysql_connection", { input: INPUT });
}

/** Verifies exact workspace and history command names and their safe payload envelopes. */
async function assertExactWorkspaceCommands(): Promise<void> {
  const tabs: WorkspaceTabPayload[] = [
    {
      id: "tab-1",
      connectionId: PROFILE.id,
      title: "查询 1",
      sqlText: "SELECT 1",
      position: 0,
    },
  ];
  const history = {
    queryId: "query-1",
    connectionId: PROFILE.id,
    sql: "SELECT 1",
  };
  vi.mocked(invoke)
    .mockResolvedValueOnce(tabs)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined);

  await expect(loadWorkspace()).resolves.toEqual(tabs);
  await expect(saveWorkspace(tabs)).resolves.toBeUndefined();
  await expect(recordQueryHistory(history)).resolves.toBeUndefined();

  expect(invoke).toHaveBeenNthCalledWith(1, "load_workspace");
  expect(invoke).toHaveBeenNthCalledWith(2, "save_workspace", { tabs });
  expect(invoke).toHaveBeenNthCalledWith(3, "record_query_history", { input: history });
}

/**
 * Registers typed connection IPC contract tests.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: clears the mocked invoke boundary and registers one Vitest case.
 */
function registerTauriClientTests(): void {
  beforeEach(() => vi.clearAllMocks());
  it("uses the exact connection command contract", assertExactConnectionCommands);
  it("uses the exact safe workspace command contracts", assertExactWorkspaceCommands);
}

describe("tauriClient", registerTauriClientTests);
