import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
  mcpDismissProposal,
  mcpExecuteProposal,
  mcpGetSnapshot,
  mcpRegenerateToken,
  mcpRunManualSql,
  mcpSetConnectionScope,
  mcpSetPort,
  mcpStart,
  mcpStop,
} from "../../lib/tauriClient";
import { EMPTY_MCP_SNAPSHOT, MCP_UPDATED_EVENT, type McpPanelSnapshot } from "./types";

/** Hook state for the MCP console panel. */
export interface UseMcpStateResult {
  snapshot: McpPanelSnapshot;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  setPort: (port: number) => Promise<void>;
  setConnectionScope: (
    restrictToConnection: boolean,
    targetConnectionIds: string[],
  ) => Promise<void>;
  regenerateToken: () => Promise<void>;
  executeProposal: (proposalId: string) => Promise<void>;
  dismissProposal: (proposalId: string) => Promise<void>;
  runManualSql: (connectionId: string, sql: string) => Promise<void>;
}

/**
 * Tracks how many MCP proposals are waiting for confirmation, even while the console is closed.
 *
 * The console's own state hook only subscribes while it is open, so without this
 * the app gives no sign that an agent is blocked waiting for approval.
 * Parameters: none.
 * @returns The number of proposals currently in the `pending` state.
 * Side effects: reads one snapshot and subscribes to MCP updates for the app's lifetime.
 */
export function useMcpPendingApprovals(): number {
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    /** Counts only proposals that still block an agent. */
    function countPending(next: McpPanelSnapshot): number {
      return next.proposals.filter((proposal) => proposal.status === "pending").length;
    }
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      try {
        const next = await mcpGetSnapshot();
        if (!disposed && next?.status) {
          setPendingCount(countPending(next));
        }
      } catch {
        // A failed poll must not surface an error badge; the console reports it.
      }
    })();
    void (async () => {
      try {
        const fn = await listen<McpPanelSnapshot>(MCP_UPDATED_EVENT, (event) => {
          if (event.payload?.status) {
            setPendingCount(countPending(event.payload));
          }
        });
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      } catch {
        // Losing the subscription only costs badge freshness.
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return pendingCount;
}

/**
 * Loads MCP panel state, listens for backend updates, and exposes control actions.
 */
export function useMcpState(enabled: boolean): UseMcpStateResult {
  const [snapshot, setSnapshot] = useState<McpPanelSnapshot>(EMPTY_MCP_SNAPSHOT);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!isTauri()) {
      return;
    }
    setLoading(true);
    try {
      const next = await mcpGetSnapshot();
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      setError(getErrorMessage(cause, "无法加载 MCP 状态"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !isTauri()) {
      return;
    }
    void refresh();
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<McpPanelSnapshot>(MCP_UPDATED_EVENT, (event) => {
      if (event.payload?.status) {
        setSnapshot(event.payload);
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    }).catch((cause) => {
      if (!disposed) {
        setError(getErrorMessage(cause, "无法监听 MCP 状态更新"));
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, refresh]);

  const runAction = useCallback(
    async (action: () => Promise<McpPanelSnapshot>, fallback: string): Promise<void> => {
      setBusy(true);
      try {
        const next = await action();
        setSnapshot(next);
        setError(null);
      } catch (cause) {
        setError(getErrorMessage(cause, fallback));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return {
    snapshot,
    loading,
    busy,
    error,
    refresh,
    start: () => runAction(mcpStart, "无法启动 MCP"),
    stop: () => runAction(mcpStop, "无法停止 MCP"),
    setPort: (port) => runAction(() => mcpSetPort(port), "无法更新 MCP 端口"),
    setConnectionScope: (restrictToConnection, targetConnectionIds) =>
      runAction(
        () => mcpSetConnectionScope(restrictToConnection, targetConnectionIds),
        "无法更新 MCP 连接范围",
      ),
    regenerateToken: () => runAction(mcpRegenerateToken, "无法重新生成 Token"),
    executeProposal: (proposalId) =>
      runAction(() => mcpExecuteProposal(proposalId), "无法执行待确认 SQL"),
    dismissProposal: (proposalId) =>
      runAction(() => mcpDismissProposal(proposalId), "无法忽略待确认 SQL"),
    runManualSql: (connectionId, sql) =>
      runAction(() => mcpRunManualSql(connectionId, sql), "手动 SQL 执行失败"),
  };
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return fallback;
}
