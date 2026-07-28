use crate::{AppError, CellValue};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;
use uuid::Uuid;

/// Lifecycle state of one in-memory binlog analysis session.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BinlogAnalysisStatus {
    /// Parsing completed without diagnostics.
    Complete,
    /// Parsing completed with one or more non-fatal diagnostics.
    Warning,
    /// Parsing stopped because an input or decoder error occurred.
    Error,
    /// Parsing is active or stopped after cancellation with partial results.
    Partial,
}

/// Mutation represented by a row or statement binlog event.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BinlogOperation {
    /// One or more rows were inserted.
    Insert,
    /// One or more existing rows were updated.
    Update,
    /// One or more rows were deleted.
    Delete,
    /// A data-definition statement changed schema state.
    Ddl,
}

/// Confidence of the database and table attribution on a change.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BinlogTableConfidence {
    /// The table came from a row event's matching TableMap event.
    Exact,
    /// The table was inferred from statement SQL.
    SqlParsed,
    /// The event did not contain enough information to identify a table.
    Unknown,
}

/// Commit state of one assembled binlog transaction.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BinlogTransactionStatus {
    /// A commit boundary such as XID or COMMIT was observed.
    Committed,
    /// A ROLLBACK statement was observed.
    RolledBack,
    /// The input ended or changed transaction identity before a commit boundary.
    Incomplete,
    /// A statement format did not provide a definitive transaction boundary.
    Unknown,
}

/// Severity attached to one non-secret parser diagnostic.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BinlogDiagnosticSeverity {
    /// Informational compatibility or attribution detail.
    Info,
    /// Parsing continued, but some analysis detail is unavailable.
    Warning,
    /// Parsing could not safely continue.
    Error,
}

/// One imported file and its size at the beginning of analysis.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogFileSummary {
    /// User-selected local path.
    pub path: String,
    /// File size captured before parsing starts.
    #[ts(type = "number")]
    pub size_bytes: u64,
}

/// Safe diagnostic that locates a parser or compatibility issue.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogDiagnostic {
    /// Stable machine-readable diagnostic identifier.
    pub code: String,
    /// User-facing diagnostic message that excludes row values.
    pub message: String,
    /// Diagnostic severity.
    pub severity: BinlogDiagnosticSeverity,
    /// Basename of the affected binlog file when known.
    pub file_name: Option<String>,
    /// Physical byte offset within the affected file when known.
    #[ts(type = "number | null")]
    pub position: Option<u64>,
}

/// Aggregate mutation counts for one table.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogTableSummary {
    /// Database name recorded by the binlog.
    pub database: String,
    /// Table name recorded by the binlog.
    pub table: String,
    /// Total inserted rows.
    #[ts(type = "number")]
    pub insert_count: u64,
    /// Total updated rows.
    #[ts(type = "number")]
    pub update_count: u64,
    /// Total deleted rows.
    #[ts(type = "number")]
    pub delete_count: u64,
    /// Total statement-level schema changes.
    #[ts(type = "number")]
    pub ddl_count: u64,
    /// Total row-level changes.
    #[ts(type = "number")]
    pub row_change_count: u64,
}

/// Current summary of one imported binlog analysis.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogSummary {
    /// Stable analysis-session identifier.
    #[ts(type = "string")]
    pub analysis_id: Uuid,
    /// Imported files in authoritative input order.
    pub files: Vec<BinlogFileSummary>,
    /// Current analysis lifecycle state.
    pub status: BinlogAnalysisStatus,
    /// RFC 3339 wall-clock time when analysis started.
    pub started_at: String,
    /// RFC 3339 wall-clock time when analysis reached a terminal state.
    pub ended_at: Option<String>,
    /// RFC 3339 timestamp of the first non-zero event timestamp.
    pub first_event_at: Option<String>,
    /// RFC 3339 timestamp of the last non-zero event timestamp.
    pub last_event_at: Option<String>,
    /// Number of assembled transactions.
    #[ts(type = "number")]
    pub transaction_count: u64,
    /// Number of physical and decompressed logical events read.
    #[ts(type = "number")]
    pub event_count: u64,
    /// Number of decoded row mutations.
    #[ts(type = "number")]
    pub row_change_count: u64,
    /// Per-table aggregate counts.
    pub tables: Vec<BinlogTableSummary>,
    /// Ordered parser and integrity diagnostics.
    pub diagnostics: Vec<BinlogDiagnostic>,
}

