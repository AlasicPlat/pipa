//! In-process MCP server, SQL proposal queue, and Tauri command surface.

mod binlog;
mod query_runner;
mod queue;
mod server;
mod service;
mod types;

pub use queue::McpQueue;
pub use server::{
    regenerate_token_and_restart, set_mcp_server_port, start_mcp_server, stop_mcp_server,
    McpServerHandle, SharedMcpServer, DEFAULT_MCP_PORT,
};
pub use service::{shared_connection_scope, McpConnectionScope, McpDeps, SharedMcpConnectionScope};
pub use types::{McpPanelSnapshot, McpStatus, ProposalStatus};

use pipa_core::{AppError, AppErrorCode, ExecutionSource};
use pipa_store::McpSettings;
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;

use self::query_runner::execute_collected;
use self::types::MCP_READONLY_ROW_LIMIT;

/// Returns the current MCP panel snapshot.
#[tauri::command]
pub(crate) async fn mcp_get_snapshot(
    state: State<'_, AppState>,
) -> Result<McpPanelSnapshot, AppError> {
    Ok(build_snapshot(&state).await)
}

/// Starts the MCP HTTP server and persists enabled=true.
#[tauri::command]
pub(crate) async fn mcp_start(state: State<'_, AppState>) -> Result<McpPanelSnapshot, AppError> {
    let scope = state.mcp_connection_scope.read().await.clone();
    validate_connection_scope(&state, &scope)?;
    let port = {
        let guard = state.mcp_server.lock().await;
        guard.port()
    };
    let deps = state.mcp_deps();
    start_mcp_server(state.mcp_server.clone(), deps, port).await?;
    {
        let guard = state.mcp_server.lock().await;
        state.local_store.save_mcp_settings(guard.settings())?;
    }
    let snapshot = build_snapshot(&state).await;
    state.mcp_queue.emit_updated(Some(snapshot.clone())).await;
    Ok(snapshot)
}

/// Updates the optional multi-connection MCP access boundary without restarting the server.
#[tauri::command]
pub(crate) async fn mcp_set_connection_scope(
    state: State<'_, AppState>,
    restrict_to_connection: bool,
    target_connection_ids: Vec<Uuid>,
) -> Result<McpPanelSnapshot, AppError> {
    let target_connection_ids =
        target_connection_ids
            .into_iter()
            .fold(Vec::new(), |mut unique_ids, connection_id| {
                if !unique_ids.contains(&connection_id) {
                    unique_ids.push(connection_id);
                }
                unique_ids
            });
    let scope = McpConnectionScope {
        restrict_to_connection,
        target_connection_ids,
    };
    validate_connection_scope(&state, &scope)?;

    {
        let mut guard = state.mcp_server.lock().await;
        guard.set_connection_scope(restrict_to_connection, scope.target_connection_ids.clone());
        state.local_store.save_mcp_settings(guard.settings())?;
    }
    *state.mcp_connection_scope.write().await = scope;

    let snapshot = build_snapshot(&state).await;
    state.mcp_queue.emit_updated(Some(snapshot.clone())).await;
    Ok(snapshot)
}

/// Stops the MCP HTTP server and persists enabled=false.
#[tauri::command]
pub(crate) async fn mcp_stop(state: State<'_, AppState>) -> Result<McpPanelSnapshot, AppError> {
    stop_mcp_server(state.mcp_server.clone()).await?;
    {
        let guard = state.mcp_server.lock().await;
        state.local_store.save_mcp_settings(guard.settings())?;
    }
    let snapshot = build_snapshot(&state).await;
    state.mcp_queue.emit_updated(Some(snapshot.clone())).await;
    Ok(snapshot)
}

/// Updates the preferred MCP port (applies on next start; restarts if running).
#[tauri::command]
pub(crate) async fn mcp_set_port(
    state: State<'_, AppState>,
    port: u16,
) -> Result<McpPanelSnapshot, AppError> {
    if port == 0 {
        return Err(AppError {
            code: AppErrorCode::Validation,
            message: "MCP port must be between 1 and 65535".into(),
            technical_details: None,
            retryable: false,
        });
    }
    if let Err(error) = set_mcp_server_port(state.mcp_server.clone(), state.mcp_deps(), port).await
    {
        let snapshot = build_snapshot(&state).await;
        state.mcp_queue.emit_updated(Some(snapshot)).await;
        return Err(error);
    }
    {
        let guard = state.mcp_server.lock().await;
        state.local_store.save_mcp_settings(guard.settings())?;
    }
    let snapshot = build_snapshot(&state).await;
    state.mcp_queue.emit_updated(Some(snapshot.clone())).await;
    Ok(snapshot)
}

/// Regenerates the bearer token by restarting the MCP server.
#[tauri::command]
pub(crate) async fn mcp_regenerate_token(
    state: State<'_, AppState>,
) -> Result<McpPanelSnapshot, AppError> {
    let running = state.mcp_server.lock().await.running();
    if running {
        regenerate_token_and_restart(state.mcp_server.clone(), state.mcp_deps()).await?;
    } else {
        return Err(AppError {
            code: AppErrorCode::Validation,
            message: "Start MCP before regenerating the token".into(),
            technical_details: None,
            retryable: false,
        });
    }
    {
        let guard = state.mcp_server.lock().await;
        state.local_store.save_mcp_settings(guard.settings())?;
    }
    let snapshot = build_snapshot(&state).await;
    state.mcp_queue.emit_updated(Some(snapshot.clone())).await;
    Ok(snapshot)
}

