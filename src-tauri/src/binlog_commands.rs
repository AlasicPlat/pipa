use crate::state::AppState;
use chrono::{SecondsFormat, Utc};
use pipa_binlog::{
    analyze_files, generate_transaction_reset_sql, initial_summary, inspect_files,
    AnalysisRepository, BinlogAnalysisOutput, BinlogImportFailure, BinlogImportTerminal,
    BinlogProgress, RepositoryError,
};
use pipa_core::{
    AppError, AppErrorCode, BinlogAnalysisStatus, BinlogDiagnostic, BinlogDiagnosticSeverity,
    BinlogImportEvent, BinlogOperation, BinlogResetSql, BinlogSummary, BinlogTransaction,
    BinlogTransactionFilter, BinlogTransactionPage,
};
use std::{collections::HashMap, sync::Arc};
use tauri::{ipc::Channel, State};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const BINLOG_PROGRESS_CHANNEL_CAPACITY: usize = 8;

/// Owned dependencies for one background binlog import.
struct BinlogImportTask {
    analysis_id: Uuid,
    files: Vec<pipa_core::BinlogFileSummary>,
    started_at: String,
    initial_summary: BinlogSummary,
    cancellation: CancellationToken,
    repository: Arc<pipa_binlog::InMemoryAnalysisRepository>,
    cancellations: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
    on_event: Channel<BinlogImportEvent>,
}

/// Starts one ordered offline binlog import and returns its stable analysis identifier.
///
/// # Side effects
/// Captures file metadata, registers an ephemeral session, and starts a background parser.
#[tauri::command]
pub(crate) async fn binlog_start_import(
    state: State<'_, AppState>,
    paths: Vec<String>,
    on_event: Channel<BinlogImportEvent>,
) -> Result<Uuid, AppError> {
    binlog_start_import_inner(&state, paths, on_event).await
}

/// Signals cancellation for a running binlog import.
#[tauri::command]
pub(crate) async fn binlog_cancel_import(
    state: State<'_, AppState>,
    analysis_id: Uuid,
) -> Result<(), AppError> {
    binlog_cancel_import_inner(&state, analysis_id).await
}

/// Returns the current or terminal summary for one open analysis.
#[tauri::command]
pub(crate) fn binlog_get_summary(
    state: State<'_, AppState>,
    analysis_id: Uuid,
) -> Result<BinlogSummary, AppError> {
    state
        .binlog_analyses
        .get_summary(analysis_id)
        .map_err(repository_error)
}

/// Returns one exact-filtered cursor page without crossing the full transaction set over IPC.
#[tauri::command]
pub(crate) fn binlog_list_transactions(
    state: State<'_, AppState>,
    analysis_id: Uuid,
    filter: BinlogTransactionFilter,
) -> Result<BinlogTransactionPage, AppError> {
    state
        .binlog_analyses
        .list_transactions(analysis_id, filter)
        .map_err(repository_error)
}

/// Returns one full transaction only after the user expands its timeline summary.
#[tauri::command]
pub(crate) fn binlog_get_transaction(
    state: State<'_, AppState>,
    analysis_id: Uuid,
    sequence: u64,
    database: Option<String>,
    table: Option<String>,
    operation: Option<BinlogOperation>,
) -> Result<BinlogTransaction, AppError> {
    state
        .binlog_analyses
        .get_transaction(
            analysis_id,
            sequence,
            BinlogTransactionFilter {
                database,
                table,
                operation,
                cursor: None,
                limit: None,
            },
        )
        .map_err(repository_error)
}

/// Generates reviewable Reset SQL for one transaction projected through the active timeline filter.
#[tauri::command]
pub(crate) fn binlog_get_reset_sql(
    state: State<'_, AppState>,
    analysis_id: Uuid,
    sequence: u64,
    database: Option<String>,
    table: Option<String>,
    operation: Option<BinlogOperation>,
) -> Result<BinlogResetSql, AppError> {
    let transaction = state
        .binlog_analyses
        .get_transaction(
            analysis_id,
            sequence,
            BinlogTransactionFilter {
                database,
                table,
                operation,
                cursor: None,
                limit: None,
            },
        )
        .map_err(repository_error)?;
    Ok(generate_transaction_reset_sql(&transaction))
}

