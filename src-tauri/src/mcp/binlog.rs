//! MCP-facing Binlog import lifecycle and read-only analysis tools.

use super::service::McpDeps;
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine as _,
};
use chrono::{SecondsFormat, Utc};
use pipa_binlog::{
    analyze_files, generate_transaction_reset_sql, initial_summary, inspect_files,
    AnalysisRepository, BinlogAnalysisOutput, BinlogImportFailure, BinlogImportTerminal,
    RepositoryError,
};
use pipa_core::{
    AppError, AppErrorCode, BinlogAnalysisStatus, BinlogDiagnostic, BinlogDiagnosticSeverity,
    BinlogFileSummary, BinlogOperation, BinlogSummary, BinlogTransactionFilter,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, fs::OpenOptions, io::Write, path::Path};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const MAX_MCP_BINLOG_UPLOAD_FILES: usize = 32;
const MAX_MCP_BINLOG_LOCAL_FILES: usize = 256;
const MAX_MCP_BINLOG_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_MCP_BINLOG_ENCODED_BYTES: usize = MAX_MCP_BINLOG_UPLOAD_BYTES.div_ceil(3) * 4;

/// HTTP body ceiling covering the maximum Base64 payload plus MCP/JSON overhead.
pub(super) const MCP_MAX_REQUEST_BYTES: usize = 96 * 1024 * 1024;

/// One Binlog file uploaded inline through an MCP JSON tool call.
#[derive(Deserialize, JsonSchema)]
pub(super) struct UploadedBinlogFile {
    /// Basename retained for parser diagnostics; directory components are rejected.
    #[schemars(
        description = "Safe filename such as mysql-bin.000001; paths are not accepted here"
    )]
    pub name: String,
    /// Raw file bytes encoded with standard padded or unpadded Base64.
    #[schemars(description = "Raw Binlog bytes encoded as standard Base64")]
    pub content_base64: String,
}

/// Starts an asynchronous multi-file Binlog import from exactly one source mode.
#[derive(Deserialize, JsonSchema)]
pub(super) struct BinlogImportArgs {
    /// Absolute paths on the Pipa host, recommended for files larger than the upload limit.
    #[serde(default)]
    #[schemars(
        description = "Ordered local Binlog paths on the Pipa host; do not combine with files"
    )]
    pub file_paths: Vec<String>,
    /// Ordered inline uploads with a combined decoded limit of 64 MiB.
    #[serde(default)]
    #[schemars(description = "Ordered Base64 Binlog uploads; do not combine with file_paths")]
    pub files: Vec<UploadedBinlogFile>,
}

/// Selects one existing Binlog analysis.
#[derive(Deserialize, JsonSchema)]
pub(super) struct BinlogSummaryArgs {
    /// Analysis UUID returned by `binlog_import`.
    #[schemars(description = "Binlog analysis UUID returned by binlog_import")]
    pub analysis_id: String,
}

/// Selects one filtered cursor page from a Binlog analysis.
#[derive(Deserialize, JsonSchema)]
pub(super) struct BinlogTransactionsArgs {
    /// Analysis UUID returned by `binlog_import`.
    pub analysis_id: String,
    /// Exact database filter.
    pub database: Option<String>,
    /// Exact table filter.
    pub table: Option<String>,
    /// One of insert, update, delete, or ddl.
    pub operation: Option<String>,
    /// Opaque cursor returned by the preceding page.
    pub cursor: Option<String>,
    /// Requested page size; the repository clamps it to 1–500.
    pub limit: Option<u32>,
}

/// Selects one transaction and its optional row-change projection.
#[derive(Deserialize, JsonSchema)]
pub(super) struct BinlogTransactionArgs {
    /// Analysis UUID returned by `binlog_import`.
    pub analysis_id: String,
    /// Stable one-based sequence returned by `binlog_list_transactions`.
    pub sequence: u64,
    /// Exact database filter.
    pub database: Option<String>,
    /// Exact table filter.
    pub table: Option<String>,
    /// One of insert, update, delete, or ddl.
    pub operation: Option<String>,
}

