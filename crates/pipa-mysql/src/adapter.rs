use crate::value::{convert_cell, normalize_database_type};
use futures_util::TryStreamExt;
use pipa_core::{
    AppError, AppErrorCode, ConnectionProfile, DatabaseAdapter, Engine, QueryColumn, QueryEvent,
    QueryRequest, TlsMode,
};
use secrecy::{ExposeSecret, SecretString};
use sqlx_core::{
    column::Column, raw_sql::raw_sql, row::Row, sql_str::AssertSqlSafe, type_info::TypeInfo,
    Either, Error as SqlxError,
};
use sqlx_mysql::{
    MySqlConnectOptions, MySqlDatabaseError, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode,
};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BATCH_ROWS: usize = 256;

/// SQLx-backed adapter for MySQL-compatible databases.
pub struct MySqlAdapter;

impl MySqlAdapter {
    /// Creates a stateless MySQL adapter.
    pub const fn new() -> Self {
        Self
    }

    /// Executes one MCP-approved query in a server-enforced read-only session.
    pub async fn query_readonly(
        &self,
        profile: &ConnectionProfile,
        password: SecretString,
        request: QueryRequest,
        events: mpsc::Sender<QueryEvent>,
        cancellation: CancellationToken,
    ) -> Result<(), AppError> {
        execute_query(profile, password, request, events, cancellation, true).await
    }
}

impl Default for MySqlAdapter {
    /// Creates the default stateless MySQL adapter.
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl DatabaseAdapter for MySqlAdapter {
    /// Returns the MySQL engine identifier.
    fn engine(&self) -> Engine {
        Engine::MySql
    }

    /// Tests a MySQL connection using the adapter's ten-second connection timeout.
    async fn test_connection(
        &self,
        profile: &ConnectionProfile,
        password: &SecretString,
    ) -> Result<(), AppError> {
        let pool = create_pool(profile, password);
        let connection = pool
            .acquire()
            .await
            .map_err(|error| map_connection_error(&error, password.expose_secret()))?;
        connection
            .close()
            .await
            .map_err(|error| map_connection_error(&error, password.expose_secret()))?;
        pool.close().await;
        Ok(())
    }

    /// Executes a MySQL query as ordered streaming events.
    async fn query(
        &self,
        profile: &ConnectionProfile,
        password: SecretString,
        request: QueryRequest,
        events: mpsc::Sender<QueryEvent>,
        cancellation: CancellationToken,
    ) -> Result<(), AppError> {
        execute_query(profile, password, request, events, cancellation, false).await
    }
}

/// Executes a query with optional database-enforced read-only session semantics.
async fn execute_query(
    profile: &ConnectionProfile,
    password: SecretString,
    request: QueryRequest,
    events: mpsc::Sender<QueryEvent>,
    cancellation: CancellationToken,
    read_only: bool,
) -> Result<(), AppError> {
    let query_id = request.query_id;
    let pool = create_pool(profile, &password);
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_connection_error(&error, password.expose_secret()))?;

    send_event(&events, QueryEvent::Started { query_id }).await?;
    if read_only {
        if let Err(error) = raw_sql(AssertSqlSafe("SET SESSION TRANSACTION READ ONLY"))
            .execute(&mut *connection)
            .await
        {
            send_query_failure(&events, query_id, &error, password.expose_secret()).await?;
            return Ok(());
        }
    }

    // QueryRequest contains the user's complete editor SQL, not interpolated application data.
    let mut rows = raw_sql(AssertSqlSafe(request.sql)).fetch_many(&mut *connection);
    let mut schema_sent = false;
    let mut current_result_has_rows = false;
    let mut completed_row_result = false;
    let mut batch = Vec::with_capacity(MAX_BATCH_ROWS);
    let mut affected_rows = 0_u64;