/// Cancels any live task and releases all values retained by one analysis.
#[tauri::command]
pub(crate) async fn binlog_close_analysis(
    state: State<'_, AppState>,
    analysis_id: Uuid,
) -> Result<(), AppError> {
    if let Some(cancellation) = state.binlog_cancellations.lock().await.remove(&analysis_id) {
        cancellation.cancel();
    }
    state
        .binlog_analyses
        .close(analysis_id)
        .map_err(repository_error)
}

/// Performs preflight, registration, and bounded event forwarding before returning immediately.
async fn binlog_start_import_inner(
    state: &AppState,
    paths: Vec<String>,
    on_event: Channel<BinlogImportEvent>,
) -> Result<Uuid, AppError> {
    let files = inspect_files(&paths).map_err(import_validation_error)?;
    let analysis_id = Uuid::new_v4();
    let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let summary = initial_summary(analysis_id, files.clone(), started_at.clone());
    state
        .binlog_analyses
        .create(summary.clone())
        .map_err(repository_error)?;

    let cancellation = CancellationToken::new();
    state
        .binlog_cancellations
        .lock()
        .await
        .insert(analysis_id, cancellation.clone());
    let total_bytes = files.iter().map(|file| file.size_bytes).sum();
    if let Err(error) = on_event.send(BinlogImportEvent::Started {
        analysis_id,
        file_count: files.len() as u32,
        total_bytes,
    }) {
        state.binlog_cancellations.lock().await.remove(&analysis_id);
        state
            .binlog_analyses
            .close(analysis_id)
            .map_err(repository_error)?;
        return Err(AppError {
            code: AppErrorCode::Internal,
            message: "Could not start binlog event streaming".into(),
            technical_details: Some(error.to_string()),
            retryable: true,
        });
    }

    tokio::spawn(run_binlog_import(BinlogImportTask {
        analysis_id,
        files,
        started_at,
        initial_summary: summary,
        cancellation,
        repository: state.binlog_analyses.clone(),
        cancellations: state.binlog_cancellations.clone(),
        on_event,
    }));
    Ok(analysis_id)
}

/// Runs blocking parsing, forwards bounded progress, stores output, and emits one terminal event.
async fn run_binlog_import(task: BinlogImportTask) {
    let BinlogImportTask {
        analysis_id,
        files,
        started_at,
        initial_summary,
        cancellation,
        repository,
        cancellations,
        on_event,
    } = task;
    let (progress_sender, mut progress_receiver) = mpsc::channel(BINLOG_PROGRESS_CHANNEL_CAPACITY);
    let progress_channel = on_event.clone();
    let progress_cancellation = cancellation.clone();
    let progress_forwarder = tokio::spawn(async move {
        while let Some(progress) = progress_receiver.recv().await {
            if progress_channel
                .send(progress_event(analysis_id, progress))
                .is_err()
            {
                progress_cancellation.cancel();
                break;
            }
        }
    });

    let parser_cancellation = cancellation.clone();
    let output = tokio::task::spawn_blocking(move || {
        analyze_files(
            analysis_id,
            files,
            started_at,
            &parser_cancellation,
            |progress| {
                if progress_sender.blocking_send(progress).is_err() {
                    parser_cancellation.cancel();
                }
            },
        )
    })
    .await;
    let _forward_result = progress_forwarder.await;

    let output = match output {
        Ok(output) => output,
        Err(error) => parser_join_failure(initial_summary, error.to_string()),
    };
    let terminal = output.terminal.clone();
    let stored = repository.replace(output.summary, output.transactions);
    cancellations.lock().await.remove(&analysis_id);
    if matches!(stored, Err(RepositoryError::NotFound)) {
        return;
    }
    if let Err(error) = stored {
        let _send_result = on_event.send(BinlogImportEvent::Failed {
            analysis_id,
            error: repository_error(error),
        });
        return;
    }
    let _send_result = on_event.send(terminal_event(analysis_id, terminal));
}

