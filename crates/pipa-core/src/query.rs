use crate::AppError;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// A query execution request bound to a connection and stable query identifier.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QueryRequest {
    /// Identifier used to correlate all streaming events for this query.
    #[ts(type = "string")]
    pub query_id: Uuid,
    /// Identifier of the connection that executes the query.
    #[ts(type = "string")]
    pub connection_id: Uuid,
    /// SQL text to execute.
    pub sql: String,
    /// Optional Redis database selected for this execution.
    pub database: Option<String>,
}

/// Stable query context recorded after its matching backend execution starts.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecordQueryHistoryInput {
    /// Query identifier reused as the idempotent history-entry identifier.
    #[ts(type = "string")]
    pub query_id: Uuid,
    /// Immutable connection associated with the executing query tab.
    #[ts(type = "string")]
    pub connection_id: Uuid,
    /// Exact selected statement or editor selection sent for execution.
    pub sql: String,
}

/// Metadata for one column in a streamed result set.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QueryColumn {
    /// Column label reported by the database driver.
    pub name: String,
    /// Database-native type name.
    pub database_type: String,
    /// Database nullability when known.
    pub nullable: Option<bool>,
}

/// Lossless, transport-safe representation of a database cell.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
#[ts(export)]
pub enum CellValue {
    /// SQL NULL.
    Null,
    /// Boolean value.
    Boolean(bool),
    /// Integer encoded as a decimal string to avoid JavaScript precision loss.
    Integer(String),
    /// IEEE-754 floating-point value.
    Float(f64),
    /// Exact decimal encoded as a string.
    Decimal(String),
    /// UTF-8 text.
    Text(String),
    /// Structured JSON value.
    Json(serde_json::Value),
    /// Binary data encoded as a string by an adapter.
    Binary(String),
    /// Date or time value encoded as a string by an adapter.
    DateTime(String),
}

/// Ordered events emitted while a query executes.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum QueryEvent {
    /// Query execution started.
    Started {
        /// Identifier of the query producing this event.
        #[ts(type = "string")]
        query_id: Uuid,
    },
    /// Result-set column metadata became available.
    Schema {
        /// Identifier of the query producing this event.
        #[ts(type = "string")]
        query_id: Uuid,
        /// Ordered result-set columns.
        columns: Vec<QueryColumn>,
    },
    /// A batch of result rows became available.
    Batch {
        /// Identifier of the query producing this event.
        #[ts(type = "string")]
        query_id: Uuid,
        /// Rows whose cells correspond positionally to the schema.
        rows: Vec<Vec<CellValue>>,
    },
    /// Query execution completed normally.
    Completed {
        /// Identifier of the query producing this event.
        #[ts(type = "string")]
        query_id: Uuid,
        /// Rows affected by a statement that does not return rows.
        #[ts(type = "number")]
        affected_rows: u64,
    },
    /// Query execution was canceled.
    Canceled {
        /// Identifier of the query producing this event.
        #[ts(type = "string")]
        query_id: Uuid,
    },
    /// Query execution failed.
    Failed {
        /// Identifier of the query producing this event.
        #[ts(type = "string")]
        query_id: Uuid,
        /// Stable execution error.
        error: AppError,
    },
}

#[cfg(test)]
mod tests {
    use super::{CellValue, QueryColumn, QueryEvent, QueryRequest, RecordQueryHistoryInput};
    use crate::{AppError, AppErrorCode};
    use ts_rs::{Config, TS};
    use uuid::Uuid;

    /// Verifies that query events expose a stable tagged JSON contract.
    #[test]
    fn query_event_uses_tagged_snake_case_json() {
        let event = QueryEvent::Completed {
            query_id: Uuid::nil(),
            affected_rows: 3,
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "type": "completed",
                "queryId": "00000000-0000-0000-0000-000000000000",
                "affectedRows": 3
            })
        );
    }

    /// Verifies that integers beyond JavaScript's safe range remain lossless.
    #[test]
    fn integer_cells_remain_lossless_strings() {
        let cell = CellValue::Integer("9007199254740993".into());

        assert!(serde_json::to_string(&cell)
            .unwrap()
            .contains("9007199254740993"));
    }

    /// Verifies that every streaming event carries its query identifier.
    #[test]
    fn every_query_event_carries_query_id() {
        let query_id = Uuid::nil();
        let events = [
            QueryEvent::Started { query_id },
            QueryEvent::Schema {
                query_id,
                columns: vec![QueryColumn {
                    name: "id".into(),
                    database_type: "BIGINT".into(),
                    nullable: Some(false),
                }],
            },
            QueryEvent::Batch {
                query_id,
                rows: vec![vec![CellValue::Null]],
            },
            QueryEvent::Completed {
                query_id,
                affected_rows: 0,
            },
            QueryEvent::Canceled { query_id },
            QueryEvent::Failed {
                query_id,
                error: AppError {
                    code: AppErrorCode::Query,
                    message: "Invalid query".into(),
                    technical_details: None,
                    retryable: false,
                },
            },
        ];

        for event in events {
            assert_eq!(
                serde_json::to_value(event).unwrap()["queryId"],
                query_id.to_string()
            );
        }
    }

    /// Verifies that every TypeScript query-event variant carries queryId.
    #[test]
    fn query_event_typescript_contract_carries_query_ids() {
        let declaration = QueryEvent::decl(&Config::default());

        assert_eq!(declaration.matches("queryId: string").count(), 6);
        assert!(declaration.contains("\"type\": \"completed\""));
    }

    /// Verifies that JSON numeric affected-row counts are numeric in TypeScript.
    #[test]
    fn query_event_typescript_contract_uses_number_for_affected_rows() {
        let declaration = QueryEvent::decl(&Config::default());

        assert!(declaration.contains("affectedRows: number"));
    }

    /// Verifies one Redis execution may carry a transient logical database selection.
    #[test]
    fn query_request_serializes_redis_database_context() {
        let request = QueryRequest {
            query_id: Uuid::nil(),
            connection_id: Uuid::nil(),
            sql: "SCAN 0".into(),
            database: Some("2".into()),
        };

        assert_eq!(
            serde_json::to_value(request).unwrap()["database"],
            serde_json::json!("2")
        );
    }

    /// Verifies the history command accepts only the stable run context and executed SQL.
    #[test]
    fn history_input_contract_excludes_transient_and_secret_fields() {
        let input = RecordQueryHistoryInput {
            query_id: Uuid::nil(),
            connection_id: Uuid::nil(),
            sql: "SELECT 1".into(),
        };

        let json = serde_json::to_value(input).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "queryId": "00000000-0000-0000-0000-000000000000",
                "connectionId": "00000000-0000-0000-0000-000000000000",
                "sql": "SELECT 1"
            })
        );
        assert!(!json.to_string().contains("password"));
        assert!(!json.to_string().contains("rows"));
        let declaration = RecordQueryHistoryInput::decl(&Config::default());
        assert!(declaration.contains("queryId: string"));
        assert!(declaration.contains("connectionId: string"));
        assert!(declaration.contains("sql: string"));
    }
}
