use crate::AppError;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// 绑定连接和稳定查询标识符的一次查询执行请求。
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QueryRequest {
    /// 用于关联本次查询所有流式事件的标识符。
    #[ts(type = "string")]
    pub query_id: Uuid,
    /// 执行查询的连接标识符。
    #[ts(type = "string")]
    pub connection_id: Uuid,
    /// 要执行的 SQL 文本。
    pub sql: String,
    /// 本次执行可选的 Redis 数据库。
    pub database: Option<String>,
}

/// 对应后端执行开始后记录的稳定查询上下文。
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecordQueryHistoryInput {
    /// 同时作为幂等历史记录标识符使用的查询标识符。
    #[ts(type = "string")]
    pub query_id: Uuid,
    /// 与执行中查询标签页关联的不可变连接。
    #[ts(type = "string")]
    pub connection_id: Uuid,
    /// 发送执行的精确语句或编辑器选区。
    pub sql: String,
}

/// 流式结果集中单列的元数据。
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QueryColumn {
    /// 数据库驱动报告的列标签。
    pub name: String,
    /// 数据库原生类型名称。
    pub database_type: String,
    /// 已知时的数据库可空性。
    pub nullable: Option<bool>,
}

/// 数据库单元格的无损、传输安全表示。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
#[ts(export)]
pub enum CellValue {
    /// SQL NULL。
    Null,
    /// 布尔值。
    Boolean(bool),
    /// 编码为十进制字符串的整数，用于避免 JavaScript 精度损失。
    Integer(String),
    /// IEEE-754 浮点值。
    Float(f64),
    /// 编码为字符串的精确小数。
    Decimal(String),
    /// UTF-8 文本。
    Text(String),
    /// 结构化 JSON 值。
    Json(serde_json::Value),
    /// 由适配器编码为字符串的二进制数据。
    Binary(String),
    /// 由适配器编码为字符串的日期或时间值。
    DateTime(String),
}

/// 查询执行期间按顺序发出的事件。
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum QueryEvent {
    /// 查询开始执行。
    Started {
        /// 产生本事件的查询标识符。
        #[ts(type = "string")]
        query_id: Uuid,
    },
    /// 结果集列元数据已可用。
    Schema {
        /// 产生本事件的查询标识符。
        #[ts(type = "string")]
        query_id: Uuid,
        /// 按顺序排列的结果集列。
        columns: Vec<QueryColumn>,
    },
    /// 一批结果行已可用。
    Batch {
        /// 产生本事件的查询标识符。
        #[ts(type = "string")]
        query_id: Uuid,
        /// 单元格按位置与 schema 对应的结果行。
        rows: Vec<Vec<CellValue>>,
    },
    /// 查询正常执行完成。
    Completed {
        /// 产生本事件的查询标识符。
        #[ts(type = "string")]
        query_id: Uuid,
        /// 不返回结果行的语句所影响的行数。
        #[ts(type = "number")]
        affected_rows: u64,
    },
    /// 查询执行已取消。
    Canceled {
        /// 产生本事件的查询标识符。
        #[ts(type = "string")]
        query_id: Uuid,
    },
    /// 查询执行失败。
    Failed {
        /// 产生本事件的查询标识符。
        #[ts(type = "string")]
        query_id: Uuid,
        /// 稳定的执行错误。
        error: AppError,
    },
}

#[cfg(test)]
mod tests {
    use super::{CellValue, QueryColumn, QueryEvent, QueryRequest, RecordQueryHistoryInput};
    use crate::{AppError, AppErrorCode};
    use ts_rs::{Config, TS};
    use uuid::Uuid;

    /// 验证查询事件对外提供稳定的带标签 JSON 契约。
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

    /// 验证超出 JavaScript 安全范围的整数仍保持无损。
    #[test]
    fn integer_cells_remain_lossless_strings() {
        let cell = CellValue::Integer("9007199254740993".into());

        assert!(serde_json::to_string(&cell)
            .unwrap()
            .contains("9007199254740993"));
    }

    /// 验证每个流式事件都携带查询标识符。
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

    /// 验证每种 TypeScript 查询事件变体都携带 queryId。
    #[test]
    fn query_event_typescript_contract_carries_query_ids() {
        let declaration = QueryEvent::decl(&Config::default());

        assert_eq!(declaration.matches("queryId: string").count(), 6);
        assert!(declaration.contains("\"type\": \"completed\""));
    }

    /// 验证 JSON 数字形式的影响行数在 TypeScript 中仍为数值类型。
    #[test]
    fn query_event_typescript_contract_uses_number_for_affected_rows() {
        let declaration = QueryEvent::decl(&Config::default());

        assert!(declaration.contains("affectedRows: number"));
    }

    /// 验证一次 Redis 执行可携带临时的逻辑数据库选择。
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

    /// 验证历史记录命令只接受稳定运行上下文和已执行 SQL。
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
