import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import type { SaveConnectionInput } from "../bindings/SaveConnectionInput";
import {
  deleteConnection,
  getBinlogResetSql,
  listConnections,
  loadWorkspace,
  mcpSetConnectionScope,
  reconnectConnection,
  recordQueryHistory,
  renameConnection,
  saveMySqlConnection,
  setExecuteQueryAccelerator,
  saveWorkspace,
  testMySqlConnection,
  type WorkspaceTabPayload,
} from "./tauriClient";
import { EMPTY_MCP_SNAPSHOT } from "../features/mcp/types";

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
    .mockResolvedValueOnce(PROFILE)
    .mockResolvedValueOnce(PROFILE)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined);

  await expect(listConnections()).resolves.toEqual([PROFILE]);
  await expect(testMySqlConnection(INPUT)).resolves.toBeUndefined();
  await expect(saveMySqlConnection(INPUT)).resolves.toEqual(PROFILE);
  await expect(renameConnection(PROFILE.id, "Primary database")).resolves.toEqual(PROFILE);
  await expect(reconnectConnection(PROFILE.id)).resolves.toBeUndefined();
  await expect(deleteConnection(PROFILE.id)).resolves.toBeUndefined();

  expect(invoke).toHaveBeenNthCalledWith(1, "list_connections");
  expect(invoke).toHaveBeenNthCalledWith(2, "test_mysql_connection", { input: INPUT });
  expect(invoke).toHaveBeenNthCalledWith(3, "save_mysql_connection", { input: INPUT });
  expect(invoke).toHaveBeenNthCalledWith(4, "rename_connection", {
    connectionId: PROFILE.id,
    name: "Primary database",
  });
  expect(invoke).toHaveBeenNthCalledWith(5, "reconnect_connection", {
    connectionId: PROFILE.id,
  });
  expect(invoke).toHaveBeenNthCalledWith(6, "delete_connection", {
    connectionId: PROFILE.id,
  });
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

/** Verifies the native query-menu accelerator uses an explicit typed IPC envelope. */
async function assertNativeAcceleratorCommand(): Promise<void> {
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await expect(setExecuteQueryAccelerator("CmdOrCtrl+Shift+E")).resolves.toBeUndefined();
  expect(invoke).toHaveBeenCalledWith("set_execute_query_accelerator", {
    accelerator: "CmdOrCtrl+Shift+E",
  });
}

/** Verifies MCP connection-scope settings use explicit camel-case IPC fields. */
async function assertMcpConnectionScopeCommand(): Promise<void> {
  vi.mocked(invoke).mockResolvedValueOnce(EMPTY_MCP_SNAPSHOT);

  await expect(mcpSetConnectionScope(true, PROFILE.id)).resolves.toEqual(EMPTY_MCP_SNAPSHOT);

  expect(invoke).toHaveBeenCalledWith("mcp_set_connection_scope", {
    restrictToConnection: true,
    targetConnectionId: PROFILE.id,
  });
}

/** Verifies Reset SQL generation uses the exact analysis projection envelope. */
async function assertBinlogResetSqlCommand(): Promise<void> {
  const output = {
    sql: "DELETE FROM `shop`.`orders` WHERE `id` <=> 7 LIMIT 1;",
    statementCount: 1,
    complete: true,
    warnings: [],
  };
  vi.mocked(invoke).mockResolvedValueOnce(output);

  await expect(
    getBinlogResetSql("analysis-1", 7, "shop", "orders", "insert"),
  ).resolves.toEqual(output);

  expect(invoke).toHaveBeenCalledWith("binlog_get_reset_sql", {
    analysisId: "analysis-1",
    sequence: 7,
    database: "shop",
    table: "orders",
    operation: "insert",
  });
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
  it("updates the native execute-query accelerator", assertNativeAcceleratorCommand);
  it("updates the MCP connection scope", assertMcpConnectionScopeCommand);
  it("generates Binlog Reset SQL with the active projection", assertBinlogResetSqlCommand);
}

describe("tauriClient", registerTauriClientTests);
