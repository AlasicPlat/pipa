import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_MCP_SNAPSHOT, type PendingSqlProposal } from "./types";
import { useMcpPendingApprovals, useMcpState } from "./useMcpState";

const PROPOSAL: PendingSqlProposal = {
  id: "proposal-1",
  connectionId: "conn-1",
  sql: "UPDATE users SET name = 'x'",
  risk: "write_data",
  sourceTool: "propose_sql",
  createdAt: "2024-01-01T00:00:00.000Z",
  status: "pending",
  resultSummary: null,
};

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  mcpGetSnapshot: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("../../lib/tauriClient", () => ({
  mcpDismissProposal: vi.fn(),
  mcpExecuteProposal: vi.fn(),
  mcpGetSnapshot: mocks.mcpGetSnapshot,
  mcpRegenerateToken: vi.fn(),
  mcpRunManualSql: vi.fn(),
  mcpSetConnectionScope: vi.fn(),
  mcpSetPort: vi.fn(),
  mcpStart: vi.fn(),
  mcpStop: vi.fn(),
}));

beforeEach(() => {
  mocks.listen.mockReset();
  mocks.mcpGetSnapshot.mockReset();
  mocks.mcpGetSnapshot.mockResolvedValue(EMPTY_MCP_SNAPSHOT);
});

afterEach(() => {
  cleanup();
});

describe("useMcpPendingApprovals", () => {
  it("counts pending proposals from the initial snapshot", async () => {
    mocks.listen.mockResolvedValue(() => undefined);
    mocks.mcpGetSnapshot.mockResolvedValue({
      ...EMPTY_MCP_SNAPSHOT,
      proposals: [
        { ...PROPOSAL, id: "p1", status: "pending" },
        { ...PROPOSAL, id: "p2", status: "pending" },
        { ...PROPOSAL, id: "p3", status: "executed" },
      ],
    });

    const hook = renderHook(() => useMcpPendingApprovals());
    await act(async () => {
      await Promise.resolve();
    });

    expect(hook.result.current).toBe(2);
  });

  it("tracks pending proposals pushed after the console is closed", async () => {
    let emit: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementation(async (_event: string, handler: (event: { payload: unknown }) => void) => {
      emit = handler;
      return () => undefined;
    });

    const hook = renderHook(() => useMcpPendingApprovals());
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current).toBe(0);

    await act(async () => {
      emit?.({
        payload: {
          ...EMPTY_MCP_SNAPSHOT,
          proposals: [{ ...PROPOSAL, id: "p1", status: "pending" }],
        },
      });
    });

    expect(hook.result.current).toBe(1);
  });

  it("stays at zero when the snapshot cannot be read", async () => {
    mocks.listen.mockResolvedValue(() => undefined);
    mocks.mcpGetSnapshot.mockRejectedValue(new Error("backend unavailable"));

    const hook = renderHook(() => useMcpPendingApprovals());
    await act(async () => {
      await Promise.resolve();
    });

    expect(hook.result.current).toBe(0);
  });
});

describe("useMcpState", () => {
  it("unsubscribes when listen resolves after cleanup", async () => {
    const unlisten = vi.fn();
    let resolveListen: ((value: () => void) => void) | undefined;
    mocks.listen.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      }),
    );

    const hook = renderHook(() => useMcpState(true));
    hook.unmount();

    await act(async () => {
      resolveListen?.(unlisten);
      await Promise.resolve();
    });

    expect(unlisten).toHaveBeenCalledOnce();
  });
});
