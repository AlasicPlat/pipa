import { Channel, invoke } from "@tauri-apps/api/core";
import type { AppError } from "../../bindings/AppError";
import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";
import type { QueryEvent } from "../../bindings/QueryEvent";
import type { QueryRequest } from "../../bindings/QueryRequest";

export interface QueryExecutionResult {
  columns: QueryColumn[];
  rows: CellValue[][];
  affectedRows: number;
}

/**
 * Converts an unknown IPC rejection into a stable application error.
 * @param error - Unknown rejection value from Tauri.
 * @returns A display-safe error with no arbitrary object data.
 * Side effects: none.
 */
function toAppError(error: unknown): AppError {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && "message" in error
    && typeof error.code === "string"
    && typeof error.message === "string"
  ) {
    return error as AppError;
  }

  return {
    code: "internal",
    message: "无法执行 Redis 操作，请重试。",
    technicalDetails: null,
    retryable: true,
  };
}

/**
 * Executes one internal query and resolves only after its terminal channel event.
 * @param connectionId - Saved connection that owns the operation.
 * @param sql - Engine-native command text sent to the existing query boundary.
 * @param database - Optional Redis database selected for this operation.
 * @returns The complete schema, rows, and affected-row count.
 * Side effects: invokes the backend query command without recording user query history.
 */
export function executeQueryOnce(
  connectionId: string,
  sql: string,
  database: string | null = null,
): Promise<QueryExecutionResult> {
  return new Promise((resolve, reject) => {
    const queryId = crypto.randomUUID();
    const request: QueryRequest = { queryId, connectionId, sql, database };
    const onEvent = new Channel<QueryEvent>();
    let columns: QueryColumn[] = [];
    const rows: CellValue[][] = [];
    let settled = false;

    /**
     * Settles the operation once and ignores any late channel events.
     * @param complete - Terminal resolver or rejecter.
     * @returns Nothing (`void`).
     * Side effects: permanently settles the returned promise.
     */
    function settle(complete: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      complete();
    }

    // Subscribe before invoking so a fast local Redis response cannot race the listener.
    onEvent.onmessage = (event) => {
      if (event.queryId !== queryId || settled) {
        return;
      }
      switch (event.type) {
        case "schema":
          columns = event.columns;
          break;
        case "batch":
          rows.push(...event.rows);
          break;
        case "completed":
          settle(() => resolve({ columns, rows, affectedRows: event.affectedRows }));
          break;
        case "canceled":
          settle(() => reject({
            code: "canceled",
            message: "Redis 操作已取消。",
            technicalDetails: null,
            retryable: true,
          } satisfies AppError));
          break;
        case "failed":
          settle(() => reject(event.error));
          break;
        case "started":
          break;
      }
    };

    void invoke<string>("run_query", { request, onEvent }).catch((error: unknown) => {
      settle(() => reject(toAppError(error)));
    });
  });
}
