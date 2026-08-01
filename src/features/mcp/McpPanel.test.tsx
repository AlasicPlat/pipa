import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { McpPanel } from "./McpPanel";
import { EMPTY_MCP_SNAPSHOT } from "./types";

const mocks = vi.hoisted(() => ({
  setConnectionScope: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(),
}));

vi.mock("./useMcpState", () => ({
  useMcpState: () => ({
    snapshot: {
      ...EMPTY_MCP_SNAPSHOT,
      status: {
        ...EMPTY_MCP_SNAPSHOT.status,
        running: true,
        targetConnectionIds: ["conn-1"],
        url: "http://127.0.0.1:3847/mcp",
        token: "abc123",
      },
      proposals: [
        {
          id: "proposal-1",
          connectionId: "conn-1",
          sql: "UPDATE users SET name = 'x'",
          risk: "write_data",
          sourceTool: "propose_sql",
          createdAt: new Date().toISOString(),
          status: "pending",
          resultSummary: null,
        },
      ],
      activity: [
        {
          id: "act-1",
          createdAt: new Date().toISOString(),
          tool: "list_connections",
          connectionId: null,
          summary: "listed 1 connection(s)",
          ok: true,
          detail: null,
        },
      ],
    },
    loading: false,
    busy: false,
    error: null,
    refresh: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    setPort: vi.fn(),
    setConnectionScope: mocks.setConnectionScope,
    regenerateToken: vi.fn(),
    executeProposal: vi.fn(),
    dismissProposal: vi.fn(),
    runManualSql: vi.fn(),
  }),
}));

const PROFILE: ConnectionProfile = {
  id: "conn-1",
  name: "Local MySQL",
  engine: "my_sql",
  environment: "production",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  database: "pipa",
  tlsMode: "preferred",
};

const REDIS_PROFILE: ConnectionProfile = {
  ...PROFILE,
  id: "conn-2",
  engine: "redis",
  port: 6379,
  database: "0",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("McpPanel", () => {
  it("renders status, pending proposal, and activity when open", () => {
    render(<McpPanel onClose={() => undefined} open profiles={[PROFILE]} />);

    expect(screen.getByRole("heading", { name: "MCP 控制台" })).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("UPDATE users SET name = 'x'")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeInTheDocument();
    expect(screen.getAllByText("list_connections")).toHaveLength(2);
    expect(screen.getByText("生产")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <McpPanel onClose={() => undefined} open={false} profiles={[PROFILE]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("disambiguates connection types and toggles the expanded workspace", () => {
    render(
      <McpPanel
        onClose={() => undefined}
        open
        profiles={[PROFILE, REDIS_PROFILE]}
      />,
    );

    expect(
      screen.getByRole("checkbox", { name: "Redis · Local MySQL · 0" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "MySQL · Local MySQL · pipa" }),
    ).toBeChecked();
    expect(
      screen.getByRole("option", { name: "MySQL · Local MySQL · pipa · 生产" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "是否指定 MCP 连接" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "展开 MCP 控制台" }));

    expect(screen.getByRole("dialog")).toHaveClass("mcp-panel--expanded");
    expect(screen.getByRole("button", { name: "收缩 MCP 控制台" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("adds another MCP target without replacing the existing selection", () => {
    render(
      <McpPanel
        onClose={() => undefined}
        open
        profiles={[PROFILE, REDIS_PROFILE]}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Redis · Local MySQL · 0" }));

    expect(mocks.setConnectionScope).toHaveBeenCalledWith(false, ["conn-1", "conn-2"]);
  });
});