/// Selects one transaction whose inverse SQL should be generated but never executed.
pub(super) type BinlogResetSqlArgs = BinlogTransactionArgs;

/// Closes one Binlog analysis and cancels an import if it is still active.
pub(super) type BinlogCloseArgs = BinlogSummaryArgs;

/// Prepared source files plus ownership of any temporary upload directory.
struct PreparedSources {
    files: Vec<BinlogFileSummary>,
    upload_directory: Option<TempDir>,
}

/// Owned dependencies retained by one background MCP Binlog parser task.
struct McpBinlogImportTask {
    analysis_id: Uuid,
    prepared: PreparedSources,
    started_at: String,
    initial_summary: BinlogSummary,
    cancellation: CancellationToken,
    repository: std::sync::Arc<pipa_binlog::InMemoryAnalysisRepository>,
    cancellations:
        std::sync::Arc<tokio::sync::Mutex<std::collections::HashMap<Uuid, CancellationToken>>>,
    queue: super::queue::McpQueue,
}

/// Starts one shared asynchronous analysis and returns its identifier immediately.
pub(super) async fn start_import(
    deps: &McpDeps,
    args: BinlogImportArgs,
) -> Result<Value, AppError> {
    let prepared = tokio::task::spawn_blocking(move || prepare_sources(args))
        .await
        .map_err(|_| internal_error("The Binlog upload preparation task stopped unexpectedly"))??;
    let analysis_id = Uuid::new_v4();
    let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let summary = initial_summary(analysis_id, prepared.files.clone(), started_at.clone());
    deps.binlog_analyses
        .create(summary.clone())
        .map_err(repository_error)?;

    let cancellation = CancellationToken::new();
    deps.binlog_cancellations
        .lock()
        .await
        .insert(analysis_id, cancellation.clone());
    let total_bytes = prepared
        .files
        .iter()
        .map(|file| file.size_bytes)
        .sum::<u64>();
    let file_names = prepared
        .files
        .iter()
        .map(|file| file_basename(&file.path))
        .collect::<Vec<_>>();
    let repository = deps.binlog_analyses.clone();
    let cancellations = deps.binlog_cancellations.clone();
    let queue = deps.queue.clone();
    tokio::spawn(run_import(McpBinlogImportTask {
        analysis_id,
        prepared,
        started_at,
        initial_summary: summary,
        cancellation,
        repository,
        cancellations,
        queue,
    }));

    Ok(json!({
        "analysisId": analysis_id,
        "state": "importing",
        "fileCount": file_names.len(),
        "fileNames": file_names,
        "totalBytes": total_bytes,
    }))
}

/// Returns a path-redacted summary and an explicit asynchronous lifecycle state.
pub(super) fn get_summary(deps: &McpDeps, args: BinlogSummaryArgs) -> Result<Value, AppError> {
    let analysis_id = parse_analysis_id(&args.analysis_id)?;
    let summary = deps
        .binlog_analyses
        .get_summary(analysis_id)
        .map_err(repository_error)?;
    let state = summary_state(&summary);
    let summary = redact_summary_paths(summary);
    Ok(json!({ "state": state, "summary": summary }))
}

/// Returns one bounded transaction-summary page without eagerly serializing row values.
pub(super) fn list_transactions(
    deps: &McpDeps,
    args: BinlogTransactionsArgs,
) -> Result<Value, AppError> {
    let analysis_id = parse_analysis_id(&args.analysis_id)?;
    let filter = BinlogTransactionFilter {
        database: normalized_filter(args.database),
        table: normalized_filter(args.table),
        operation: parse_operation(args.operation)?,
        cursor: normalized_filter(args.cursor),
        limit: args.limit,
    };
    let page = deps
        .binlog_analyses
        .list_transactions(analysis_id, filter)
        .map_err(repository_error)?;
    to_json_value(page)
}

