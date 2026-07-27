import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "../../bindings/AppError";
import { recordQueryHistory } from "../../lib/tauriClient";
import {
  createInitialQuerySessionState,
  querySessionReducer,
  useQuerySession,
} from "./useQuerySession";

const channelState = vi.hoisted(() => ({
  instances: [] as Array<{ onmessage: (event: unknown) => void; handlerAssigned: boolean }>,
}));

vi.mock("@tauri-apps/api/core", () => {
  class MockChannel {
    handlerAssigned = false;
    private handler: (event: unknown) => void = () => undefined;

    /**
     * Records every channel so tests can deliver ordered backend events.
     * Parameters: none.
     * @returns A mock Tauri channel.
     * Side effects: adds this instance to the shared test registry.
     */
    constructor() {
      channelState.instances.push(this);
    }

    /** Records the event callback assignment required before command invocation. */
    set onmessage(handler: (event: unknown) => void) {
      this.handlerAssigned = true;
      this.handler = handler;
    }

    /** Returns the current event callback for test-driven event delivery. */
    get onmessage(): (event: unknown) => void {
      return this.handler;
    }
  }

  return { Channel: MockChannel, invoke: vi.fn() };
});

vi.mock("../../lib/tauriClient", () => ({ recordQueryHistory: vi.fn() }));

const QUERY_ERROR: AppError = {
  code: "query",
  message: "SQL 语法错误",
  technicalDetails: null,
  retryable: false,
};

/**
 * Verifies ordered event reduction, terminal semantics, and stale-event isolation.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: none.
 */
function assertOrderedQueryReduction(): void {
  const initial = createInitialQuerySessionState();
  const begun = querySessionReducer(initial, {
    type: "begin",
    queryId: "query-1",
    connectionId: "connection-1",
    sql: "select 1",
  });
  const started = querySessionReducer(begun, {
    type: "event",
    event: { type: "started", queryId: "query-1" },
  });
  const withSchema = querySessionReducer(started, {
    type: "event",
    event: {
      type: "schema",
      queryId: "query-1",
      columns: [{ name: "value", databaseType: "BIGINT", nullable: false }],
    },
  });
  const withFirstBatch = querySessionReducer(withSchema, {
    type: "event",
    event: { type: "batch", queryId: "query-1", rows: [[{ kind: "integer", value: "1" }]] },
  });
  const withBothBatches = querySessionReducer(withFirstBatch, {
    type: "event",
    event: { type: "batch", queryId: "query-1", rows: [[{ kind: "integer", value: "2" }]] },
  });
  const ignored = querySessionReducer(withBothBatches, {
    type: "event",
    event: { type: "completed", queryId: "stale-query", affectedRows: 99 },
  });
  const completed = querySessionReducer(ignored, {
    type: "event",
    event: { type: "completed", queryId: "query-1", affectedRows: 0 },
  });

  expect(started.running).toBe(true);
  expect(withSchema.columns).toEqual([
    { name: "value", databaseType: "BIGINT", nullable: false },
  ]);
  expect(withBothBatches.rows).toEqual([
    [{ kind: "integer", value: "1" }],
    [{ kind: "integer", value: "2" }],
  ]);
  expect(ignored).toBe(withBothBatches);
  expect(completed).toMatchObject({ running: false, affectedRows: 0, incomplete: false });
}

/**
 * Verifies cancel keeps streamed rows and failure keeps immutable query context.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: none.
 */
function assertTerminalStatePreservation(): void {
  const running = querySessionReducer(createInitialQuerySessionState(), {
    type: "begin",
    queryId: "query-2",
    connectionId: "connection-2",
    sql: "select sleep(10)",
  });
  const withRows = querySessionReducer(running, {
    type: "event",
    event: { type: "batch", queryId: "query-2", rows: [[{ kind: "text", value: "partial" }]] },
  });
  const canceled = querySessionReducer(withRows, {
    type: "event",
    event: { type: "canceled", queryId: "query-2" },
  });

  expect(canceled).toMatchObject({ running: false, incomplete: true, rows: withRows.rows });

  const failed = querySessionReducer(running, {
    type: "event",
    event: { type: "failed", queryId: "query-2", error: QUERY_ERROR },
  });
  expect(failed).toMatchObject({
    running: false,
    sql: "select sleep(10)",
    connectionId: "connection-2",
    error: QUERY_ERROR,
  });
}