/// Signals one registered import without removing its terminal cleanup state.
async fn binlog_cancel_import_inner(state: &AppState, analysis_id: Uuid) -> Result<(), AppError> {
    let cancellations = state.binlog_cancellations.lock().await;
    let cancellation = cancellations.get(&analysis_id).ok_or_else(|| AppError {
        code: AppErrorCode::NotFound,
        message: "Running binlog import was not found".into(),
        technical_details: None,
        retryable: false,
    })?;
    cancellation.cancel();
    Ok(())
}

/// Converts an internal progress snapshot to the stable channel contract.
fn progress_event(analysis_id: Uuid, progress: BinlogProgress) -> BinlogImportEvent {
    BinlogImportEvent::Progress {
        analysis_id,
        bytes_read: progress.bytes_read,
        total_bytes: progress.total_bytes,
        file_count: progress.file_count,
        files_completed: progress.files_completed,
        current_file: progress.current_file,
        transaction_count: progress.transaction_count,
        event_count: progress.event_count,
    }
}

/// Converts a parser terminal outcome to exactly one lifecycle event.
fn terminal_event(analysis_id: Uuid, terminal: BinlogImportTerminal) -> BinlogImportEvent {
    match terminal {
        BinlogImportTerminal::Completed => BinlogImportEvent::Completed { analysis_id },
        BinlogImportTerminal::Canceled => BinlogImportEvent::Canceled { analysis_id },
        BinlogImportTerminal::Failed(error) => BinlogImportEvent::Failed {
            analysis_id,
            error: import_error(error, AppErrorCode::Query),
        },
    }
}

/// Produces a partial stored analysis when the background blocking task itself panics.
fn parser_join_failure(
    mut summary: BinlogSummary,
    technical_details: String,
) -> BinlogAnalysisOutput {
    let failure = BinlogImportFailure {
        code: "parser_task_failed".into(),
        message: "The binlog parser stopped unexpectedly".into(),
        technical_details: Some(technical_details),
        retryable: false,
        diagnostic: Box::new(BinlogDiagnostic {
            code: "parser_task_failed".into(),
            message: "The binlog parser stopped unexpectedly".into(),
            severity: BinlogDiagnosticSeverity::Error,
            file_name: None,
            position: None,
        }),
    };
    summary.status = BinlogAnalysisStatus::Error;
    summary.ended_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    summary
        .diagnostics
        .push(failure.diagnostic.as_ref().clone());
    BinlogAnalysisOutput {
        summary,
        transactions: Vec::new(),
        terminal: BinlogImportTerminal::Failed(failure),
    }
}

/// Maps preflight failures to validation errors before a session is registered.
fn import_validation_error(error: BinlogImportFailure) -> AppError {
    import_error(error, AppErrorCode::Validation)
}

/// Maps a parser failure to a redacted application error with optional file coordinates.
fn import_error(error: BinlogImportFailure, code: AppErrorCode) -> AppError {
    let coordinate =
        error
            .diagnostic
            .file_name
            .as_deref()
            .map(|file_name| match error.diagnostic.position {
                Some(position) => format!("{file_name} at byte {position}"),
                None => file_name.to_owned(),
            });
    let technical_details = match (coordinate, error.technical_details) {
        (Some(coordinate), Some(details)) => Some(format!("{coordinate}: {details}")),
        (Some(coordinate), None) => Some(coordinate),
        (None, details) => details,
    };
    AppError {
        code,
        message: error.message,
        technical_details,
        retryable: error.retryable,
    }
}