/// A cell in a before or after row image.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum BinlogCell {
    /// The row image bitmap says this column was not recorded.
    NotLogged,
    /// The binlog explicitly recorded SQL NULL.
    Null,
    /// A lossless transport-safe value was decoded.
    Value {
        /// Decoded lossless value.
        value: CellValue,
    },
    /// A MySQL TIMESTAMP value retained as exact decimal Unix seconds.
    UnixTimestamp {
        /// Unix seconds, including the fractional component for TIMESTAMP2.
        value: String,
    },
    /// The column was logged, but this parser could not decode it safely.
    DecodeError {
        /// Safe reason that excludes the underlying row value.
        message: String,
    },
    /// A value is intentionally partial, such as a JSON diff payload.
    Partial {
        /// Decoded partial representation.
        value: CellValue,
        /// Optional explanation of the partial semantics.
        message: Option<String>,
    },
}

/// One row mutation with column-name keyed images.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogRowChange {
    /// Before image for DELETE and UPDATE, or `None` when absent.
    pub before: Option<BTreeMap<String, BinlogCell>>,
    /// After image for INSERT and UPDATE, or `None` when absent.
    pub after: Option<BTreeMap<String, BinlogCell>>,
}

/// One table mutation event inside a transaction.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogChange {
    /// Database attributed to the event, or an empty string when unknown.
    pub database: String,
    /// Table attributed to the event, or an empty string when unknown.
    pub table: String,
    /// Mutation category.
    pub operation: BinlogOperation,
    /// Number of affected rows represented by this event.
    #[ts(type = "number")]
    pub row_count: u64,
    /// Column names in row-image order, using `@1`, `@2`, … when metadata is absent.
    pub columns: Vec<String>,
    /// Decoded row changes; empty for statement events.
    pub rows: Vec<BinlogRowChange>,
    /// Evidence quality for database and table attribution.
    pub table_confidence: BinlogTableConfidence,
    /// Original statement text when it was present in the binlog.
    pub sql: Option<String>,
}

/// Aggregate change counts for one table inside a transaction.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogTransactionTable {
    /// Database name.
    pub database: String,
    /// Table name.
    pub table: String,
    /// Inserted row count.
    #[ts(type = "number")]
    pub insert_count: u64,
    /// Updated row count.
    #[ts(type = "number")]
    pub update_count: u64,
    /// Deleted row count.
    #[ts(type = "number")]
    pub delete_count: u64,
    /// Statement-level schema change count.
    #[ts(type = "number")]
    pub ddl_count: u64,
    /// Total row mutations for this table inside the transaction.
    #[ts(type = "number")]
    pub row_change_count: u64,
}

/// One complete or incomplete transaction in authoritative file-position order.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogTransaction {
    /// Stable transaction identifier derived from analysis ID and sequence.
    pub id: String,
    /// Stable one-based transaction sequence.
    #[ts(type = "number")]
    pub sequence: u64,
    /// RFC 3339 timestamp sourced from the transaction's first event.
    pub timestamp: String,
    /// MySQL global transaction identifier when present.
    pub gtid: Option<String>,
    /// MySQL transaction identifier encoded as a decimal string.
    pub xid: Option<String>,
    /// Originating server identifier.
    pub server_id: u32,
    /// Basename of the file containing the transaction's first event.
    pub file_name: String,
    /// Physical start offset within `fileName`.
    #[ts(type = "number")]
    pub start_position: u64,
    /// Physical end offset of the last event associated with the transaction.
    #[ts(type = "number")]
    pub end_position: u64,
    /// Observed commit status.
    pub status: BinlogTransactionStatus,
    /// Total row mutations across this transaction.
    #[ts(type = "number")]
    pub row_change_count: u64,
    /// Aggregated table impact.
    pub tables: Vec<BinlogTransactionTable>,
    /// Ordered row and statement changes.
    pub changes: Vec<BinlogChange>,
}