    loop {
        let next = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                drop(rows);
                // The connection has already been removed from the pool even if shutdown fails.
                let _close_result = connection.close().await;
                send_event(&events, QueryEvent::Canceled { query_id }).await?;
                return Ok(());
            }
            next = rows.try_next() => next,
        };

        match next {
            Ok(Some(Either::Left(result))) => {
                affected_rows = affected_rows.saturating_add(result.rows_affected());
                // SQLx emits QueryResult after a statement's rows, making this the set boundary.
                if current_result_has_rows {
                    if !batch.is_empty() {
                        send_event(
                            &events,
                            QueryEvent::Batch {
                                query_id,
                                rows: std::mem::take(&mut batch),
                            },
                        )
                        .await?;
                    }
                    current_result_has_rows = false;
                    completed_row_result = true;
                }
            }
            Ok(Some(Either::Right(row))) => {
                // QueryEvent has one schema, so later row-producing sets cannot be represented.
                if completed_row_result {
                    drop(rows);
                    send_event(
                        &events,
                        QueryEvent::Failed {
                            query_id,
                            error: AppError {
                                code: AppErrorCode::Query,
                                message: "Multiple result sets are not supported".into(),
                                technical_details: None,
                                retryable: false,
                            },
                        },
                    )
                    .await?;
                    return Ok(());
                }
                current_result_has_rows = true;

                if !schema_sent {
                    send_event(
                        &events,
                        QueryEvent::Schema {
                            query_id,
                            columns: query_columns(&row),
                        },
                    )
                    .await?;
                    schema_sent = true;
                }

                match convert_row(&row) {
                    Ok(row) => batch.push(row),
                    Err(error) => {
                        drop(rows);
                        send_query_failure(&events, query_id, &error, password.expose_secret())
                            .await?;
                        return Ok(());
                    }
                }

                if batch.len() == MAX_BATCH_ROWS {
                    send_event(
                        &events,
                        QueryEvent::Batch {
                            query_id,
                            rows: std::mem::take(&mut batch),
                        },
                    )
                    .await?;
                }
            }
            Ok(None) => break,
            Err(error) => {
                drop(rows);
                send_query_failure(&events, query_id, &error, password.expose_secret()).await?;
                return Ok(());
            }
        }
    }

    drop(rows);
    if !batch.is_empty() {
        send_event(
            &events,
            QueryEvent::Batch {
                query_id,
                rows: batch,
            },
        )
        .await?;
    }
    if read_only {
        if let Err(error) = raw_sql(AssertSqlSafe("SET SESSION TRANSACTION READ WRITE"))
            .execute(&mut *connection)
            .await
        {
            send_query_failure(&events, query_id, &error, password.expose_secret()).await?;
            return Ok(());
        }
    }
    send_event(
        &events,
        QueryEvent::Completed {
            query_id,
            affected_rows,
        },
    )
    .await
}

/// Builds profile-derived SQLx options and a lazy one-connection pool.
fn create_pool(profile: &ConnectionProfile, password: &SecretString) -> MySqlPool {
    let ssl_mode = match profile.tls_mode {
        TlsMode::Disabled => MySqlSslMode::Disabled,
        TlsMode::Preferred => MySqlSslMode::Preferred,
        TlsMode::Required => MySqlSslMode::Required,
    };
    let mut options = MySqlConnectOptions::new()
        .host(&profile.host)
        .port(profile.port)
        .username(&profile.username)
        .password(password.expose_secret())
        .ssl_mode(ssl_mode);
    if let Some(database) = &profile.database {
        options = options.database(database);
    }

    MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(CONNECTION_TIMEOUT)
        .connect_lazy_with(options)
}

/// Derives the ordered Pipa schema from SQLx row metadata.
fn query_columns(row: &MySqlRow) -> Vec<QueryColumn> {
    row.columns()
        .iter()
        .map(|column| QueryColumn {
            name: column.name().to_owned(),
            database_type: normalize_database_type(column.type_info().name()).to_owned(),
            nullable: None,
        })
        .collect()
}

/// Converts every cell in a SQLx row while preserving column order.
fn convert_row(row: &MySqlRow) -> Result<Vec<pipa_core::CellValue>, SqlxError> {
    row.columns()
        .iter()
        .enumerate()
        .map(|(index, column)| convert_cell(row, index, column.type_info().name()))
        .collect()
}

/// Sends one ordered query event or reports that the consumer disappeared.
async fn send_event(events: &mpsc::Sender<QueryEvent>, event: QueryEvent) -> Result<(), AppError> {
    events.send(event).await.map_err(|_| AppError {
        code: AppErrorCode::Internal,
        message: "Query event receiver is unavailable".into(),
        technical_details: None,
        retryable: false,
    })
}

