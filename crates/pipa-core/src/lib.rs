//! Framework-free domain contracts shared by Pipa transports and database adapters.

#![warn(missing_docs)]

mod binlog;
mod connection;
mod error;
mod query;
mod sql_policy;
mod table;
mod table_ddl;
mod table_filter;

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
pub use table::{
    ApplyTableMutationsInput, ApplyTableMutationsResult, TableMutation, TableMutationField,
    TableMutationValue,
};
pub use table_ddl::{
    build_alter_table_comment_statement, build_create_database_plan, build_table_ddl_plan,
    column_type_validation_error, database_charset_options, database_name_validation_error,
    is_structure_column_editable, CreateDatabasePlan, DatabaseCharsetOption, TableColumnDefinition,
    TableDdlPlan,
};
pub use table_filter::{
    build_table_filter_clause, filter_operators_for_column_type, is_filterable_column_type,
    mysql_string_literal, quote_identifier, TableFilterClause, TableFilterColumn,
    TableFilterCondition, TableFilterConjunction, TableFilterOperator,
};
