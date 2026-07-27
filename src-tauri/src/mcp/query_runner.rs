//! Collecting MySQL query execution for MCP tools and confirmed proposals.

use pipa_core::{
    classify_sql, mcp_may_execute, AppError, AppErrorCode, CellValue, DatabaseAdapter, Engine,
    ExecutionSource, QueryColumn, QueryEvent, QueryRequest, SqlRisk,
};
use pipa_mysql::MySqlAdapter;
use pipa_store::LocalStore;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::types::MCP_READONLY_ROW_LIMIT;

/// Truncated query outcome suitable for MCP tool responses and activity logs.
#[derive(Clone, Debug)]
pub struct CollectedQueryResult {
    /// Column metadata when a result set was produced.
    pub columns: Vec<QueryColumn>,
    /// Collected rows (already truncated).
    pub rows: Vec<Vec<CellValue>>,
    /// True when more rows existed beyond the limit.
    pub truncated: bool,
    /// Rows affected for non-result statements.
    pub affected_rows: u64,
    /// Optional failure message.
    pub error: Option<String>,
}

impl CollectedQueryResult {
    /// Builds a JSON-friendly summary without dumping huge payloads.
    pub fn to_summary_json(&self) -> Value {
        if let Some(error) = &self.error {
            return json!({
                "ok": false,
                "error": error,
            });
        }
        let columns: Vec<&str> = self
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect();
        let rows: Vec<Vec<Value>> = self
            .rows
            .iter()
            .map(|row| row.iter().map(cell_to_json).collect())
            .collect();
        json!({
            "ok": true,
            "columns": columns,
            "rows": rows,
            "rowCount": rows.len(),
            "truncated": self.truncated,
            "affectedRows": self.affected_rows,
        })
    }

    /// Short one-line summary for activity logs.
    pub fn short_detail(&self) -> String {
        if let Some(error) = &self.error {
            return error.clone();
        }
        if self.columns.is_empty() {
            format!("affected_rows={}", self.affected_rows)
        } else {
            format!(
                "rows={}{}",
                self.rows.len(),
                if self.truncated { " (truncated)" } else { "" }
            )
        }
    }
}

/// Executes SQL through the MySQL adapter after applying the execution-source policy.
pub async fn execute_collected(
    local_store: Arc<LocalStore>,
    mysql: Arc<MySqlAdapter>,
    connection_id: Uuid,
    sql: &str,
    source: ExecutionSource,
    row_limit: usize,
) -> Result<CollectedQueryResult, AppError> {
    if source == ExecutionSource::Mcp {
        if let Err(blocked) = mcp_may_execute(sql) {
            return Err(AppError {
                code: AppErrorCode::Permission,
                message: format!(
                    "MCP cannot auto-execute {} SQL; use propose_sql and confirm in Pipa",
                    risk_label(blocked)
                ),
                technical_details: Some(format!("risk={blocked:?}")),
                retryable: false,
            });
        }
    }
    let _ = classify_sql(sql);

    let profile = local_store
        .list_connections()?
        .into_iter()
        .find(|profile| profile.id == connection_id)
        .ok_or_else(|| AppError {
            code: AppErrorCode::NotFound,
            message: "Database connection was not found".into(),
            technical_details: None,
            retryable: false,
        })?;

    if !matches!(profile.engine, Engine::MySql) {
        return Err(AppError {
            code: AppErrorCode::Validation,
            message: "MCP query execution currently supports MySQL connections only".into(),
            technical_details: Some(format!("engine={:?}", profile.engine)),
            retryable: false,
        });
    }

    let password = local_store.get_connection_credential(connection_id)?;
    let query_id = Uuid::new_v4();
    let request = QueryRequest {
        query_id,
        connection_id,
        sql: sql.to_owned(),
        database: None,
    };
    let cancellation = CancellationToken::new();
    let task_cancellation = cancellation.clone();
    let (event_sender, mut event_receiver) = mpsc::channel(8);
    let profile_clone = profile.clone();
    tokio::spawn(async move {
        let result = match source {
            ExecutionSource::Mcp => {
                mysql
                    .query_readonly(
                        &profile_clone,
                        password,
                        request,
                        event_sender.clone(),
                        task_cancellation,
                    )
                    .await
            }
            ExecutionSource::Ui => {
                mysql
                    .query(
                        &profile_clone,
                        password,
                        request,
                        event_sender.clone(),
                        task_cancellation,
                    )
                    .await
            }
        };
        if let Err(error) = result {
            let _ = event_sender
                .send(QueryEvent::Failed { query_id, error })
                .await;
        }
    });

    Ok(collect_query_events(&mut event_receiver, cancellation, row_limit).await)
}