/// Returns one transaction with decoded row images projected through exact filters.
pub(super) fn get_transaction(
    deps: &McpDeps,
    args: BinlogTransactionArgs,
) -> Result<Value, AppError> {
    let (analysis_id, sequence, filter) = transaction_selection(args)?;
    let transaction = deps
        .binlog_analyses
        .get_transaction(analysis_id, sequence, filter)
        .map_err(repository_error)?;
    to_json_value(transaction)
}

/// Generates Reset SQL for one projected transaction without executing or proposing it.
pub(super) fn get_reset_sql(deps: &McpDeps, args: BinlogResetSqlArgs) -> Result<Value, AppError> {
    let (analysis_id, sequence, filter) = transaction_selection(args)?;
    let transaction = deps
        .binlog_analyses
        .get_transaction(analysis_id, sequence, filter)
        .map_err(repository_error)?;
    to_json_value(generate_transaction_reset_sql(&transaction))
}

/// Cancels one active parser and idempotently releases its retained analysis values.
pub(super) async fn close_analysis(
    deps: &McpDeps,
    args: BinlogCloseArgs,
) -> Result<Value, AppError> {
    let analysis_id = parse_analysis_id(&args.analysis_id)?;
    let running = deps.binlog_cancellations.lock().await.remove(&analysis_id);
    if let Some(cancellation) = running.as_ref() {
        cancellation.cancel();
    }
    deps.binlog_analyses
        .close(analysis_id)
        .map_err(repository_error)?;
    Ok(json!({
        "ok": true,
        "analysisId": analysis_id,
        "canceledImport": running.is_some(),
    }))
}

/// Prepares either local paths or secure temporary files while preserving input order.
fn prepare_sources(args: BinlogImportArgs) -> Result<PreparedSources, AppError> {
    let has_paths = !args.file_paths.is_empty();
    let has_uploads = !args.files.is_empty();
    if has_paths == has_uploads {
        return Err(validation_error(
            "Provide exactly one non-empty source: file_paths or files",
        ));
    }

    if has_paths {
        if args.file_paths.len() > MAX_MCP_BINLOG_LOCAL_FILES {
            return Err(validation_error(format!(
                "At most {MAX_MCP_BINLOG_LOCAL_FILES} local Binlog paths may be imported at once"
            )));
        }
        let paths = args
            .file_paths
            .into_iter()
            .map(|path| path.trim().to_owned())
            .collect::<Vec<_>>();
        if paths.iter().any(String::is_empty) {
            return Err(validation_error("Binlog file paths must not be empty"));
        }
        let files = inspect_files(&paths).map_err(import_error)?;
        return Ok(PreparedSources {
            files,
            upload_directory: None,
        });
    }

    prepare_uploads(args.files)
}

