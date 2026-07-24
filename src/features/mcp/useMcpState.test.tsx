import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_MCP_SNAPSHOT } from "./types";
import { useMcpState } from "./useMcpState";

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