/// Sends a stable failed event for a SQLx execution or decoding error.
async fn send_query_failure(
    events: &mpsc::Sender<QueryEvent>,
    query_id: uuid::Uuid,
    error: &SqlxError,
    password: &str,
) -> Result<(), AppError> {
    send_event(
        events,
        QueryEvent::Failed {
            query_id,
            error: map_query_error(error, password),
        },
    )
    .await
}

/// Maps connection-phase SQLx failures into stable application categories.
fn map_connection_error(error: &SqlxError, password: &str) -> AppError {
    let (code, message, retryable) = match error {
        SqlxError::PoolTimedOut => (AppErrorCode::Timeout, "Connection timed out", true),
        SqlxError::Database(database_error)
            if mysql_error_number(database_error.as_ref()) == 1045 =>
        {
            (AppErrorCode::Authentication, "Authentication failed", false)
        }
        SqlxError::Io(_) | SqlxError::Tls(_) | SqlxError::PoolClosed | SqlxError::WorkerCrashed => {
            (
                AppErrorCode::Connection,
                "Could not connect to the database",
                true,
            )
        }
        _ => (
            AppErrorCode::Connection,
            "Could not connect to the database",
            false,
        ),
    };
    stable_error(code, message, error, password, retryable)
}

/// Maps query-phase SQLx failures into stable application categories.
fn map_query_error(error: &SqlxError, password: &str) -> AppError {
    let (code, message, retryable) = match error {
        SqlxError::PoolTimedOut => (AppErrorCode::Timeout, "Query timed out", true),
        SqlxError::Database(database_error)
            if matches!(
                mysql_error_number(database_error.as_ref()),
                1044 | 1045 | 1142 | 1227
            ) =>
        {
            (AppErrorCode::Permission, "Query permission denied", false)
        }
        SqlxError::Io(_) | SqlxError::Tls(_) | SqlxError::WorkerCrashed => {
            (AppErrorCode::Connection, "Database connection lost", true)
        }
        _ => (AppErrorCode::Query, "Query execution failed", false),
    };
    stable_error(code, message, error, password, retryable)
}

/// Extracts a MySQL server error number without assuming every SQLx database error is MySQL.
fn mysql_error_number(error: &dyn sqlx_core::error::DatabaseError) -> u16 {
    error
        .try_downcast_ref::<MySqlDatabaseError>()
        .map_or(0, MySqlDatabaseError::number)
}

/// Builds a safe application error while retaining only password-redacted driver details.
fn stable_error(
    code: AppErrorCode,
    message: &str,
    error: &SqlxError,
    password: &str,
    retryable: bool,
) -> AppError {
    let mut technical_details = error.to_string();
    if !password.is_empty() {
        technical_details = technical_details.replace(password, "[REDACTED]");
    }

    AppError {
        code,
        message: message.into(),
        technical_details: Some(technical_details),
        retryable,
    }
}

#[cfg(test)]
mod tests {
    use super::{map_connection_error, map_query_error};
    use pipa_core::AppErrorCode;
    use sqlx_core::Error as SqlxError;
    use std::io;

    /// Verifies pool acquisition timeouts use the stable retryable timeout category.
    #[test]
    fn connection_timeouts_are_stable_and_retryable() {
        let error = map_connection_error(&SqlxError::PoolTimedOut, "unused");

        assert!(matches!(error.code, AppErrorCode::Timeout));
        assert_eq!(error.message, "Connection timed out");
        assert!(error.retryable);
        assert!(error.technical_details.is_some());
    }

    /// Verifies network diagnostics remain useful without exposing the supplied password.
    #[test]
    fn network_errors_are_stable_and_redacted() {
        let password = "network-secret";
        let driver_error = SqlxError::Io(io::Error::other(format!(
            "connection failed with {password}"
        )));
        let error = map_connection_error(&driver_error, password);

        assert!(matches!(error.code, AppErrorCode::Connection));
        assert_eq!(error.message, "Could not connect to the database");
        assert!(error.retryable);
        let technical_details = error
            .technical_details
            .expect("redacted driver details should be retained");
        assert!(technical_details.contains("[REDACTED]"));
        assert!(!technical_details.contains(password));
    }

    /// Verifies query-phase timeouts have a query-specific stable message.
    #[test]
    fn query_timeouts_are_stable_and_retryable() {
        let error = map_query_error(&SqlxError::PoolTimedOut, "unused");

        assert!(matches!(error.code, AppErrorCode::Timeout));
        assert_eq!(error.message, "Query timed out");
        assert!(error.retryable);
    }
}