/// Decodes bounded Base64 uploads into a private temporary directory.
fn prepare_uploads(files: Vec<UploadedBinlogFile>) -> Result<PreparedSources, AppError> {
    if files.len() > MAX_MCP_BINLOG_UPLOAD_FILES {
        return Err(validation_error(format!(
            "At most {MAX_MCP_BINLOG_UPLOAD_FILES} Binlog files may be uploaded at once"
        )));
    }
    let encoded_bytes = files
        .iter()
        .try_fold(0_usize, |total, file| {
            total.checked_add(file.content_base64.len())
        })
        .ok_or_else(|| validation_error("The combined Binlog upload is too large"))?;
    if encoded_bytes > MAX_MCP_BINLOG_ENCODED_BYTES {
        return Err(validation_error(format!(
            "Inline Binlog uploads are limited to {MAX_MCP_BINLOG_UPLOAD_BYTES} decoded bytes; use file_paths for larger local files"
        )));
    }

    let upload_directory = tempfile::Builder::new()
        .prefix("pipa-mcp-binlog-")
        .tempdir()
        .map_err(|_| internal_error("Could not create a private Binlog upload directory"))?;
    let mut names = HashSet::new();
    let mut paths = Vec::with_capacity(files.len());
    let mut decoded_bytes = 0_usize;
    for file in files {
        let name = safe_upload_name(&file.name)?;
        if !names.insert(name.clone()) {
            return Err(validation_error("Uploaded Binlog filenames must be unique"));
        }
        let encoded = file.content_base64.trim();
        let bytes = STANDARD
            .decode(encoded)
            .or_else(|_| STANDARD_NO_PAD.decode(encoded))
            .map_err(|_| validation_error(format!("Uploaded file {name} is not valid Base64")))?;
        decoded_bytes = decoded_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| validation_error("The combined Binlog upload is too large"))?;
        if decoded_bytes > MAX_MCP_BINLOG_UPLOAD_BYTES {
            return Err(validation_error(format!(
                "Inline Binlog uploads are limited to {MAX_MCP_BINLOG_UPLOAD_BYTES} decoded bytes; use file_paths for larger local files"
            )));
        }

        let path = upload_directory.path().join(&name);
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut output = options
            .open(&path)
            .map_err(|_| internal_error("Could not create a private uploaded Binlog file"))?;
        output
            .write_all(&bytes)
            .map_err(|_| internal_error("Could not store an uploaded Binlog file"))?;
        paths.push(path.to_string_lossy().into_owned());
    }

    let files = inspect_files(&paths).map_err(import_error)?;
    Ok(PreparedSources {
        files,
        upload_directory: Some(upload_directory),
    })
}

/// Runs the blocking parser and atomically publishes its terminal output.
async fn run_import(task: McpBinlogImportTask) {
    let McpBinlogImportTask {
        analysis_id,
        prepared,
        started_at,
        initial_summary,
        cancellation,
        repository,
        cancellations,
        queue,
    } = task;
    let PreparedSources {
        files,
        upload_directory,
    } = prepared;
    let parser_cancellation = cancellation.clone();
    let output = tokio::task::spawn_blocking(move || {
        let _upload_directory = upload_directory;
        analyze_files(analysis_id, files, started_at, &parser_cancellation, |_| {})
    })
    .await
    .unwrap_or_else(|_| parser_join_failure(initial_summary));

    cancellations.lock().await.remove(&analysis_id);
    let status = output.summary.status;
    let transaction_count = output.summary.transaction_count;
    let event_count = output.summary.event_count;
    let ok = matches!(
        output.terminal,
        BinlogImportTerminal::Completed | BinlogImportTerminal::Canceled
    );
    match repository.replace(output.summary, output.transactions) {
        Ok(()) => {
            queue
                .push_activity(
                    "binlog_import",
                    None,
                    "finished Binlog analysis",
                    ok,
                    Some(format!(
                        "analysis_id={analysis_id} status={status:?} transactions={transaction_count} events={event_count}"
                    )),
                )
                .await;
        }
        Err(RepositoryError::NotFound) => {}
        Err(error) => {
            queue
                .push_activity(
                    "binlog_import",
                    None,
                    "could not retain Binlog analysis",
                    false,
                    Some(error.to_string()),
                )
                .await;
        }
    }
}

/// Produces a safe terminal analysis when the blocking parser task itself panics.
fn parser_join_failure(mut summary: BinlogSummary) -> BinlogAnalysisOutput {
    let diagnostic = BinlogDiagnostic {
        code: "parser_task_failed".into(),
        message: "The Binlog parser stopped unexpectedly".into(),
        severity: BinlogDiagnosticSeverity::Error,
        file_name: None,
        position: None,
    };
    summary.status = BinlogAnalysisStatus::Error;
    summary.ended_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    summary.diagnostics.push(diagnostic.clone());
    BinlogAnalysisOutput {
        summary,
        transactions: Vec::new(),
        terminal: BinlogImportTerminal::Failed(BinlogImportFailure {
            code: diagnostic.code.clone(),
            message: diagnostic.message.clone(),
            technical_details: None,
            retryable: false,
            diagnostic: Box::new(diagnostic),
        }),
    }
}

