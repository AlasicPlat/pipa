import type { SqlRisk } from "../../bindings/SqlRisk";

/** Lifecycle status of a write/DDL SQL proposal awaiting user confirmation. */
export type ProposalStatus = "pending" | "executing" | "executed" | "dismissed" | "failed";

/** A SQL statement proposed by MCP that requires explicit user confirmation. */
export interface PendingSqlProposal {
  id: string;
  connectionId: string;
  sql: string;
  risk: SqlRisk;
  sourceTool: string;
  createdAt: string;
  status: ProposalStatus;
  resultSummary: string | null;
}

/** One MCP activity log entry shown in the panel. */
export interface McpActivityEntry {
  id: string;
  createdAt: string;
  tool: string;
  connectionId: string | null;
  summary: string;
  ok: boolean;
  detail: string | null;
}

/** Snapshot of MCP server runtime status for the UI. */
export interface McpStatus {
  running: boolean;
  enabled: boolean;
  port: number;
  restrictToConnection: boolean;
  targetConnectionIds: string[];
  url: string | null;
  token: string | null;
  lastError: string | null;
}

/** Combined panel snapshot pushed to the frontend. */
export interface McpPanelSnapshot {
  status: McpStatus;
  proposals: PendingSqlProposal[];
  activity: McpActivityEntry[];
}

/** Event name emitted whenever MCP panel state changes. */
export const MCP_UPDATED_EVENT = "pipa://mcp-updated";

/** Empty snapshot used before the first backend load. */
export const EMPTY_MCP_SNAPSHOT: McpPanelSnapshot = {
  status: {
    running: false,
    enabled: false,
    port: 3847,
    restrictToConnection: false,
    targetConnectionIds: [],
    url: null,
    token: null,
    lastError: null,
  },
  proposals: [],
  activity: [],
};