/// Executes a pending proposal with UI privileges after user confirmation.
#[tauri::command]
pub(crate) async fn mcp_execute_proposal(
    state: State<'_, AppState>,
    proposal_id: Uuid,
) -> Result<McpPanelSnapshot, AppError> {
    let proposal = state.mcp_queue.claim_for_execute(proposal_id).await?;

    let result = execute_collected(
        state.local_store.clone(),
        state.mysql.clone(),
        proposal.connection_id,
        &proposal.sql,
        ExecutionSource::Ui,
        MCP_READONLY_ROW_LIMIT,
    )
    .await;

    let (ok, detail, db_error) = match result {
        Ok(collected) => {
            let detail = collected.short_detail();
            let db_error = collected.error.clone();
            (db_error.is_none(), detail, db_error)
        }
        Err(error) => (false, error.message.clone(), Some(error.message)),
    };

    let status = if ok {
        ProposalStatus::Executed
    } else {
        ProposalStatus::Failed
    };
    state
        .mcp_queue
        .update_proposal(proposal_id, status, Some(detail.clone()))
        .await;
    state
        .mcp_queue
        .push_activity(
            "proposal_execute",
            Some(proposal.connection_id),
            &proposal.sql,
            ok,
            Some(detail.clone()),
        )
        .await;

    let snapshot = build_snapshot(&state).await;
    state.mcp_queue.emit_updated(Some(snapshot.clone())).await;
    if let Some(message) = db_error {
        return Err(AppError {
            code: AppErrorCode::Internal,
            message,
            technical_details: Some(detail),
            retryable: false,
        });
    }
    Ok(snapshot)
}

/// Dismisses a pending proposal without executing it.
#[tauri::command]
pub(crate) async fn mcp_dismiss_proposal(
    state: State<'_, AppState>,
    proposal_id: Uuid,
) -> Result<McpPanelSnapshot, AppError> {
    let proposal = state.mcp_queue.claim_for_dismiss(proposal_id).await?;
    state
        .mcp_queue
        .push_activity(
            "proposal_dismiss",
            Some(proposal.connection_id),
            &proposal.sql,
            true,
            Some("dismissed by user".into()),
        )
        .await;
    let snapshot = build_snapshot(&state).await;
    state.mcp_queue.emit_updated(Some(snapshot.clone())).await;
    Ok(snapshot)
}

/// Runs arbitrary SQL from the MCP panel manual editor (UI source; not MCP-gated).
#[tauri::command]
pub(crate) async fn mcp_run_manual_sql(
    state: State<'_, AppState>,
    connection_id: Uuid,
    sql: String,
) -> Result<McpPanelSnapshot, AppError> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err(AppError {
            code: AppErrorCode::Validation,
            message: "SQL must not be empty".into(),
            technical_details: None,
            retryable: false,
        });
    }
    let result = execute_collected(
        state.local_store.clone(),
        state.mysql.clone(),
        connection_id,
        trimmed,
        ExecutionSource::Ui,
        MCP_READONLY_ROW_LIMIT,
    )
    .await?;
    let ok = result.error.is_none();
    let detail = result.short_detail();
    state
        .mcp_queue
        .push_activity("manual_sql", Some(connection_id), trimmed, ok, Some(detail))
        .await;
    if let Some(error) = result.error {
        return Err(AppError {
            code: AppErrorCode::Internal,
            message: error,
            technical_details: None,
            retryable: false,
        });
    }
    let snapshot = build_snapshot(&state).await;
    state.mcp_queue.emit_updated(Some(snapshot.clone())).await;
    Ok(snapshot)
}

/// Builds status + queue snapshot for the UI.
pub async fn build_snapshot(state: &AppState) -> McpPanelSnapshot {
    let status = {
        let guard = state.mcp_server.lock().await;
        McpStatus {
            running: guard.running(),
            enabled: guard.settings().enabled,
            port: guard.port(),
            restrict_to_connection: guard.settings().restrict_to_connection,
            target_connection_ids: guard.settings().target_connection_ids.clone(),
            url: guard.url(),
            token: guard.token().map(str::to_owned),
            last_error: guard.last_error().map(str::to_owned),
        }
    };
    state.mcp_queue.snapshot(status).await
}

/// Seeds MCP settings into the server handle at startup.
pub fn initial_mcp_settings(store: &pipa_store::LocalStore) -> McpSettings {
    store.load_mcp_settings().unwrap_or_default()
}

/// Validates a configured MCP target while allowing unrestricted mode without a selection.
fn validate_connection_scope(state: &AppState, scope: &McpConnectionScope) -> Result<(), AppError> {
    if scope.restrict_to_connection && scope.target_connection_ids.is_empty() {
        return Err(AppError {
            code: AppErrorCode::Validation,
            message: "Select at least one connection before enabling MCP connection restriction"
                .into(),
            technical_details: None,
            retryable: false,
        });
    }
    for connection_id in &scope.target_connection_ids {
        state.local_store.get_connection(*connection_id)?;
    }
    Ok(())
}