/// Lightweight transaction metadata returned by timeline pagination.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogTransactionSummary {
    /// Stable transaction identifier derived from analysis ID and sequence.
    pub id: String,
    /// Stable one-based transaction sequence.
    #[ts(type = "number")]
    pub sequence: u64,
    /// RFC 3339 timestamp sourced from the transaction's first event.
    pub timestamp: String,
    /// MySQL global transaction identifier when present.
    pub gtid: Option<String>,
    /// MySQL transaction identifier encoded as a decimal string.
    pub xid: Option<String>,
    /// Originating server identifier.
    pub server_id: u32,
    /// Basename of the file containing the transaction's first event.
    pub file_name: String,
    /// Physical start offset within `fileName`.
    #[ts(type = "number")]
    pub start_position: u64,
    /// Physical end offset of the last event associated with the transaction.
    #[ts(type = "number")]
    pub end_position: u64,
    /// Observed commit status.
    pub status: BinlogTransactionStatus,
    /// Total row mutations matching the active timeline filter.
    #[ts(type = "number")]
    pub row_change_count: u64,
    /// Aggregated table impact for the complete transaction.
    pub tables: Vec<BinlogTransactionTable>,
}

/// Filter and cursor pagination input for the transaction timeline.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogTransactionFilter {
    /// Exact database name filter.
    pub database: Option<String>,
    /// Exact table name filter.
    pub table: Option<String>,
    /// Optional mutation category filter.
    pub operation: Option<BinlogOperation>,
    /// Opaque cursor returned by the preceding page.
    pub cursor: Option<String>,
    /// Requested page size; the backend applies a bounded default and maximum.
    pub limit: Option<u32>,
}

/// One cursor-paginated transaction result.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogTransactionPage {
    /// Matching transaction summaries in stable sequence order.
    pub items: Vec<BinlogTransactionSummary>,
    /// Cursor for the next page, or `None` when this is the final page.
    pub next_cursor: Option<String>,
}

/// Reset SQL generated from the recorded before/after row images of one transaction.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BinlogResetSql {
    /// Reviewable MySQL statements in reverse mutation order, or an empty string when unsafe.
    pub sql: String,
    /// Number of generated DML statements.
    #[ts(type = "number")]
    pub statement_count: u64,
    /// Whether every row mutation in the requested transaction projection was reversible.
    pub complete: bool,
    /// Safe explanations for every skipped or bounded mutation.
    pub warnings: Vec<String>,
}

/// Ordered progress events emitted by a background binlog import.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum BinlogImportEvent {
    /// The import task was accepted and file metadata was captured.
    Started {
        /// Stable analysis identifier.
        #[ts(type = "string")]
        analysis_id: Uuid,
        /// Number of input files captured before parsing.
        file_count: u32,
        /// Total bytes across all input files.
        #[ts(type = "number")]
        total_bytes: u64,
    },
    /// Bounded progress update emitted during parsing.
    Progress {
        /// Stable analysis identifier.
        #[ts(type = "string")]
        analysis_id: Uuid,
        /// Bytes consumed from completed files and the current event boundary.
        #[ts(type = "number")]
        bytes_read: u64,
        /// Total input bytes captured before parsing.
        #[ts(type = "number")]
        total_bytes: u64,
        /// Total number of input files.
        file_count: u32,
        /// Number of fully parsed input files.
        files_completed: u32,
        /// Basename of the file currently being parsed.
        current_file: Option<String>,
        /// Number of assembled transactions so far.
        #[ts(type = "number")]
        transaction_count: u64,
        /// Number of physical and decompressed logical events read so far.
        #[ts(type = "number")]
        event_count: u64,
    },
    /// Every input file reached a clean end.
    Completed {
        /// Stable analysis identifier.
        #[ts(type = "string")]
        analysis_id: Uuid,
    },
    /// Parsing stopped because an error made further results unsafe.
    Failed {
        /// Stable analysis identifier.
        #[ts(type = "string")]
        analysis_id: Uuid,
        /// Safe application error.
        error: AppError,
    },
    /// Parsing stopped after cancellation.
    Canceled {
        /// Stable analysis identifier.
        #[ts(type = "string")]
        analysis_id: Uuid,
    },
}

