//! Shared MCP domain types exposed to the desktop UI over Tauri IPC.

use chrono::{DateTime, Utc};
use pipa_core::SqlRisk;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Lifecycle status of a write/DDL SQL proposal awaiting user confirmation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    /// Waiting for the user in the MCP panel.
    Pending,
    /// Claimed for execution; prevents concurrent confirmations.
    Executing,
    /// User confirmed and execution finished successfully.
    Executed,
    /// User dismissed the proposal without running it.
    Dismissed,
    /// User confirmed but execution failed.
    Failed,
}

impl ProposalStatus {
    /// Returns whether the proposal is still awaiting user action.
    pub fn is_pending(self) -> bool {
        matches!(self, Self::Pending)
    }

    /// Returns whether the proposal may be dropped when the history limit is hit.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Executed | Self::Dismissed | Self::Failed)
    }
}

/// A SQL statement proposed by MCP that requires explicit user confirmation.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSqlProposal {
    /// Stable proposal identifier.
    pub id: Uuid,
    /// Target connection for the statement.
    pub connection_id: Uuid,
    /// Exact SQL text proposed by the MCP client.
    pub sql: String,
    /// Classified risk of the SQL.
    pub risk: SqlRisk,
    /// MCP tool that created the proposal.
    pub source_tool: String,
    /// Creation timestamp (UTC).
    pub created_at: DateTime<Utc>,
    /// Current lifecycle status.
    pub status: ProposalStatus,
    /// Optional short result or error summary after execute/dismiss.
    pub result_summary: Option<String>,
}

/// One MCP activity log entry shown in the panel.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpActivityEntry {
    /// Stable activity identifier.
    pub id: Uuid,
    /// UTC timestamp.
    pub created_at: DateTime<Utc>,
    /// Tool name (or `manual` / `proposal_execute`).
    pub tool: String,
    /// Optional connection identifier.
    pub connection_id: Option<Uuid>,
    /// Truncated SQL or action summary.
    pub summary: String,
    /// Whether the activity succeeded.
    pub ok: bool,
    /// Short detail / error text.
    pub detail: Option<String>,
}

/// Snapshot of MCP server runtime status for the UI.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// Whether the HTTP listener is currently running.
    pub running: bool,
    /// Whether MCP should auto-start on application launch.
    pub enabled: bool,
    /// Configured loopback port.
    pub port: u16,
    /// Whether MCP tools are restricted to selected saved connections.
    pub restrict_to_connection: bool,
    /// Saved connections selected as MCP targets.
    pub target_connection_ids: Vec<Uuid>,
    /// Full MCP endpoint URL when running.
    pub url: Option<String>,
    /// Current bearer token (memory-only; regenerates on start).
    pub token: Option<String>,
    /// Last start/stop error message, if any.
    pub last_error: Option<String>,
}

/// Combined panel snapshot pushed to the frontend.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPanelSnapshot {
    /// Server status.
    pub status: McpStatus,
    /// Pending (and recent) proposals newest-first.
    pub proposals: Vec<PendingSqlProposal>,
    /// Recent activity newest-first.
    pub activity: Vec<McpActivityEntry>,
}

/// Event name emitted whenever MCP panel state changes.
pub const MCP_UPDATED_EVENT: &str = "pipa://mcp-updated";

/// Maximum rows returned by MCP readonly query tools.
pub const MCP_READONLY_ROW_LIMIT: usize = 200;

/// Maximum activity log entries retained in memory.
pub const MCP_ACTIVITY_LIMIT: usize = 200;

/// Maximum proposals retained in memory (including resolved).
pub const MCP_PROPOSAL_LIMIT: usize = 100;