/// Converts transaction arguments to a repository identifier and exact filter.
fn transaction_selection(
    args: BinlogTransactionArgs,
) -> Result<(Uuid, u64, BinlogTransactionFilter), AppError> {
    Ok((
        parse_analysis_id(&args.analysis_id)?,
        args.sequence,
        BinlogTransactionFilter {
            database: normalized_filter(args.database),
            table: normalized_filter(args.table),
            operation: parse_operation(args.operation)?,
            cursor: None,
            limit: None,
        },
    ))
}

/// Parses the public operation names used in MCP JSON arguments.
fn parse_operation(operation: Option<String>) -> Result<Option<BinlogOperation>, AppError> {
    let Some(operation) = normalized_filter(operation) else {
        return Ok(None);
    };
    match operation.to_ascii_lowercase().as_str() {
        "insert" => Ok(Some(BinlogOperation::Insert)),
        "update" => Ok(Some(BinlogOperation::Update)),
        "delete" => Ok(Some(BinlogOperation::Delete)),
        "ddl" => Ok(Some(BinlogOperation::Ddl)),
        _ => Err(validation_error(
            "operation must be one of insert, update, delete, or ddl",
        )),
    }
}

/// Trims an optional exact filter and treats an empty string as unrestricted.
fn normalized_filter(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Parses an analysis UUID without conflating it with database connection identifiers.
fn parse_analysis_id(value: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(value.trim()).map_err(|_| validation_error("analysis_id must be a valid UUID"))
}

/// Restricts uploaded names to one portable basename and rejects traversal or hidden NUL bytes.
fn safe_upload_name(value: &str) -> Result<String, AppError> {
    let value = value.trim();
    let path = Path::new(value);
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains(['/', '\\', '\0'])
        || path.file_name().and_then(|name| name.to_str()) != Some(value)
    {
        return Err(validation_error(
            "Uploaded Binlog names must be plain filenames without directory components",
        ));
    }
    Ok(value.to_owned())
}

/// Converts an analysis status plus terminal timestamp into a polling-friendly state.
fn summary_state(summary: &BinlogSummary) -> &'static str {
    if summary.ended_at.is_none() {
        return "importing";
    }
    match summary.status {
        BinlogAnalysisStatus::Complete => "complete",
        BinlogAnalysisStatus::Warning => "warning",
        BinlogAnalysisStatus::Error => "error",
        BinlogAnalysisStatus::Partial => "partial",
    }
}

/// Replaces absolute source paths with basenames before values cross the MCP boundary.
fn redact_summary_paths(mut summary: BinlogSummary) -> BinlogSummary {
    for file in &mut summary.files {
        file.path = file_basename(&file.path);
    }
    summary
}

/// Returns a cross-platform final path segment for responses and safe activity summaries.
fn file_basename(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
        .to_owned()
}

/// Serializes a typed Binlog response without leaking serializer internals to the client.
fn to_json_value(value: impl serde::Serialize) -> Result<Value, AppError> {
    serde_json::to_value(value)
        .map_err(|_| internal_error("Could not serialize the Binlog tool response"))
}

/// Maps preflight failures to a redacted validation error.
fn import_error(error: BinlogImportFailure) -> AppError {
    AppError {
        code: AppErrorCode::Validation,
        message: error.message,
        technical_details: None,
        retryable: error.retryable,
    }
}

/// Maps repository outcomes to stable public application categories.
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

/// Creates a safe caller-correctable error.
fn validation_error(message: impl Into<String>) -> AppError {
    AppError {
        code: AppErrorCode::Validation,
        message: message.into(),
        technical_details: None,
        retryable: false,
    }
}

