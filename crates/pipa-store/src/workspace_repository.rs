use crate::{storage_error, LocalStore};
use chrono::{DateTime, Utc};
use pipa_core::{AppError, AppErrorCode};
use rusqlite::{params, types::Type, Error as SqlError};
use std::io;
use uuid::Uuid;

/// One persisted SQL editor tab.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceTab {
    /// Stable tab identifier.
    pub id: Uuid,
    /// Immutable connection associated with this tab.
    pub connection_id: Uuid,
    /// User-visible tab title.
    pub title: String,
    /// Unsaved SQL editor contents.
    pub sql_text: String,
    /// Display order within the workspace.
    pub position: u32,
}

/// One locally persisted executed query.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueryHistoryEntry {
    /// Stable history entry identifier.
    pub id: Uuid,
    /// Connection used to execute the query.
    pub connection_id: Uuid,
    /// SQL text that was executed.
    pub sql_text: String,
    /// UTC execution timestamp.
    pub executed_at: DateTime<Utc>,
}

impl LocalStore {
    /// Replaces one window's persisted workspace tabs in one transaction.
    pub fn save_workspace(
        &self,
        window_label: &str,
        tabs: &[WorkspaceTab],
    ) -> Result<(), AppError> {
        let mut connection = self.connection()?;
        let result = (|| -> rusqlite::Result<()> {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM workspace_tabs WHERE window_label = ?1",
                [window_label],
            )?;
            {
                let mut statement = transaction.prepare(
                    "INSERT INTO workspace_tabs (
                       id, connection_id, title, sql_text, position, window_label
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )?;
                for tab in tabs {
                    statement.execute(params![
                        tab.id,
                        tab.connection_id,
                        tab.title,
                        tab.sql_text,
                        tab.position,
                        window_label,
                    ])?;
                }
            }
            transaction.commit()
        })();

        result.map_err(|error| {
            storage_error(
                "Could not save query workspace",
                "replace workspace tabs",
                error,
            )
        })
    }

    /// Loads one window's workspace tabs in ascending position order.
    pub fn load_workspace(&self, window_label: &str) -> Result<Vec<WorkspaceTab>, AppError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT id, connection_id, title, sql_text, position
                 FROM workspace_tabs
                 WHERE window_label = ?1
                 ORDER BY position ASC, id ASC",
            )
            .map_err(|error| {
                storage_error(
                    "Could not load query workspace",
                    "prepare workspace query",
                    error,
                )
            })?;
        statement
            .query_map([window_label], |row| {
                Ok(WorkspaceTab {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    title: row.get(2)?,
                    sql_text: row.get(3)?,
                    position: row.get(4)?,
                })
            })
            .and_then(Iterator::collect)
            .map_err(|error| {
                storage_error(
                    "Could not load query workspace",
                    "read workspace tabs",
                    error,
                )
            })
    }

    /// Atomically transfers one query tab between desktop windows.
    pub fn transfer_workspace_tab(
        &self,
        tab: &WorkspaceTab,
        source_window_label: &str,
        target_window_label: &str,
    ) -> Result<(), AppError> {
        let connection = self.connection()?;
        let updated = connection
            .execute(
                "INSERT INTO workspace_tabs (
                   id, connection_id, title, sql_text, position, window_label
                 ) VALUES (?1, ?2, ?3, ?4, 0, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   connection_id = excluded.connection_id,
                   title = excluded.title,
                   sql_text = excluded.sql_text,
                   position = 0,
                   window_label = excluded.window_label
                 WHERE workspace_tabs.window_label = ?6",
                params![
                    tab.id,
                    tab.connection_id,
                    tab.title,
                    tab.sql_text,
                    target_window_label,
                    source_window_label,
                ],
            )
            .map_err(|error| {
                storage_error(
                    "Could not move query workspace",
                    "transfer workspace tab",
                    error,
                )
            })?;
        if updated == 0 {
            return Err(AppError {
                code: AppErrorCode::NotFound,
                message: "Query workspace was not found in the source window".into(),
                technical_details: None,
                retryable: false,
            });
        }
        Ok(())
    }

    /// Lists non-main window labels that still own persisted query tabs.
    pub fn list_workspace_window_labels(&self) -> Result<Vec<String>, AppError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT DISTINCT window_label
                 FROM workspace_tabs
                 WHERE window_label <> 'main'
                 ORDER BY window_label ASC",
            )
            .map_err(|error| {
                storage_error(
                    "Could not list detached workspaces",
                    "prepare detached workspace query",
                    error,
                )
            })?;
        statement
            .query_map([], |row| row.get(0))
            .and_then(Iterator::collect)
            .map_err(|error| {
                storage_error(
                    "Could not list detached workspaces",
                    "read detached workspace labels",
                    error,
                )
            })
    }

    /// Records one query and retains only the 1,000 newest entries atomically.
    pub fn record_query_history(&self, entry: &QueryHistoryEntry) -> Result<(), AppError> {
        let mut connection = self.connection()?;
        let result = (|| -> rusqlite::Result<()> {
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT OR IGNORE INTO query_history (id, connection_id, sql_text, executed_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    entry.id,
                    entry.connection_id,
                    entry.sql_text,
                    format_timestamp(entry.executed_at),
                ],
            )?;
            transaction.execute(
                "DELETE FROM query_history
                 WHERE id IN (
                   SELECT id
                   FROM query_history
                   ORDER BY executed_at DESC, id DESC
                   LIMIT -1 OFFSET 1000
                 )",
                [],
            )?;
            transaction.commit()
        })();

        result.map_err(|error| {
            storage_error(
                "Could not record query history",
                "insert and trim query history",
                error,
            )
        })
    }

    /// Lists newest query history first, clamping the requested limit to 1 through 1,000.
    pub fn list_query_history(&self, limit: u32) -> Result<Vec<QueryHistoryEntry>, AppError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT id, connection_id, sql_text, executed_at
                 FROM query_history
                 ORDER BY executed_at DESC, id DESC
                 LIMIT ?1",
            )
            .map_err(|error| {
                storage_error(
                    "Could not load query history",
                    "prepare query history query",
                    error,
                )
            })?;
        statement
            .query_map([limit.clamp(1, 1_000)], |row| {
                let timestamp = row.get::<_, String>(3)?;
                Ok(QueryHistoryEntry {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    sql_text: row.get(2)?,
                    executed_at: parse_timestamp(timestamp).map_err(|value| {
                        SqlError::FromSqlConversionFailure(
                            3,
                            Type::Text,
                            Box::new(io::Error::new(
                                io::ErrorKind::InvalidData,
                                format!("invalid execution timestamp: {value}"),
                            )),
                        )
                    })?,
                })
            })
            .and_then(Iterator::collect)
            .map_err(|error| {
                storage_error(
                    "Could not load query history",
                    "read query history entries",
                    error,
                )
            })
    }
}

/// Formats UTC timestamps with fixed nanosecond precision for lexical ordering.
fn format_timestamp(timestamp: DateTime<Utc>) -> String {
    timestamp.format("%Y-%m-%dT%H:%M:%S%.9fZ").to_string()
}

/// Parses an RFC 3339 timestamp while preserving invalid input for diagnostics.
fn parse_timestamp(value: String) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(&value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|_| value)
}
