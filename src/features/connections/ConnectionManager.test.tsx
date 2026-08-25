import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { ConnectionManager } from "./ConnectionManager";

const { executeQueryOnce, reconnectConnection, updateConnectionProfile } = vi.hoisted(() => ({
  executeQueryOnce: vi.fn(),
  reconnectConnection: vi.fn(),
  updateConnectionProfile: vi.fn(),
}));

vi.mock("../query/executeQueryOnce", () => ({ executeQueryOnce }));
vi.mock("../../lib/tauriClient", () => ({ reconnectConnection, updateConnectionProfile }));

const MYSQL_PROFILE: ConnectionProfile = {
  id: "connection-mysql",
  name: "订单主库",
  engine: "my_sql",
  environment: "production",
  host: "10.0.1.5",
  port: 3306,
  username: "app",
  database: "orders",
  tlsMode: "preferred",
};

const REDIS_PROFILE: ConnectionProfile = {
  id: "connection-redis",
  name: "本地缓存",
  engine: "redis",
  environment: "development",
  host: "127.0.0.1",
  port: 6379,
  username: "",
  database: "0",
  tlsMode: "disabled",
};

/** Renders the manager with overridable callbacks. */
function renderManager(overrides: Partial<Parameters<typeof ConnectionManager>[0]> = {}) {
  const props = {
    profiles: [MYSQL_PROFILE, REDIS_PROFILE],
    selectedConnectionId: MYSQL_PROFILE.id,
    onAddConnection: vi.fn(),
    onProfileUpdated: vi.fn(),
    onRequestCreateDatabase: vi.fn(),
    onRequestDeleteDatabase: vi.fn(),
    onRequestDeleteConnection: vi.fn(),
    onSelectConnection: vi.fn(),
    ...overrides,
  };
  return { ...render(<ConnectionManager {...props} />), props };
}

/** Registers the connection manager tests. */
function registerConnectionManagerTests(): void {
  beforeEach(() => {
    executeQueryOnce.mockReset();
    reconnectConnection.mockReset();
    updateConnectionProfile.mockReset();
    executeQueryOnce.mockResolvedValue({
      columns: [],
      affectedRows: 0,
      rows: [
        [{ kind: "text", value: "orders" }, { kind: "text", value: "utf8mb4" }, { kind: "text", value: "utf8mb4_bin" }],
        [{ kind: "text", value: "analytics" }, { kind: "text", value: "utf8mb4" }, { kind: "text", value: "utf8mb4_0900_ai_ci" }],
        [{ kind: "text", value: "mysql" }, { kind: "text", value: "utf8mb4" }, { kind: "text", value: "utf8mb4_bin" }],
      ],
    });
  });
  afterEach(cleanup);

  it("edits a saved profile without asking for its password", async () => {
    updateConnectionProfile.mockImplementation(async (profile: ConnectionProfile) => profile);
    const { props } = renderManager();

    // No password field exists here: the credential stays in encrypted storage.
    expect(screen.queryByLabelText(/密码/u)).not.toBeInTheDocument();
    expect(screen.getByText(/不需要重新输入密码/u)).toBeVisible();

    const save = screen.getByRole("button", { name: "保存配置" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /连接名称/u }), {
      target: { value: "订单生产库" },
    });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(updateConnectionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: MYSQL_PROFILE.id, name: "订单生产库", database: "orders" }),
    ));
    expect(props.onProfileUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ name: "订单生产库" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("已保存连接配置。密码未改动。");
  });

  it("offers the server's schema list when choosing a default database", async () => {
    renderManager();

    const select = await screen.findByRole("combobox", { name: /默认数据库/u });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "未指定",
      "analytics",
      "orders",
      "mysql（系统库）",
    ]);
    expect(select).toHaveValue("orders");
  });

  it("lists databases with their charset and guards system schemas", async () => {
    const { props } = renderManager();

    fireEvent.click(screen.getByRole("tab", { name: /数据库/u }));
    const rows = await screen.findAllByRole("row");
    // Header plus three schemas, user schemas before server-managed ones.
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent("analytics");
    expect(rows[2]).toHaveTextContent("orders默认");
    expect(rows[3]).toHaveTextContent("mysql系统库");
    expect(within(rows[3]!).getByText("受服务器保护")).toBeVisible();
    expect(within(rows[3]!).queryByRole("button", { name: /删除/u })).not.toBeInTheDocument();

    fireEvent.click(within(rows[1]!).getByRole("button", { name: /删除/u }));
    expect(props.onRequestDeleteDatabase).toHaveBeenCalledWith(MYSQL_PROFILE, "analytics");

    fireEvent.click(screen.getByRole("button", { name: "新建数据库" }));
    expect(props.onRequestCreateDatabase).toHaveBeenCalledWith(MYSQL_PROFILE);
  });

  it("never lists tables, keeping browsing to the navigator", async () => {
    renderManager();

    fireEvent.click(screen.getByRole("tab", { name: /数据库/u }));
    await screen.findAllByRole("row");
    const [, sql] = executeQueryOnce.mock.calls[0] ?? [];
    expect(sql).toContain("INFORMATION_SCHEMA.SCHEMATA");
    expect(executeQueryOnce.mock.calls.every(([, statement]) => (
      !String(statement).includes("SHOW FULL TABLES")
    ))).toBe(true);
  });

  it("disables database management for non-MySQL connections", () => {
    renderManager({ selectedConnectionId: REDIS_PROFILE.id });

    expect(screen.getByRole("tab", { name: /数据库/u })).toBeDisabled();
    // Redis logical databases are fixed numbers, so this stays a plain input.
    expect(screen.getByRole("spinbutton", { name: /默认数据库/u })).toHaveValue(0);
  });

  it("re-tests a saved connection using the stored credential", async () => {
    reconnectConnection.mockResolvedValue(undefined);
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() => expect(reconnectConnection).toHaveBeenCalledWith(MYSQL_PROFILE.id));
    expect(await screen.findByRole("status")).toHaveTextContent("连接正常。");
  });

  it("reports a failed save without clearing the draft", async () => {
    updateConnectionProfile.mockRejectedValue({ message: "Connection host cannot be empty" });
    renderManager();

    fireEvent.change(screen.getByRole("textbox", { name: /主机/u }), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Connection host cannot be empty");
    expect(screen.getByRole("textbox", { name: /主机/u })).toHaveValue("  ");
  });

  it("resets the draft when another connection is selected", async () => {
    const { rerender, props } = renderManager();
    fireEvent.change(screen.getByRole("textbox", { name: /连接名称/u }), {
      target: { value: "改了一半" },
    });

    rerender(
      <ConnectionManager
        {...props}
        profiles={[MYSQL_PROFILE, REDIS_PROFILE]}
        selectedConnectionId={REDIS_PROFILE.id}
      />,
    );

    expect(screen.getByRole("textbox", { name: /连接名称/u })).toHaveValue("本地缓存");
  });
}

describe("ConnectionManager", registerConnectionManagerTests);
