//! Framework-free domain contracts shared by Pipa transports and database adapters.

#![warn(missing_docs)]

mod connection;
mod error;
mod query;

mod adapter;

pub use adapter::DatabaseAdapter;
pub use connection::{ConnectionProfile, Engine, Environment, SaveConnectionInput, TlsMode};
pub use error::{AppError, AppErrorCode};
pub use query::{CellValue, QueryColumn, QueryEvent, QueryRequest};