/// Collects query events, canceling the database stream as soon as one row exceeds the limit.
async fn collect_query_events(
    event_receiver: &mut mpsc::Receiver<QueryEvent>,
    cancellation: CancellationToken,
    row_limit: usize,
) -> CollectedQueryResult {
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut canceled_for_limit = false;
    let mut affected_rows = 0_u64;
    let mut error = None;

    while let Some(event) = event_receiver.recv().await {
        match event {
            QueryEvent::Started { .. } => {}
            QueryEvent::Schema {
                columns: schema, ..
            } => {
                columns = schema;
            }
            QueryEvent::Batch {
                rows: batch_rows, ..
            } => {
                for row in batch_rows {
                    if rows.len() >= row_limit {
                        truncated = true;
                        canceled_for_limit = true;
                        cancellation.cancel();
                        break;
                    }
                    rows.push(row);
                }
            }
            QueryEvent::Completed {
                affected_rows: affected,
                ..
            } => {
                affected_rows = affected;
                break;
            }
            QueryEvent::Canceled { .. } => {
                if !canceled_for_limit {
                    error = Some("Query was canceled".into());
                }
                break;
            }
            QueryEvent::Failed {
                error: app_error, ..
            } => {
                error = Some(app_error.message);
                break;
            }
        }
    }

    CollectedQueryResult {
        columns,
        rows,
        truncated,
        affected_rows,
        error,
    }
}

/// Executes a readonly MCP query with the standard row limit.
pub async fn execute_readonly_mcp(
    local_store: Arc<LocalStore>,
    mysql: Arc<MySqlAdapter>,
    connection_id: Uuid,
    sql: &str,
) -> Result<CollectedQueryResult, AppError> {
    execute_collected(
        local_store,
        mysql,
        connection_id,
        sql,
        ExecutionSource::Mcp,
        MCP_READONLY_ROW_LIMIT,
    )
    .await
}

fn cell_to_json(cell: &CellValue) -> Value {
    match cell {
        CellValue::Null => Value::Null,
        CellValue::Boolean(value) => json!(value),
        CellValue::Integer(value)
        | CellValue::Decimal(value)
        | CellValue::Text(value)
        | CellValue::Binary(value)
        | CellValue::DateTime(value) => json!(value),
        CellValue::Float(value) => json!(value),
        CellValue::Json(value) => value.clone(),
    }
}

fn risk_label(risk: SqlRisk) -> &'static str {
    match risk {
        SqlRisk::Read => "read",
        SqlRisk::WriteData => "write",
        SqlRisk::SchemaChange => "schema-change",
        SqlRisk::Unknown => "unknown/unsafe",
    }
}

/// Escapes a MySQL identifier with backticks.
pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

#[cfg(test)]
mod tests {
    use super::collect_query_events;
    use pipa_core::{CellValue, QueryEvent};
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    /// Verifies the collector stops the producer after the first row beyond the cap.
    #[tokio::test]
    async fn row_limit_cancels_upstream_without_reporting_an_error() {
        let query_id = Uuid::new_v4();
        let cancellation = CancellationToken::new();
        let producer_cancellation = cancellation.clone();
        let (sender, mut receiver) = mpsc::channel(2);
        let producer = tokio::spawn(async move {
            let rows = (0..256)
                .map(|value| vec![CellValue::Integer(value.to_string())])
                .collect();
            sender
                .send(QueryEvent::Batch { query_id, rows })
                .await
                .unwrap();
            producer_cancellation.cancelled().await;
            sender
                .send(QueryEvent::Canceled { query_id })
                .await
                .unwrap();
        });

        let result = collect_query_events(&mut receiver, cancellation.clone(), 200).await;

        producer.await.unwrap();
        assert!(cancellation.is_cancelled());
        assert_eq!(result.rows.len(), 200);
        assert!(result.truncated);
        assert!(result.error.is_none());
    }
}
