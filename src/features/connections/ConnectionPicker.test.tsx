import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { ConnectionPicker } from "./ConnectionPicker";

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

const DEV_PROFILE: ConnectionProfile = {
  id: "connection-dev",
  name: "本地开发",
  engine: "my_sql",
  environment: "development",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  database: null,
  tlsMode: "disabled",
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

/** Renders the picker with overridable props. */
function renderPicker(overrides: Partial<Parameters<typeof ConnectionPicker>[0]> = {}) {
  const props = {
    profiles: [MYSQL_PROFILE, DEV_PROFILE, REDIS_PROFILE],
    activeProfile: MYSQL_PROFILE,
    onAddConnection: vi.fn(),
    onOpenConnectionManager: vi.fn(),
    onEditConnection: vi.fn(),
    onSelectConnection: vi.fn(),
    onRequestCreateDatabase: vi.fn(),
    onRequestDelete: vi.fn(),
    onRequestRename: vi.fn(),
    ...overrides,
  };
  return { ...render(<ConnectionPicker {...props} />), props };
}

/** Registers the connection picker tests. */
function registerConnectionPickerTests(): void {
  afterEach(cleanup);

  it("states the current focus and switches it on selection", () => {
    const { props } = renderPicker();

    const trigger = screen.getByRole("button", { name: /当前连接 订单主库 · orders/u });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);

    const list = screen.getByRole("listbox", { name: "已保存的连接" });
    expect(within(list).getByRole("option", { name: /订单主库/u }))
      .toHaveAttribute("aria-selected", "true");

    fireEvent.click(within(list).getByRole("option", { name: /本地开发/u }));
    expect(props.onSelectConnection).toHaveBeenCalledWith(DEV_PROFILE.id);
    // Selecting collapses the picker so the workspace regains focus.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows the browsed schema rather than the saved default", () => {
    renderPicker({ activeDatabase: "analytics" });

    expect(screen.getByRole("button", { name: /当前连接 订单主库 · analytics/u })).toBeVisible();
  });

  it("groups connections by engine and filters them", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /当前连接/u }));

    const list = screen.getByRole("listbox", { name: "已保存的连接" });
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    expect(list).toHaveTextContent("MySQL");
    expect(list).toHaveTextContent("Redis");

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索连接" }), {
      target: { value: "6379" },
    });
    expect(within(list).getAllByRole("option").map((option) => option.textContent))
      .toEqual([expect.stringContaining("本地缓存")]);

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索连接" }), {
      target: { value: "不存在的连接" },
    });
    expect(screen.getByText("没有匹配的连接。")).toBeVisible();
  });

  it("offers connection actions from a row context menu", () => {
    const { props } = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /当前连接/u }));

    const option = screen.getByRole("option", { name: /本地开发/u });
    fireEvent.contextMenu(option, { clientX: 120, clientY: 140 });

    const menu = screen.getByRole("menu", { name: "本地开发 操作" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名…" }));
    expect(props.onRequestRename).toHaveBeenCalledWith(DEV_PROFILE);
  });

  it("omits create-database for engines without user schemas", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /当前连接/u }));

    fireEvent.contextMenu(screen.getByRole("option", { name: /本地缓存/u }), {
      clientX: 100,
      clientY: 100,
    });

    const menu = screen.getByRole("menu", { name: "本地缓存 操作" });
    expect(within(menu).queryByRole("menuitem", { name: "新建数据库…" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "重命名…" })).toBeVisible();
  });

  it("reaches connection creation and management from the same control", () => {
    const { props } = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /当前连接/u }));
    fireEvent.click(screen.getByRole("button", { name: "添加连接…" }));
    expect(props.onAddConnection).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /当前连接/u }));
    fireEvent.click(screen.getByRole("button", { name: "连接管理" }));
    expect(props.onOpenConnectionManager).toHaveBeenCalled();
  });

  it("invites the first connection when none are saved", () => {
    renderPicker({ profiles: [], activeProfile: null });

    fireEvent.click(screen.getByRole("button", { name: "选择连接" }));
    expect(screen.getByText("还没有保存任何连接。")).toBeVisible();
  });

  it("edits a connection from a visible row control", () => {
    const { props } = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /当前连接/u }));

    // Editing is a visible button, not a right-click-only action.
    fireEvent.click(screen.getByRole("button", { name: "编辑 本地开发" }));

    expect(props.onEditConnection).toHaveBeenCalledWith(DEV_PROFILE);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens connection actions from a visible row button", () => {
    const { props } = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /当前连接/u }));

    fireEvent.click(screen.getByRole("button", { name: "本地开发 更多操作" }));

    const menu = screen.getByRole("menu", { name: "本地开发 操作" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "删除连接…" }));
    expect(props.onRequestDelete).toHaveBeenCalledWith(DEV_PROFILE);
  });

  it("closes with Escape without switching connections", () => {
    const { props } = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /当前连接/u }));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(props.onSelectConnection).not.toHaveBeenCalled();
  });
}

describe("ConnectionPicker", registerConnectionPickerTests);