/// Creates a safe implementation error without filesystem details.
fn internal_error(message: impl Into<String>) -> AppError {
    AppError {
        code: AppErrorCode::Internal,
        message: message.into(),
        technical_details: None,
        retryable: true,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        get_summary, prepare_sources, safe_upload_name, start_import, BinlogImportArgs,
        BinlogSummaryArgs, UploadedBinlogFile,
    };
    use crate::mcp::{shared_connection_scope, McpDeps, McpQueue};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use pipa_binlog::{AnalysisRepository, InMemoryAnalysisRepository};
    use pipa_mysql::MySqlAdapter;
    use pipa_store::{LocalStore, McpSettings};
    use std::{collections::HashMap, sync::Arc, time::Duration};
    use tokio::sync::Mutex;

    /// Builds shared MCP dependencies with an isolated encrypted local store.
    fn test_deps() -> (tempfile::TempDir, McpDeps) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalStore::open(directory.path().join("pipa.db"), "test-key").unwrap();
        (
            directory,
            McpDeps {
                local_store: Arc::new(store),
                mysql: Arc::new(MySqlAdapter::new()),
                queue: McpQueue::new(),
                connection_scope: shared_connection_scope(&McpSettings::default()),
                binlog_analyses: Arc::new(InMemoryAnalysisRepository::new()),
                binlog_cancellations: Arc::new(Mutex::new(HashMap::new())),
            },
        )
    }

    /// Creates a header-only MySQL Binlog upload accepted as a complete empty file.
    fn upload(name: &str) -> UploadedBinlogFile {
        UploadedBinlogFile {
            name: name.into(),
            content_base64: STANDARD.encode([0xfe, b'b', b'i', b'n']),
        }
    }

    /// Verifies multiple inline files preserve their supplied order and private ownership.
    #[test]
    fn prepares_multiple_base64_uploads() {
        let prepared = prepare_sources(BinlogImportArgs {
            file_paths: Vec::new(),
            files: vec![upload("mysql-bin.000001"), upload("mysql-bin.000002")],
        })
        .unwrap();

        assert_eq!(prepared.files.len(), 2);
        assert!(prepared.files[0].path.ends_with("mysql-bin.000001"));
        assert!(prepared.files[1].path.ends_with("mysql-bin.000002"));
        assert!(prepared.upload_directory.is_some());
    }

    /// Verifies upload names cannot escape the private temporary directory.
    #[test]
    fn rejects_upload_path_traversal() {
        assert!(safe_upload_name("../mysql-bin.000001").is_err());
        assert!(safe_upload_name("nested/mysql-bin.000001").is_err());
        assert!(safe_upload_name("nested\\mysql-bin.000001").is_err());
    }

    /// Verifies the MCP lifecycle imports multiple files asynchronously and redacts host paths.
    #[tokio::test]
    async fn multi_file_import_completes_in_shared_repository() {
        let (_directory, deps) = test_deps();
        let started = start_import(
            &deps,
            BinlogImportArgs {
                file_paths: Vec::new(),
                files: vec![upload("mysql-bin.000001"), upload("mysql-bin.000002")],
            },
        )
        .await
        .unwrap();
        let analysis_id = started["analysisId"].as_str().unwrap().to_owned();

        let response = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let response = get_summary(
                    &deps,
                    BinlogSummaryArgs {
                        analysis_id: analysis_id.clone(),
                    },
                )
                .unwrap();
                if response["state"] != "importing" {
                    break response;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        assert_eq!(response["state"], "complete");
        assert_eq!(response["summary"]["files"][0]["path"], "mysql-bin.000001");
        assert_eq!(response["summary"]["files"][1]["path"], "mysql-bin.000002");
        let analysis_id = uuid::Uuid::parse_str(&analysis_id).unwrap();
        assert!(deps.binlog_analyses.get_summary(analysis_id).is_ok());
    }
}
