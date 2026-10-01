import { Channel, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AppError } from "../../bindings/AppError";
import type { QueryColumn } from "../../bindings/QueryColumn";
import type { QueryEvent } from "../../bindings/QueryEvent";
import type { QueryRequest } from "../../bindings/QueryRequest";
import type { CellValue } from "../../bindings/CellValue";
import { recordQueryHistory } from "../../lib/tauriClient";

export interface QuerySessionState {
  queryId: string | null;
  connectionId: string | null;
  sql: string;
  columns: QueryColumn[];
  rows: CellValue[][];
  running: boolean;
  cancelRequested: boolean;
  incomplete: boolean;
  affectedRows: number | null;
  error: AppError | null;
}

export type QuerySessionAction =
  | { type: "begin"; queryId: string; connectionId: string; sql: string }
  | { type: "event"; event: QueryEvent }
  | { type: "cancel-requested"; queryId: string }
  | { type: "start-failed"; queryId: string; error: AppError };

interface QuerySessionController {
  state: QuerySessionState;
  run: (sql: string) => Promise<void>;
  cancel: () => Promise<void>;
}

interface QuerySessionOptions {
  /** Whether successful query starts should appear in user query history. */
  recordHistory?: boolean;
  /** Optional Redis database selected for every execution in this session. */
  database?: string | null;
}

/**
 * Creates an empty, immutable query-session snapshot.
 * Parameters: none.
 * @returns The initial state for one query workspace.
 * Side effects: none.
 */
export function createInitialQuerySessionState(): QuerySessionState {
  return {
    queryId: null,
    connectionId: null,
    sql: "",
    columns: [],
    rows: [],
    running: false,
    cancelRequested: false,
    incomplete: false,
    affectedRows: null,
    error: null,
  };
}

/**
 * Reduces one local command or ordered backend event into the next query snapshot.
 * @param state - Current immutable state for one workspace.
 * @param action - Local lifecycle action or generated streaming event.
 * @returns The next state, or the same reference when an event belongs to a stale query.
 * Side effects: none. Rows are appended in channel order and canceled rows remain visible.
 */
export function querySessionReducer(
  state: QuerySessionState,
  action: QuerySessionAction,
): QuerySessionState {
  if (action.type === "begin") {
    return {
      queryId: action.queryId,
      connectionId: action.connectionId,
      sql: action.sql,
      columns: [],
      rows: [],
      running: true,
      cancelRequested: false,
      incomplete: false,
      affectedRows: null,
      error: null,
    };
  }

  if (action.type === "cancel-requested") {
    return action.queryId === state.queryId ? { ...state, cancelRequested: true } : state;
  }

  if (action.type === "start-failed") {
    return action.queryId === state.queryId
      ? { ...state, running: false, cancelRequested: false, error: action.error }
      : state;
  }

  const event = action.event;
  if (event.queryId !== state.queryId) {
    return state;
  }

  switch (event.type) {
    case "started":
      return { ...state, running: true };
    case "schema":
      return { ...state, columns: event.columns };
    case "batch":
      return { ...state, rows: [...state.rows, ...event.rows] };
    case "completed":
      return {
        ...state,
        running: false,
        cancelRequested: false,
        incomplete: false,
        affectedRows: event.affectedRows,
      };
    case "canceled":
      return { ...state, running: false, cancelRequested: false, incomplete: true };
    case "failed":
      return { ...state, running: false, cancelRequested: false, error: event.error };
  }
}

/**
 * Converts an unknown Tauri invocation rejection into a safe display error.
 * @param error - Unknown rejection value from the IPC boundary.
 * @returns A stable AppError without exposing arbitrary object data.
 * Side effects: none.
 */
function toAppError(error: unknown): AppError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return error as AppError;
  }

  return {
    code: "internal",
    message: "无法启动查询，请重试。",
    technicalDetails: null,
    retryable: true,
  };
}

/**
 * Owns one connection-bound query run, ordered channel delivery, and one-shot cancellation.
 * @param connectionId - Saved executable connection fixed to this workspace instance.
 * @param options - Optional behavior for internal metadata queries.
 * @returns Current state and asynchronous run/cancel commands.
 * Side effects: invokes exact Tauri query commands; never sends credentials to the frontend.
 */
