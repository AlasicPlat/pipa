import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeQueryOnce } from "./executeQueryOnce";

const channelState = vi.hoisted(() => ({
  instances: [] as Array<{ onmessage: (event: unknown) => void; handlerAssigned: boolean }>,
}));

vi.mock("@tauri-apps/api/core", () => {
  class MockChannel {
    handlerAssigned = false;
    private handler: (event: unknown) => void = () => undefined;

    /** Registers this test channel for deterministic backend event delivery. */
    constructor() {
      channelState.instances.push(this);
    }

    /** Records the event callback assignment. */
    set onmessage(handler: (event: unknown) => void) {
      this.handlerAssigned = true;
      this.handler = handler;
    }

    /** Returns the assigned callback for test-driven delivery. */
    get onmessage(): (event: unknown) => void {
      return this.handler;
    }
  }

  return { Channel: MockChannel, invoke: vi.fn() };
});

describe("executeQueryOnce", () => {
  beforeEach(() => {
    channelState.instances = [];
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue("query-id");
  });

  it("subscribes before invoking and resolves the complete streamed result", async () => {
    const execution = executeQueryOnce("redis-1", "GET key", "2");
    expect(channelState.instances[0]?.handlerAssigned).toBe(true);
    const request = vi.mocked(invoke).mock.calls[0]?.[1] as {
      request: { queryId: string };
    };
    const queryId = request.request.queryId;

    channelState.instances[0].onmessage({
      type: "schema",
      queryId,
      columns: [{ name: "value", databaseType: "REDIS VALUE", nullable: null }],
    });
    channelState.instances[0].onmessage({
      type: "batch",
      queryId,
      rows: [[{ kind: "text", value: "hello" }]],
    });
    channelState.instances[0].onmessage({
      type: "completed",
      queryId,
      affectedRows: 0,
    });

    await expect(execution).resolves.toEqual({
      columns: [{ name: "value", databaseType: "REDIS VALUE", nullable: null }],
      rows: [[{ kind: "text", value: "hello" }]],
      affectedRows: 0,
    });
    expect(invoke).toHaveBeenCalledWith("run_query", {
      request: expect.objectContaining({
        connectionId: "redis-1",
        sql: "GET key",
        database: "2",
      }),
      onEvent: channelState.instances[0],
    });
  });

  it("rejects with the backend error from a matching terminal event", async () => {
    const execution = executeQueryOnce("redis-1", "TYPE key");
    const request = vi.mocked(invoke).mock.calls[0]?.[1] as {
      request: { queryId: string };
    };
    channelState.instances[0].onmessage({
      type: "failed",
      queryId: request.request.queryId,
      error: {
        code: "query",
        message: "Redis command failed",
        technicalDetails: "WRONGTYPE",
        retryable: false,
      },
    });

    await expect(execution).rejects.toMatchObject({
      code: "query",
      technicalDetails: "WRONGTYPE",
    });
  });
});
