//! In-memory MCP proposal queue and activity log with UI event fan-out.

use chrono::Utc;
use pipa_core::{AppError, AppErrorCode, SqlRisk};
use std::{collections::VecDeque, sync::Arc};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::types::{
    McpActivityEntry, McpPanelSnapshot, McpStatus, PendingSqlProposal, ProposalStatus,
    MCP_ACTIVITY_LIMIT, MCP_PROPOSAL_LIMIT, MCP_UPDATED_EVENT,
};

/// Shared mutable MCP panel state.
#[derive(Clone, Default)]
pub struct McpQueue {
    proposals: Arc<Mutex<VecDeque<PendingSqlProposal>>>,
    activity: Arc<Mutex<VecDeque<McpActivityEntry>>>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
    last_status: Arc<Mutex<Option<McpStatus>>>,
}

impl McpQueue {
    /// Creates an empty queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// Stores the Tauri app handle used to emit panel update events.
    pub async fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.lock().await = Some(handle);
    }

    /// Enqueues a new pending SQL proposal and logs activity.
    ///
    /// Terminal proposals are evicted first when over the history limit. Pending proposals are
    /// never dropped; if the queue cannot accept another pending item, this returns an error.
    pub async fn propose(
        &self,
        connection_id: Uuid,
        sql: String,
        risk: SqlRisk,
        source_tool: &str,
    ) -> Result<PendingSqlProposal, AppError> {
        let proposal = PendingSqlProposal {
            id: Uuid::new_v4(),
            connection_id,
            sql: sql.clone(),
            risk,
            source_tool: source_tool.to_owned(),
            created_at: Utc::now(),
            status: ProposalStatus::Pending,
            result_summary: None,
        };
        {
            let mut proposals = self.proposals.lock().await;
            proposals.push_front(proposal.clone());
            trim_terminal_proposals(&mut proposals);
            if proposals.len() > MCP_PROPOSAL_LIMIT {
                proposals.pop_front();
                return Err(AppError {
                    code: AppErrorCode::Validation,
                    message: "MCP proposal queue is full of pending items; confirm or dismiss existing SQL first".into(),
                    technical_details: Some(format!("limit={MCP_PROPOSAL_LIMIT}")),
                    retryable: true,
                });
            }
        }
        let summary = truncate_sql(&sql);
        self.push_activity(
            proposal.source_tool.as_str(),
            Some(connection_id),
            &summary,
            true,
            Some(format!("proposal_id={} risk={risk:?}", proposal.id)),
        )
        .await;
        Ok(proposal)
    }

    /// Atomically claims a pending proposal for execution.
    pub async fn claim_for_execute(
        &self,
        proposal_id: Uuid,
    ) -> Result<PendingSqlProposal, AppError> {
        let mut proposals = self.proposals.lock().await;
        let proposal = proposals
            .iter_mut()
            .find(|item| item.id == proposal_id)
            .ok_or_else(|| AppError {
                code: AppErrorCode::NotFound,
                message: "MCP proposal was not found".into(),
                technical_details: None,
                retryable: false,
            })?;
        if !proposal.status.is_pending() {
            return Err(AppError {
                code: AppErrorCode::Validation,
                message: "Only pending proposals can be executed".into(),
                technical_details: Some(format!("status={:?}", proposal.status)),
                retryable: false,
            });
        }
        proposal.status = ProposalStatus::Executing;
        Ok(proposal.clone())
    }

    /// Atomically claims a pending proposal for dismissal.
    pub async fn claim_for_dismiss(
        &self,
        proposal_id: Uuid,
    ) -> Result<PendingSqlProposal, AppError> {
        let mut proposals = self.proposals.lock().await;
        let proposal = proposals
            .iter_mut()
            .find(|item| item.id == proposal_id)
            .ok_or_else(|| AppError {
                code: AppErrorCode::NotFound,
                message: "MCP proposal was not found".into(),
                technical_details: None,
                retryable: false,
            })?;
        if !proposal.status.is_pending() {
            return Err(AppError {
                code: AppErrorCode::Validation,
                message: "Only pending proposals can be dismissed".into(),
                technical_details: Some(format!("status={:?}", proposal.status)),
                retryable: false,
            });
        }
        proposal.status = ProposalStatus::Dismissed;
        proposal.result_summary = Some("dismissed".into());
        Ok(proposal.clone())
    }

    /// Updates a proposal status and optional result summary.
    pub async fn update_proposal(
        &self,
        proposal_id: Uuid,
        status: ProposalStatus,
        result_summary: Option<String>,
    ) -> Option<PendingSqlProposal> {
        let mut proposals = self.proposals.lock().await;
        let proposal = proposals.iter_mut().find(|item| item.id == proposal_id)?;
        proposal.status = status;
        proposal.result_summary = result_summary;
        Some(proposal.clone())
    }

    /// Appends an activity entry and emits a panel update when possible.
    pub async fn push_activity(
        &self,
        tool: &str,
        connection_id: Option<Uuid>,
        summary: &str,
        ok: bool,
        detail: Option<String>,
    ) {
        let entry = McpActivityEntry {
            id: Uuid::new_v4(),
            created_at: Utc::now(),
            tool: tool.to_owned(),
            connection_id,
            summary: summary.to_owned(),
            ok,
            detail,
        };
        {
            let mut activity = self.activity.lock().await;
            activity.push_front(entry);
            while activity.len() > MCP_ACTIVITY_LIMIT {
                activity.pop_back();
            }
        }
        self.emit_updated(None).await;
    }

    /// Builds a panel snapshot for the given server status.
    pub async fn snapshot(&self, status: McpStatus) -> McpPanelSnapshot {
        *self.last_status.lock().await = Some(status.clone());
        McpPanelSnapshot {
            status,
            proposals: self.proposals.lock().await.iter().cloned().collect(),
            activity: self.activity.lock().await.iter().cloned().collect(),
        }
    }

    /// Emits `pipa://mcp-updated` with an optional prebuilt snapshot.
    pub async fn emit_updated(&self, snapshot: Option<McpPanelSnapshot>) {
        let handle = self.app_handle.lock().await.clone();
        let Some(handle) = handle else {
            return;
        };
        let payload = match snapshot {
            Some(snapshot) => {
                *self.last_status.lock().await = Some(snapshot.status.clone());
                snapshot
            }
            None => {
                let status = self.last_status.lock().await.clone().unwrap_or(McpStatus {
                    running: false,
                    enabled: false,
                    port: 3847,
                    restrict_to_connection: false,
                    target_connection_id: None,
                    url: None,
                    token: None,
                    last_error: None,
                });
                McpPanelSnapshot {
                    status,
                    proposals: self.proposals.lock().await.iter().cloned().collect(),
                    activity: self.activity.lock().await.iter().cloned().collect(),
                }
            }
        };
        let _ = handle.emit(MCP_UPDATED_EVENT, payload);
    }
}

/// Drops oldest terminal proposals until the deque fits under the history limit.
fn trim_terminal_proposals(proposals: &mut VecDeque<PendingSqlProposal>) {
    while proposals.len() > MCP_PROPOSAL_LIMIT {
        let Some(index) = proposals.iter().rposition(|item| item.status.is_terminal()) else {
            break;
        };
        proposals.remove(index);
    }
}

fn truncate_sql(sql: &str) -> String {
    const MAX: usize = 160;
    let trimmed = sql.trim();
    if trimmed.chars().count() <= MAX {
        return trimmed.to_owned();
    }
    let truncated: String = trimmed.chars().take(MAX).collect();
    format!("{truncated}…")
}
