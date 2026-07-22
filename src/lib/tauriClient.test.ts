import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import type { SaveConnectionInput } from "../bindings/SaveConnectionInput";
import { listConnections, saveMySqlConnection, testMySqlConnection } from "./tauriClient";

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

/**
 * Registers typed connection IPC contract tests.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: clears the mocked invoke boundary and registers one Vitest case.
 */
function registerTauriClientTests(): void {
  beforeEach(() => vi.clearAllMocks());
  it("uses the exact connection command contract", assertExactConnectionCommands);
}

describe("tauriClient", registerTauriClientTests);