/// Maps repository failures to stable application categories.
fn repository_error(error: RepositoryError) -> AppError {
    let code = match error {
        RepositoryError::NotFound => AppErrorCode::NotFound,
        RepositoryError::InvalidCursor => AppErrorCode::Validation,
        RepositoryError::AlreadyExists | RepositoryError::Unavailable => AppErrorCode::Internal,
    };
    AppError {
        code,
        message: error.to_string(),
        technical_details: None,
        retryable: matches!(error, RepositoryError::Unavailable),
    }
}

#[cfg(test)]
mod tests {
    use super::{import_error, progress_event, repository_error, terminal_event};
    use pipa_binlog::{BinlogImportFailure, BinlogImportTerminal, BinlogProgress, RepositoryError};
    use pipa_core::{AppErrorCode, BinlogDiagnostic, BinlogDiagnosticSeverity, BinlogImportEvent};
    use uuid::Uuid;

    /// Verifies bounded parser progress maps every frontend-required field.
    #[test]
    fn progress_mapping_keeps_all_contract_fields() {
        let analysis_id = Uuid::nil();
        let event = progress_event(
            analysis_id,
            BinlogProgress {
                bytes_read: 11,
                total_bytes: 22,
                file_count: 3,
                files_completed: 1,
                current_file: Some("mysql-bin.000002".into()),
                transaction_count: 4,
                event_count: 8,
            },
        );

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "type": "progress",
                "analysisId": analysis_id,
                "bytesRead": 11,
                "totalBytes": 22,
                "fileCount": 3,
                "filesCompleted": 1,
                "currentFile": "mysql-bin.000002",
                "transactionCount": 4,
                "eventCount": 8
            })
        );
    }

    /// Verifies terminal parser failures retain safe coordinates and never row values.
    #[test]
    fn failure_mapping_is_located_and_redacted() {
        let analysis_id = Uuid::nil();
        let failure = BinlogImportFailure {
            code: "checksum_mismatch".into(),
            message: "A binlog event failed CRC32 verification".into(),
            technical_details: Some("expected 00000000, calculated 11111111".into()),
            retryable: false,
            diagnostic: Box::new(BinlogDiagnostic {
                code: "checksum_mismatch".into(),
                message: "A binlog event failed CRC32 verification".into(),
                severity: BinlogDiagnosticSeverity::Error,
                file_name: Some("mysql-bin.000001".into()),
                position: Some(120),
            }),
        };
        let event = terminal_event(analysis_id, BinlogImportTerminal::Failed(failure));

        let BinlogImportEvent::Failed { error, .. } = event else {
            panic!("expected failed event");
        };
        assert!(matches!(error.code, AppErrorCode::Query));
        assert!(error
            .technical_details
            .as_deref()
            .unwrap()
            .contains("mysql-bin.000001 at byte 120"));
    }

    /// Verifies repository cursor errors remain validation failures.
    #[test]
    fn invalid_cursor_maps_to_validation_error() {
        let error = repository_error(RepositoryError::InvalidCursor);

        assert!(matches!(error.code, AppErrorCode::Validation));
        assert!(!error.retryable);
    }

    /// Verifies preflight conversion does not accidentally expose diagnostic internals in display.
    #[test]
    fn import_error_display_remains_safe() {
        let failure = BinlogImportFailure {
            code: "invalid_file_header".into(),
            message: "The selected file is not a supported MySQL binlog v4 file".into(),
            technical_details: Some("invalid binlog file header".into()),
            retryable: false,
            diagnostic: Box::new(BinlogDiagnostic {
                code: "invalid_file_header".into(),
                message: "The selected file is not a supported MySQL binlog v4 file".into(),
                severity: BinlogDiagnosticSeverity::Error,
                file_name: Some("input.bin".into()),
                position: Some(0),
            }),
        };

        let error = import_error(failure, AppErrorCode::Validation);

        assert_eq!(
            error.to_string(),
            "The selected file is not a supported MySQL binlog v4 file"
        );
        assert!(!error.to_string().contains("invalid binlog file header"));
    }
}
