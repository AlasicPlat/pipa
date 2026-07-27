import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { executeQueryOnce } from "../query/executeQueryOnce";
import type { WorkspaceTab } from "../query/useWorkspacePersistence";
import { RedisWorkspace } from "./RedisWorkspace";

vi.mock("../query/executeQueryOnce", () => ({ executeQueryOnce: vi.fn() }));
vi.mock("../query/QueryWorkspace", () => ({
  QueryWorkspace: () => <section aria-label="模拟 Redis 命令工作台" />,
}));

const PROFILE: ConnectionProfile = {
  id: "redis-1",
  name: "本地缓存",
  engine: "redis",
  environment: "development",
  host: "127.0.0.1",
  port: 6379,
  username: "",
  database: "0",
  tlsMode: "disabled",
};

const TAB: WorkspaceTab = {
  id: "tab-1",
  connectionId: PROFILE.id,
  title: "本地缓存 · 命令 1",
  sqlText: "PING",
  position: 0,
};

const WORKSPACE_PROPS = {
  profile: PROFILE,
  tab: TAB,
  theme: "light" as const,
  persistenceError: null,
  onDatabaseChange: vi.fn(),
  onRetryPersistence: vi.fn(),
  onRunningChange: vi.fn(),
  onSqlChange: vi.fn(),
};

/**
 * Produces deterministic Redis results for browser reads and successful writes.
 * @param _connectionId - Connection fixed by the rendered workspace.
 * @param command - Native Redis command being tested.
 * @returns A complete internal query result.
 * Side effects: none.
 */
async function redisResult(_connectionId: string, command: string) {
  if (command.startsWith("SCAN ")) {
    return {
      columns: [
        { name: "cursor", databaseType: "REDIS CURSOR", nullable: null },
        { name: "key", databaseType: "REDIS VALUE", nullable: null },
      ],
      rows: [[
        { kind: "integer" as const, value: "0" },
        { kind: "text" as const, value: "cache:user:1" },
      ]],
      affectedRows: 0,
    };
  }
  if (command.startsWith("TYPE ")) {
    return {
      columns: [{ name: "value", databaseType: "REDIS VALUE", nullable: null }],
      rows: [[{ kind: "text" as const, value: "string" }]],
      affectedRows: 0,
    };
  }
  if (command.startsWith("TTL ")) {
    return {
      columns: [{ name: "value", databaseType: "REDIS VALUE", nullable: null }],
      rows: [[{ kind: "integer" as const, value: "-1" }]],
      affectedRows: 0,
    };
  }
  if (command.startsWith("MEMORY USAGE ")) {
    return {
      columns: [{ name: "value", databaseType: "REDIS VALUE", nullable: null }],
      rows: [[{ kind: "integer" as const, value: "128" }]],
      affectedRows: 0,
    };
  }
  if (command.startsWith("GET ")) {
    return {
      columns: [{ name: "value", databaseType: "REDIS VALUE", nullable: null }],
      rows: [[{ kind: "text" as const, value: "hello" }]],
      affectedRows: 0,
    };
  }
  return {
    columns: [{ name: "value", databaseType: "REDIS VALUE", nullable: null }],
    rows: [[{ kind: "integer" as const, value: "1" }]],
    affectedRows: 1,
  };
}

