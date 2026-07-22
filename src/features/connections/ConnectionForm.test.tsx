import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import {
  saveMySqlConnection,
  saveRedisConnection,
  testMySqlConnection,
  testRedisConnection,
} from "../../lib/tauriClient";
import { ConnectionForm } from "./ConnectionForm";

vi.mock("../../lib/tauriClient", () => ({
  saveMySqlConnection: vi.fn(),
  saveRedisConnection: vi.fn(),
  testMySqlConnection: vi.fn(),
  testRedisConnection: vi.fn(),
}));

/**
 * Fills and submits the MySQL connection form using representative user input.
 * Parameters: none.
 * @returns A promise that resolves after command ordering and secret cleanup are asserted.
 * Side effects: renders the form, changes its controls, and submits it.
 */
async function assertTestThenSaveFlow(): Promise<void> {
  const invocationOrder: string[] = [];
  const storageWrite = vi.fn();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { setItem: storageWrite },
  });
  const savedProfile: ConnectionProfile = {
    id: "66558eca-2d4d-4092-a9c0-5ea92a15f8f9",
    name: "支付生产库",
    engine: "my_sql",
    environment: "production",
    host: "db.internal",
    port: 3307,
    username: "operator",
    database: "payments",
    tlsMode: "required",
  };
  vi.mocked(testMySqlConnection).mockImplementation(async () => {
    invocationOrder.push("test_mysql_connection");
  });
  vi.mocked(saveMySqlConnection).mockImplementation(async (input) => {
    invocationOrder.push("save_mysql_connection");
    return { ...input.profile, id: savedProfile.id };
  });
  const onSaved = vi.fn();

  render(<ConnectionForm engine="my_sql" onSaved={onSaved} onCancel={vi.fn()} />);
  expect(screen.getByText(/密码仅写入本机加密数据库/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: savedProfile.name } });
  fireEvent.change(screen.getByLabelText("主机"), { target: { value: savedProfile.host } });
  fireEvent.change(screen.getByLabelText("端口"), { target: { value: "3307" } });
  fireEvent.change(screen.getByLabelText("用户名"), { target: { value: savedProfile.username } });
  fireEvent.change(screen.getByLabelText("默认数据库"), {
    target: { value: savedProfile.database },
  });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "ephemeral-secret" } });
  fireEvent.change(screen.getByLabelText("环境"), { target: { value: "production" } });
  fireEvent.change(screen.getByLabelText("TLS"), { target: { value: "required" } });
  fireEvent.click(screen.getByRole("button", { name: "测试并保存" }));

  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(invocationOrder).toEqual(["test_mysql_connection", "save_mysql_connection"]);
  expect(vi.mocked(testMySqlConnection).mock.calls[0][0]).toMatchObject({
    profile: {
      name: savedProfile.name,
      host: savedProfile.host,
      port: 3307,
      username: savedProfile.username,
      database: savedProfile.database,
      environment: "production",
      tlsMode: "required",
      engine: "my_sql",
    },
    password: "ephemeral-secret",
  });
  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.queryByText("ephemeral-secret")).not.toBeInTheDocument();
  expect(storageWrite).not.toHaveBeenCalled();
}

/**
 * Verifies that a failed connection test blocks saving and still erases the password.
 * Parameters: none.
 * @returns A promise that resolves after the failure state is asserted.
 * Side effects: renders, fills, and submits the connection form once.
 */
async function assertFailedTestClearsPassword(): Promise<void> {
  vi.mocked(testMySqlConnection).mockRejectedValue({ message: "连接被拒绝" });
  vi.mocked(saveMySqlConnection).mockResolvedValue({
    id: "94abf914-6cff-4267-90a3-0f9750b8e7f4",
    name: "不会保存",
    engine: "my_sql",
    environment: "unspecified",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    database: null,
    tlsMode: "preferred",
  });

  render(<ConnectionForm engine="my_sql" onSaved={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "拒绝连接" } });
  fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "root" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "temporary-password" } });
  fireEvent.click(screen.getByRole("button", { name: "测试并保存" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("连接被拒绝");
  expect(saveMySqlConnection).not.toHaveBeenCalled();
  expect(screen.getByLabelText("密码")).toHaveValue("");
}

/** Verifies Redis uses its engine defaults and supports passwordless local instances. */
async function assertRedisTestThenSaveFlow(): Promise<void> {
  const savedProfile: ConnectionProfile = {
    id: "ba4a3230-36cb-4f39-aa4d-48be04c202b8",
    name: "本地缓存",
    engine: "redis",
    environment: "development",
    host: "127.0.0.1",
    port: 6379,
    username: "",
    database: "0",
    tlsMode: "disabled",
  };
  vi.mocked(testRedisConnection).mockResolvedValue();
  vi.mocked(saveRedisConnection).mockResolvedValue(savedProfile);
  const onSaved = vi.fn();

  render(<ConnectionForm engine="redis" onSaved={onSaved} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: savedProfile.name } });
  fireEvent.change(screen.getByLabelText("环境"), { target: { value: "development" } });
  fireEvent.click(screen.getByRole("button", { name: "测试并保存" }));

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedProfile));
  expect(testRedisConnection).toHaveBeenCalledWith(expect.objectContaining({
    profile: expect.objectContaining({
      engine: "redis",
      port: 6379,
      database: "0",
      tlsMode: "disabled",
    }),
    password: "",
  }));
  expect(saveRedisConnection).toHaveBeenCalledTimes(1);
}

/**
 * Registers the MySQL connection-form behavior tests.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: resets command mocks and registers one Vitest case.
 */
function registerConnectionFormTests(): void {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);
  it("tests before saving and clears its ephemeral password", assertTestThenSaveFlow);
  it("clears its password when connection testing fails", assertFailedTestClearsPassword);
  it("tests and saves a passwordless Redis connection", assertRedisTestThenSaveFlow);
}

describe("ConnectionForm", registerConnectionFormTests);
