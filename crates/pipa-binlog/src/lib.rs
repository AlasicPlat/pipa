//! Streaming MySQL binary-log analysis for Pipa.

#![warn(missing_docs)]

mod assembler;
mod parser;
mod repository;
mod reset_sql;

pub use parser::{
    analyze_files, initial_summary, inspect_files, BinlogAnalysisOutput, BinlogImportFailure,
    BinlogImportTerminal, BinlogProgress,
};
pub use repository::{AnalysisRepository, InMemoryAnalysisRepository, RepositoryError};
pub use reset_sql::generate_transaction_reset_sql;
