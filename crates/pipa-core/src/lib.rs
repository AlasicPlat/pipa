//! Framework-free domain contracts shared by Pipa transports and database adapters.

#![warn(missing_docs)]

mod binlog;
mod connection;
mod error;
mod query;
mod sql_policy;

mod adapter;

pub use adapter::DatabaseAdapter;
pub use binlog::{
    BinlogAnalysisStatus, BinlogCell, BinlogChange, BinlogDiagnostic, BinlogDiagnosticSeverity,
    BinlogFileSummary, BinlogImportEvent, BinlogOperation, BinlogResetSql, BinlogRowChange,
    BinlogSummary, BinlogTableConfidence, BinlogTableSummary, BinlogTransaction,
    BinlogTransactionFilter, BinlogTransactionPage, BinlogTransactionStatus,
    BinlogTransactionSummary, BinlogTransactionTable,
};
pub use connection::{ConnectionProfile, Engine, Environment, SaveConnectionInput, TlsMode};
pub use error::{AppError, AppErrorCode};
pub use query::{CellValue, QueryColumn, QueryEvent, QueryRequest, RecordQueryHistoryInput};
pub use sql_policy::{classify_sql, mcp_may_execute, ExecutionSource, SqlRisk};
