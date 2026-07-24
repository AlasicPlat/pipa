//! Framework-free domain contracts shared by Pipa transports and database adapters.

#![warn(missing_docs)]

mod connection;
mod error;
mod query;
mod sql_policy;

mod adapter;

pub use adapter::DatabaseAdapter;
pub use connection::{ConnectionProfile, Engine, Environment, SaveConnectionInput, TlsMode};
pub use error::{AppError, AppErrorCode};
pub use query::{CellValue, QueryColumn, QueryEvent, QueryRequest, RecordQueryHistoryInput};
pub use sql_policy::{classify_sql, mcp_may_execute, ExecutionSource, SqlRisk};