#[cfg(test)]
mod tests {
    use super::{
        BinlogAnalysisStatus, BinlogCell, BinlogChange, BinlogImportEvent, BinlogOperation,
        BinlogRowChange, BinlogSummary, BinlogTableConfidence, BinlogTableSummary,
        BinlogTransaction, BinlogTransactionFilter, BinlogTransactionStatus,
        BinlogTransactionTable,
    };
    use crate::{AppError, AppErrorCode, CellValue};
    use std::collections::BTreeMap;
    use ts_rs::{Config, TS};
    use uuid::Uuid;

    /// Verifies the import event contract uses snake-case tags and camel-case fields.
    #[test]
    fn import_event_json_contract_is_stable() {
        let analysis_id = Uuid::nil();
        let event = BinlogImportEvent::Progress {
            analysis_id,
            bytes_read: 21,
            total_bytes: 34,
            file_count: 2,
            files_completed: 1,
            current_file: Some("mysql-bin.000002".into()),
            transaction_count: 3,
            event_count: 5,
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "type": "progress",
                "analysisId": analysis_id,
                "bytesRead": 21,
                "totalBytes": 34,
                "fileCount": 2,
                "filesCompleted": 1,
                "currentFile": "mysql-bin.000002",
                "transactionCount": 3,
                "eventCount": 5
            })
        );
    }

    /// Verifies started and failed lifecycle fields match the Tauri client contract.
    #[test]
    fn import_terminal_event_contract_is_stable() {
        let analysis_id = Uuid::nil();
        assert_eq!(
            serde_json::to_value(BinlogImportEvent::Started {
                analysis_id,
                file_count: 2,
                total_bytes: 55,
            })
            .unwrap(),
            serde_json::json!({
                "type": "started",
                "analysisId": analysis_id,
                "fileCount": 2,
                "totalBytes": 55
            })
        );
        assert_eq!(
            serde_json::to_value(BinlogImportEvent::Failed {
                analysis_id,
                error: AppError {
                    code: AppErrorCode::Query,
                    message: "Could not decode binlog".into(),
                    technical_details: Some("mysql-bin.000001 at 4".into()),
                    retryable: false,
                },
            })
            .unwrap(),
            serde_json::json!({
                "type": "failed",
                "analysisId": analysis_id,
                "error": {
                    "code": "query",
                    "message": "Could not decode binlog",
                    "technicalDetails": "mysql-bin.000001 at 4",
                    "retryable": false
                }
            })
        );
    }

    /// Verifies missing and explicit NULL row cells remain distinguishable in JSON.
    #[test]
    fn row_cell_json_distinguishes_not_logged_and_null() {
        assert_eq!(
            serde_json::to_value(BinlogCell::NotLogged).unwrap(),
            serde_json::json!({"kind": "not_logged"})
        );
        assert_eq!(
            serde_json::to_value(BinlogCell::Null).unwrap(),
            serde_json::json!({"kind": "null"})
        );
        assert_eq!(
            serde_json::to_value(BinlogCell::Value {
                value: CellValue::Integer("9007199254740993".into())
            })
            .unwrap(),
            serde_json::json!({
                "kind": "value",
                "value": {"kind": "integer", "value": "9007199254740993"}
            })
        );
        assert_eq!(
            serde_json::to_value(BinlogCell::DecodeError {
                message: "partial JSON is not materialized".into()
            })
            .unwrap(),
            serde_json::json!({
                "kind": "decode_error",
                "message": "partial JSON is not materialized"
            })
        );
        assert_eq!(
            serde_json::to_value(BinlogCell::UnixTimestamp {
                value: "1722067200.123456".into()
            })
            .unwrap(),
            serde_json::json!({
                "kind": "unix_timestamp",
                "value": "1722067200.123456"
            })
        );
    }

    /// Verifies filter fields and generated TypeScript stay aligned with frontend IPC.
    #[test]
    fn filter_contract_uses_camel_case_and_optional_cursor() {
        let filter = BinlogTransactionFilter {
            database: Some("sales".into()),
            table: Some("orders".into()),
            operation: Some(BinlogOperation::Update),
            cursor: Some("41".into()),
            limit: Some(100),
        };

        assert_eq!(
            serde_json::to_value(filter).unwrap(),
            serde_json::json!({
                "database": "sales",
                "table": "orders",
                "operation": "update",
                "cursor": "41",
                "limit": 100
            })
        );
        let declaration = BinlogTransactionFilter::decl(&Config::default());
        assert!(declaration.contains("cursor: string | null"));
        assert!(declaration.contains("operation: BinlogOperation | null"));
    }

    /// Verifies summary, table, row-image, SQL, and transaction count field names.
    #[test]
    fn summary_and_transaction_json_match_frontend_shape() {
        let analysis_id = Uuid::nil();
        let table = BinlogTableSummary {
            database: "sales".into(),
            table: "orders".into(),
            insert_count: 0,
            update_count: 1,
            delete_count: 0,
            ddl_count: 0,
            row_change_count: 1,
        };
        let summary = BinlogSummary {
            analysis_id,
            files: Vec::new(),
            status: BinlogAnalysisStatus::Complete,
            started_at: "2026-01-01T00:00:00Z".into(),
            ended_at: Some("2026-01-01T00:00:01Z".into()),
            first_event_at: Some("2026-01-01T00:00:00Z".into()),
            last_event_at: Some("2026-01-01T00:00:00Z".into()),
            transaction_count: 1,
            event_count: 4,
            row_change_count: 1,
            tables: vec![table],
            diagnostics: Vec::new(),
        };
        let change = BinlogChange {
            database: "sales".into(),
            table: "orders".into(),
            operation: BinlogOperation::Update,
            row_count: 1,
            columns: vec!["id".into()],
            rows: vec![BinlogRowChange {
                before: Some(BTreeMap::from([(
                    "id".into(),
                    BinlogCell::Value {
                        value: CellValue::Integer("7".into()),
                    },
                )])),
                after: Some(BTreeMap::from([("id".into(), BinlogCell::NotLogged)])),
            }],
            table_confidence: BinlogTableConfidence::Exact,
            sql: Some("UPDATE orders SET value = 1 WHERE id = 7".into()),
        };
        let transaction = BinlogTransaction {
            id: format!("{analysis_id}:1"),
            sequence: 1,
            timestamp: "2026-01-01T00:00:00Z".into(),
            gtid: None,
            xid: Some("9".into()),
            server_id: 1,
            file_name: "mysql-bin.000001".into(),
            start_position: 4,
            end_position: 80,
            status: BinlogTransactionStatus::Committed,
            row_change_count: 1,
            tables: vec![BinlogTransactionTable {
                database: "sales".into(),
                table: "orders".into(),
                insert_count: 0,
                update_count: 1,
                delete_count: 0,
                ddl_count: 0,
                row_change_count: 1,
            }],
            changes: vec![change],
        };

        let summary_json = serde_json::to_value(summary).unwrap();
        let transaction_json = serde_json::to_value(transaction).unwrap();

        assert_eq!(summary_json["status"], "complete");
        assert_eq!(summary_json["tables"][0]["rowChangeCount"], 1);
        assert_eq!(transaction_json["rowChangeCount"], 1);
        assert_eq!(
            transaction_json["changes"][0]["sql"],
            "UPDATE orders SET value = 1 WHERE id = 7"
        );
        assert_eq!(
            transaction_json["changes"][0]["rows"][0]["after"]["id"]["kind"],
            "not_logged"
        );
    }
}