describe("RedisWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeQueryOnce).mockImplementation(redisResult);
  });
  afterEach(cleanup);

  it("switches to an explicitly entered logical database", () => {
    render(<RedisWorkspace {...WORKSPACE_PROPS} />);
    const database = screen.getByRole("spinbutton", { name: "切换 Redis 数据库" });

    fireEvent.change(database, { target: { value: "2" } });
    fireEvent.blur(database);

    expect(WORKSPACE_PROPS.onDatabaseChange).toHaveBeenCalledWith("2");
  });

  it("scans, searches, filters, and opens a bounded structured key preview", async () => {
    render(<RedisWorkspace {...WORKSPACE_PROPS} />);

    const key = await screen.findByRole("option", { name: /cache:user:1/ });
    fireEvent.click(key);
    expect(await screen.findByRole("heading", { name: "cache:user:1" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Redis 键值" })).toHaveValue("hello");
    expect(screen.getByText("128 B")).toBeVisible();
    expect(executeQueryOnce).toHaveBeenCalledWith("redis-1", 'GET "cache:user:1"', "0");

    const search = screen.getByRole("searchbox", { name: "搜索 Redis 键" });
    fireEvent.keyDown(document, { key: "f", metaKey: true });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "session" } });
    fireEvent.click(screen.getByRole("button", { name: "执行键搜索" }));
    await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
      "redis-1",
      'SCAN 0 MATCH "*session*" COUNT 200',
      "0",
    ));

    fireEvent.click(screen.getByRole("button", { name: "Hash" }));
    await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
      "redis-1",
      'SCAN 0 MATCH "*session*" COUNT 200 TYPE hash',
      "0",
    ));
  });

  it("requires confirmation for every production write and exposes the exact command", async () => {
    render(<RedisWorkspace
      {...WORKSPACE_PROPS}
      profile={{ ...PROFILE, environment: "production" }}
    />);
    fireEvent.click(await screen.findByRole("option", { name: /cache:user:1/ }));
    const value = await screen.findByRole("textbox", { name: "Redis 键值" });
    fireEvent.change(value, { target: { value: "updated" } });
    fireEvent.click(screen.getByRole("button", { name: "保存值" }));

    const confirmation = screen.getByRole("alertdialog", { name: "保存值" });
    expect(confirmation).toHaveTextContent('SET "cache:user:1" "updated" KEEPTTL');
    expect(executeQueryOnce).not.toHaveBeenCalledWith(
      "redis-1",
      'SET "cache:user:1" "updated" KEEPTTL',
      "0",
    );

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
      "redis-1",
      'SET "cache:user:1" "updated" KEEPTTL',
      "0",
    ));
  });

  it("always confirms destructive deletion and clears the selected key afterward", async () => {
    render(<RedisWorkspace {...WORKSPACE_PROPS} />);
    fireEvent.click(await screen.findByRole("option", { name: /cache:user:1/ }));
    await screen.findByRole("heading", { name: "cache:user:1" });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    expect(screen.getByRole("alertdialog", { name: "删除键" })).toHaveTextContent("无法撤销");
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
      "redis-1",
      'DEL "cache:user:1"',
      "0",
    ));
    await waitFor(() => expect(
      screen.getByText("选择一个键查看数据"),
    ).toBeVisible());
  });

  it("round-trips binary String values through Base64 without rewriting them as text", async () => {
    vi.mocked(executeQueryOnce).mockImplementation(async (connectionId, command) => {
      if (command.startsWith("GET ")) {
        return {
          columns: [{ name: "value", databaseType: "REDIS VALUE", nullable: null }],
          rows: [[{ kind: "binary" as const, value: "AP9B" }]],
          affectedRows: 0,
        };
      }
      return redisResult(connectionId, command);
    });
    render(<RedisWorkspace {...WORKSPACE_PROPS} />);
    fireEvent.click(await screen.findByRole("option", { name: /cache:user:1/ }));

    const value = await screen.findByRole("textbox", {
      name: "Redis 二进制键值（Base64）",
    });
    expect(value).toHaveValue("AP9B");
    fireEvent.change(value, { target: { value: "AAEC" } });
    fireEvent.click(screen.getByRole("button", { name: "保存值" }));

    await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
      "redis-1",
      'SET "cache:user:1" "\\x00\\x01\\x02" KEEPTTL',
      "0",
    ));
  });

  it("creates collection keys with TTL in one atomic Redis operation", async () => {
    render(<RedisWorkspace {...WORKSPACE_PROPS} />);
    await screen.findByRole("option", { name: /cache:user:1/ });
    fireEvent.click(screen.getByRole("button", { name: "新建键" }));
    fireEvent.change(screen.getByLabelText("数据类型"), { target: { value: "list" } });
    fireEvent.change(screen.getByLabelText("键名"), { target: { value: "queue" } });
    fireEvent.change(screen.getByLabelText("初始值"), { target: { value: "job-1" } });
    fireEvent.change(screen.getByLabelText("TTL（可选，秒）"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "创建键" }));

    await waitFor(() => expect(executeQueryOnce).toHaveBeenCalledWith(
      "redis-1",
      expect.stringMatching(/^EVAL .* 1 "queue" "RPUSH" "job-1" 60$/u),
      "0",
    ));
    expect(vi.mocked(executeQueryOnce).mock.calls.some(
      ([, command]) => command.startsWith('EXPIRE "queue"'),
    )).toBe(false);
  });
});