/**
 * Verifies channel-before-invoke ordering, one active run, and one-shot cancellation.
 * Parameters: none.
 * @returns A promise that settles after simulated terminal delivery.
 * Side effects: renders the hook and calls a mocked Tauri boundary.
 */
async function assertChannelAndCancellationContract(): Promise<void> {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "run_query") {
      expect(channelState.instances).toHaveLength(1);
      expect(channelState.instances[0].handlerAssigned).toBe(true);
      return "query-1";
    }
    return undefined;
  });
  const hook = renderHook(() => useQuerySession("connection-1", { database: "2" }));

  await act(async () => {
    await Promise.all([hook.result.current.run("select 1"), hook.result.current.run("select 2")]);
  });

  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("run_query", {
    request: expect.objectContaining({
      connectionId: "connection-1",
      sql: "select 1",
      database: "2",
    }),
    onEvent: channelState.instances[0],
  });
  expect(hook.result.current.state.running).toBe(true);

  await act(async () => {
    await Promise.all([hook.result.current.cancel(), hook.result.current.cancel()]);
  });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith("cancel_query", {
    queryId: expect.any(String),
  });
  expect(hook.result.current.state).toMatchObject({ running: true, cancelRequested: true });

  act(() => {
    channelState.instances[0].onmessage({ type: "canceled", queryId: hook.result.current.state.queryId });
  });
  expect(hook.result.current.state).toMatchObject({ running: false, incomplete: true });
}

/** Verifies history is written once only after the matching backend Started event. */
async function assertStartedOnlyHistoryContract(): Promise<void> {
  vi.mocked(invoke).mockResolvedValue("query-1");
  vi.mocked(recordQueryHistory).mockResolvedValue(undefined);
  const hook = renderHook(() => useQuerySession("connection-1"));

  await act(async () => hook.result.current.run("select actual_scope"));
  const queryId = hook.result.current.state.queryId;
  expect(recordQueryHistory).not.toHaveBeenCalled();

  act(() => {
    channelState.instances[0].onmessage({ type: "started", queryId: "stale-query" });
    channelState.instances[0].onmessage({ type: "started", queryId });
    channelState.instances[0].onmessage({ type: "started", queryId });
  });
  expect(recordQueryHistory).toHaveBeenCalledTimes(1);
  expect(recordQueryHistory).toHaveBeenCalledWith({
    queryId,
    connectionId: "connection-1",
    sql: "select actual_scope",
  });
}

/** Verifies startup rejection or a pre-Started adapter failure creates no history row. */
async function assertPreStartedFailureSkipsHistory(): Promise<void> {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("invoke failed"));
  const invokeFailure = renderHook(() => useQuerySession("connection-1"));
  await act(async () => invokeFailure.result.current.run("select invoke_failure"));
  expect(recordQueryHistory).not.toHaveBeenCalled();
  invokeFailure.unmount();

  vi.mocked(invoke).mockResolvedValue("query-2");
  const adapterFailure = renderHook(() => useQuerySession("connection-1"));
  await act(async () => adapterFailure.result.current.run("select adapter_failure"));
  act(() => {
    channelState.instances[channelState.instances.length - 1]?.onmessage({
      type: "failed",
      queryId: adapterFailure.result.current.state.queryId,
      error: QUERY_ERROR,
    });
  });
  expect(recordQueryHistory).not.toHaveBeenCalled();
}

/** Registers reducer and hook contract tests. */
function registerQuerySessionTests(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    channelState.instances.length = 0;
  });
  it("reduces ordered events and ignores stale query ids", assertOrderedQueryReduction);
  it("preserves context and partial rows at terminal boundaries", assertTerminalStatePreservation);
  it("subscribes before invoke and cancels once per run", assertChannelAndCancellationContract);
  it("records matching Started history once and ignores stale duplicates", assertStartedOnlyHistoryContract);
  it("does not record history before Started", assertPreStartedFailureSkipsHistory);
}

describe("querySession", registerQuerySessionTests);