export function useQuerySession(
  connectionId: string,
  options: QuerySessionOptions = {},
): QuerySessionController {
  const recordHistoryEnabled = options.recordHistory ?? true;
  const database = options.database ?? null;
  const [state, dispatch] = useReducer(
    querySessionReducer,
    undefined,
    createInitialQuerySessionState,
  );
  const activeQueryIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);
  const historyRecordedQueryIdRef = useRef<string | null>(null);
  /*
   * Rows arrive in 256-row batches, and dispatching each one separately re-rendered the grid
   * hundreds of times per large result while copying the whole accumulated array each time. Rows
   * are buffered here and merged into one dispatch per animation frame instead, which keeps
   * scrolling and typing responsive while a long query streams in.
   */
  const pendingRowsRef = useRef<{ queryId: string; rows: CellValue[][] } | null>(null);
  const flushHandleRef = useRef<number | null>(null);

  /**
   * Cancels any scheduled row flush without discarding the buffered rows.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: clears the pending animation-frame callback.
   */
  const cancelScheduledFlush = useCallback((): void => {
    if (flushHandleRef.current !== null) {
      cancelAnimationFrame(flushHandleRef.current);
      flushHandleRef.current = null;
    }
  }, []);

  /**
   * Dispatches every buffered row for its owning query as one batch event.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: empties the row buffer and updates session state when rows are pending.
   */
  const flushPendingRows = useCallback((): void => {
    cancelScheduledFlush();
    const pending = pendingRowsRef.current;
    pendingRowsRef.current = null;
    if (!pending || pending.rows.length === 0) {
      return;
    }
    dispatch({
      type: "event",
      event: { type: "batch", queryId: pending.queryId, rows: pending.rows },
    });
  }, [cancelScheduledFlush]);

  // A late flush after unmount would dispatch into a discarded reducer.
  useEffect(() => () => {
    cancelScheduledFlush();
    pendingRowsRef.current = null;
  }, [cancelScheduledFlush]);

  /**
   * Starts engine-native text only when this workspace has no active execution.
   * @param sql - Already selected and trimmed SQL or Redis command text.
   * @returns A promise that resolves after the backend accepts or rejects startup.
   * Side effects: creates an event channel, subscribes before IPC, and updates session state.
   */
  const run = useCallback(
    async (sql: string): Promise<void> => {
      if (activeQueryIdRef.current || !sql.trim()) {
        return;
      }

      const queryId = crypto.randomUUID();
      const request: QueryRequest = { queryId, connectionId, sql, database };
      const onEvent = new Channel<QueryEvent>();
      activeQueryIdRef.current = queryId;
      cancelRequestedRef.current = false;
      historyRecordedQueryIdRef.current = null;
      cancelScheduledFlush();
      pendingRowsRef.current = null;
      dispatch({ type: "begin", queryId, connectionId, sql });

      // Assigning first prevents fast backend events from racing the invoke promise.
      onEvent.onmessage = (event) => {
        if (event.type === "batch") {
          // Buffer rows and coalesce them, so one frame renders one batch no matter the row rate.
          const pending = pendingRowsRef.current;
          if (pending && pending.queryId === event.queryId) {
            pending.rows.push(...event.rows);
          } else {
            pendingRowsRef.current = { queryId: event.queryId, rows: [...event.rows] };
          }
          if (flushHandleRef.current === null) {
            flushHandleRef.current = requestAnimationFrame(() => {
              flushHandleRef.current = null;
              flushPendingRows();
            });
          }
          return;
        }

        // Every other event is ordered against the rows before it, so pending rows land first.
        flushPendingRows();
        dispatch({ type: "event", event });
        if (
          event.type === "started" &&
          activeQueryIdRef.current === event.queryId &&
          historyRecordedQueryIdRef.current !== event.queryId &&
          recordHistoryEnabled
        ) {
          historyRecordedQueryIdRef.current = event.queryId;
          void recordQueryHistory({ queryId: event.queryId, connectionId, sql }).catch((error) => {
            // History is secondary to the live query and failures never reveal SQL in logs.
            console.error("Pipa record_query_history invocation failed", {
              queryId: event.queryId,
              error: toAppError(error),
            });
          });
        }
        if (event.type === "completed" || event.type === "canceled" || event.type === "failed") {
          if (activeQueryIdRef.current === event.queryId) {
            activeQueryIdRef.current = null;
            cancelRequestedRef.current = false;
          }
        }
      };

      try {
        await invoke<string>("run_query", { request, onEvent });
      } catch (error) {
        if (activeQueryIdRef.current === queryId) {
          activeQueryIdRef.current = null;
          cancelRequestedRef.current = false;
          dispatch({ type: "start-failed", queryId, error: toAppError(error) });
        }
      }
    },
    [connectionId, database, recordHistoryEnabled, cancelScheduledFlush, flushPendingRows],
  );

  /**
   * Requests cancellation once and intentionally keeps loading visible until a terminal event.
   * Parameters: none.
   * @returns A promise that resolves after the cancellation request is sent.
   * Side effects: invokes `cancel_query` at most once for the active run.
   */
  const cancel = useCallback(async (): Promise<void> => {
    const queryId = activeQueryIdRef.current;
    if (!queryId || cancelRequestedRef.current) {
      return;
    }

    cancelRequestedRef.current = true;
    flushPendingRows();
    dispatch({ type: "cancel-requested", queryId });
    try {
      await invoke<void>("cancel_query", { queryId });
    } catch (error) {
      // A rejected cancellation does not fabricate a terminal event; the original run may finish.
      console.error("Pipa cancel_query invocation failed", { queryId, error: toAppError(error) });
    }
  }, [flushPendingRows]);

  return { state, run, cancel };
}
