use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// One exact value supplied to a parameterized MySQL table mutation.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
#[ts(export)]
pub enum TableMutationValue {
    /// SQL NULL.
    Null,
    /// Boolean value.
    Boolean(bool),
    /// Validated signed or unsigned integer text.
    Integer(String),
    /// Validated finite floating-point text.
    Float(String),
    /// Validated exact decimal text.
    Decimal(String),
    /// UTF-8 text.
    Text(String),
    /// Raw JSON text retained without a JavaScript parse round trip.
    Json(String),
    /// Base64-encoded opaque bytes.
    Binary(String),
    /// MySQL date or time text.
    DateTime(String),
}

/// One named column and its separately bound mutation value.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TableMutationField {
    /// Existing target column name.
    pub name: String,
    /// Value that must never be interpolated into SQL text.
    pub value: TableMutationValue,
}

/// One table mutation executed inside the request-wide transaction.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum TableMutation {
    /// Updates selected fields after locking exactly one original key.
    Update {
        /// Original primary-key fields used to locate the row.
        key: Vec<TableMutationField>,
        /// Changed fields and their new values.
        values: Vec<TableMutationField>,
    },
    /// Deletes exactly one row after locking its original key.
    Delete {
        /// Original primary-key fields used to locate the row.
        key: Vec<TableMutationField>,
    },
    /// Inserts one row; omitted columns retain their database defaults.
    Insert {
        /// Explicit column values. An empty list requests all defaults.
        values: Vec<TableMutationField>,
    },
}

/// Connection-bound request for an atomic group of typed table mutations.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApplyTableMutationsInput {
    /// Saved MySQL connection identifier.
    #[ts(type = "string")]
    pub connection_id: Uuid,
    /// Database selected by the table workspace.
    pub database: String,
    /// Table selected by the table workspace.
    pub table: String,
    /// Ordered mutations committed or rolled back together.
    pub mutations: Vec<TableMutation>,
}

/// Result returned only after every typed mutation commits.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApplyTableMutationsResult {
    /// Number of mutation operations committed.
    #[ts(type = "number")]
    pub applied_mutations: u32,
    /// Sum of MySQL-reported affected rows.
    #[ts(type = "number")]
    pub affected_rows: u64,
}

#[cfg(test)]
mod tests {
    use super::{ApplyTableMutationsInput, TableMutation, TableMutationField, TableMutationValue};
    use ts_rs::{Config, TS};
    use uuid::Uuid;

    /// Verifies mutation values remain tagged and values stay outside SQL text.
    #[test]
    fn mutation_contract_serializes_typed_values() {
        let input = ApplyTableMutationsInput {
            connection_id: Uuid::nil(),
            database: "shop".into(),
            table: "orders".into(),
            mutations: vec![TableMutation::Update {
                key: vec![TableMutationField {
                    name: "id".into(),
                    value: TableMutationValue::Integer("18446744073709551615".into()),
                }],
                values: vec![TableMutationField {
                    name: "note".into(),
                    value: TableMutationValue::Text("C:\\new\\O'Reilly".into()),
                }],
            }],
        };

        let json = serde_json::to_value(input).unwrap();
        assert_eq!(json["mutations"][0]["type"], "update");
        assert_eq!(
            json["mutations"][0]["values"][0]["value"]["value"],
            "C:\\new\\O'Reilly"
        );
        assert!(!json.to_string().contains("UPDATE"));
    }

    /// Verifies generated TypeScript keeps the discriminated mutation contract.
    #[test]
    fn mutation_typescript_contract_is_discriminated() {
        let declaration = TableMutation::decl(&Config::default());

        assert!(declaration.contains("\"type\": \"update\""));
        assert!(declaration.contains("key: Array<TableMutationField>"));
        assert!(declaration.contains("values: Array<TableMutationField>"));
    }
}
