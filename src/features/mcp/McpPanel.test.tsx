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
    expect(screen.getByLabelText("端口")).toHaveValue(3847);
    expect(screen.queryByRole("heading", { name: "手动 SQL" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("switch", { name: "是否指定 MCP 连接" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "展开 MCP 控制台" }));

    expect(screen.getByRole("dialog")).toHaveClass("mcp-panel--expanded");
    expect(screen.getByRole("button", { name: "收缩 MCP 控制台" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("collapses and expands the MCP target connection list", () => {
    render(
      <McpPanel
        onClose={() => undefined}
        open
        profiles={[PROFILE, REDIS_PROFILE]}
      />,
    );

    const disclosure = screen.getByRole("button", { name: /MCP 目标连接/ });
    const targetGroup = document.getElementById("mcp-target-connections");
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(targetGroup).not.toHaveAttribute("hidden");
    expect(screen.getByRole("checkbox", { name: "MySQL · Local MySQL · pipa" })).toBeVisible();

    fireEvent.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(targetGroup).toHaveAttribute("hidden");
    expect(document.querySelector(".mcp-panel__selected-chips")).toHaveTextContent(
      "MySQL · Local MySQL · pipa",
    );

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(targetGroup).not.toHaveAttribute("hidden");
    expect(screen.getByRole("checkbox", { name: "MySQL · Local MySQL · pipa" })).toBeVisible();
  });

  it("expands and collapses individual activity log rows", () => {
    render(<McpPanel onClose={() => undefined} open profiles={[PROFILE]} />);

    const rowToggle = screen.getByRole("button", { name: /list_connections/ });
    const detail = document.getElementById("mcp-activity-detail-act-1");
    expect(rowToggle).toHaveAttribute("aria-expanded", "false");
    expect(detail).toHaveAttribute("hidden");

    fireEvent.click(rowToggle);
    expect(rowToggle).toHaveAttribute("aria-expanded", "true");
    expect(detail).not.toHaveAttribute("hidden");
    expect(screen.getByText("无额外详情")).toBeVisible();

    fireEvent.click(rowToggle);
    expect(rowToggle).toHaveAttribute("aria-expanded", "false");
    expect(detail).toHaveAttribute("hidden");
  });

  it("closes on Escape and on a backdrop click", () => {
    const onClose = vi.fn();
    render(<McpPanel onClose={onClose} open profiles={[PROFILE]} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = document.querySelector(".mcp-panel-backdrop");
    if (!backdrop) throw new Error("expected the console to render a backdrop");
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);

    // Interacting inside the dialog must not dismiss it.
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("masks the bearer token until it is explicitly revealed", () => {
    render(<McpPanel onClose={() => undefined} open profiles={[PROFILE]} />);

    expect(screen.queryByText("abc123")).not.toBeInTheDocument();
    const reveal = screen.getByRole("button", { name: "显示 Token" });
    expect(reveal).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(reveal);
    expect(screen.getByText("abc123")).toBeVisible();
    expect(screen.getByRole("button", { name: "隐藏 Token" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("explains why an invalid port was rejected", () => {
    render(<McpPanel onClose={() => undefined} open profiles={[PROFILE]} />);

    const apply = screen.getByRole("button", { name: "应用" });
    // Nothing typed yet, so there is nothing to apply.
    expect(apply).toBeDisabled();

    fireEvent.change(screen.getByLabelText("端口"), { target: { value: "70000" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(screen.getByRole("alert")).toHaveTextContent("端口需为 1 到 65535 之间的整数。");
  });

  it("leads with approvals and flags the scope risk while unrestricted", () => {
    render(<McpPanel onClose={() => undefined} open profiles={[PROFILE]} />);

    // A waiting proposal reprioritizes the stacked layout.
    expect(screen.getByRole("dialog")).toHaveClass("mcp-panel--has-pending");
    expect(
      screen.getByText(/未限定范围时，MCP 可以访问全部 1 个已保存连接/),
    ).toBeVisible();
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
