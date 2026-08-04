use crate::adapter::{create_pool, map_connection_error, map_query_error};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use bigdecimal::BigDecimal;
use pipa_core::{
    AppError, AppErrorCode, ApplyTableMutationsInput, ApplyTableMutationsResult, ConnectionProfile,
    Engine, TableMutation, TableMutationField, TableMutationValue,
};
use secrecy::{ExposeSecret, SecretString};
use sqlx_core::{query_builder::QueryBuilder, row::Row};
use sqlx_mysql::{MySql, MySqlQueryResult, MySqlTransaction};
use std::{collections::HashSet, str::FromStr};

const MAX_MUTATIONS_PER_REQUEST: usize = 1_000;
const STRICT_SQL_MODE_STATEMENT: &str =
    "SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES')";

/// Applies validated table mutations atomically, rolling back every operation on any conflict.
pub(crate) async fn apply_table_mutations(
    profile: &ConnectionProfile,
    password: SecretString,
    input: ApplyTableMutationsInput,
) -> Result<ApplyTableMutationsResult, AppError> {
    validate_input(profile, &input)?;
    let applied_mutations = u32::try_from(input.mutations.len())
        .map_err(|_| validation_error("Too many table mutations"))?;
    let pool = create_pool(profile, &password);
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| map_connection_error(&error, password.expose_secret()))?;

    let execution = async {
        enable_strict_sql_mode(&mut transaction).await?;
        ensure_transactional_target(&mut transaction, &input).await?;
        execute_mutations(&mut transaction, &input).await
    }
    .await;
    match execution {
        Ok(affected_rows) => {
            transaction
                .commit()
                .await
                .map_err(|error| map_query_error(&error, password.expose_secret()))?;
            Ok(ApplyTableMutationsResult {
                applied_mutations,
                affected_rows,
            })
        }
        Err(error) => {
            let _rollback_result = transaction.rollback().await;
            Err(match error {
                MutationExecutionError::Application(error) => error,
                MutationExecutionError::Database(error) => {
                    map_query_error(&error, password.expose_secret())
                }
            })
        }
    }
}

/// Enables strict conversion errors so permissive server defaults cannot truncate staged values.
async fn enable_strict_sql_mode(
    transaction: &mut MySqlTransaction<'_>,
) -> Result<(), MutationExecutionError> {
    let mut builder = QueryBuilder::<MySql>::new(STRICT_SQL_MODE_STATEMENT);
    builder.build().execute(&mut **transaction).await?;
    Ok(())
}

/// Holds a metadata lock and rejects views or storage engines that cannot roll back the batch.
async fn ensure_transactional_target(
    transaction: &mut MySqlTransaction<'_>,
    input: &ApplyTableMutationsInput,
) -> Result<(), MutationExecutionError> {
    let target = quoted_target(&input.database, &input.table);
    let mut lock_builder =
        QueryBuilder::<MySql>::new(format!("SELECT 1 FROM {target} LIMIT 0 FOR UPDATE"));
    lock_builder
        .build()
        .fetch_optional(&mut **transaction)
        .await?;

    let mut engine_builder = QueryBuilder::<MySql>::new(
        "SELECT e.TRANSACTIONS FROM INFORMATION_SCHEMA.TABLES AS t \
         LEFT JOIN INFORMATION_SCHEMA.ENGINES AS e ON e.ENGINE = t.ENGINE \
         WHERE t.TABLE_SCHEMA = ",
    );
    engine_builder
        .push_bind(input.database.clone())
        .push(" AND t.TABLE_NAME = ")
        .push_bind(input.table.clone());
    let rows = engine_builder.build().fetch_all(&mut **transaction).await?;
    if rows.len() != 1 {
        return Err(MutationExecutionError::Application(conflict_error(
            "The staged table no longer exists",
        )));
    }
    let transactions = rows[0].try_get::<Option<String>, _>(0)?;
    if transactions.as_deref() != Some("YES") {
        return Err(MutationExecutionError::Application(validation_error(
            "Table mutations require a transactional storage engine",
        )));
    }
    Ok(())
}

/// Executes every prevalidated operation against an open transaction.
async fn execute_mutations(
    transaction: &mut MySqlTransaction<'_>,
    input: &ApplyTableMutationsInput,
) -> Result<u64, MutationExecutionError> {
    let target = quoted_target(&input.database, &input.table);
    let mut affected_rows = 0_u64;

    for mutation in &input.mutations {
        let result = match mutation {
            TableMutation::Update { key, values } => {
                lock_exact_row(transaction, &target, key).await?;
                execute_update(transaction, &target, key, values).await?
            }
            TableMutation::Delete { key } => {
                lock_exact_row(transaction, &target, key).await?;
                execute_delete(transaction, &target, key).await?
            }
            TableMutation::Insert { values } => {
                execute_insert(transaction, &target, values).await?
            }
        };
        if result.rows_affected() > 1 {
            return Err(MutationExecutionError::Application(conflict_error(
                "A staged table mutation matched more than one row",
            )));
        }
        affected_rows = affected_rows.saturating_add(result.rows_affected());
    }

    Ok(affected_rows)
}

/// Locks and verifies exactly one row before an update or delete.
async fn lock_exact_row(
    transaction: &mut MySqlTransaction<'_>,
    target: &str,
    key: &[TableMutationField],
) -> Result<(), MutationExecutionError> {
    let mut builder = QueryBuilder::<MySql>::new(format!("SELECT 1 FROM {target} WHERE "));
    push_predicate(&mut builder, key)?;
    builder.push(" LIMIT 2 FOR UPDATE");
    let rows = builder.build().fetch_all(&mut **transaction).await?;
    if rows.len() != 1 {
        return Err(MutationExecutionError::Application(conflict_error(
            "The staged row no longer exists or its key is not unique",
        )));
    }
    Ok(())
}

/// Executes one parameterized update after its original row has been locked.
async fn execute_update(
    transaction: &mut MySqlTransaction<'_>,
    target: &str,
    key: &[TableMutationField],
    values: &[TableMutationField],
) -> Result<MySqlQueryResult, MutationExecutionError> {
    let mut builder = QueryBuilder::<MySql>::new(format!("UPDATE {target} SET "));
    push_assignments(&mut builder, values)?;
    builder.push(" WHERE ");
    push_predicate(&mut builder, key)?;
    Ok(builder.build().execute(&mut **transaction).await?)
}

/// Executes one parameterized delete after its original row has been locked.
async fn execute_delete(
    transaction: &mut MySqlTransaction<'_>,
    target: &str,
    key: &[TableMutationField],
) -> Result<MySqlQueryResult, MutationExecutionError> {
    let mut builder = QueryBuilder::<MySql>::new(format!("DELETE FROM {target} WHERE "));
    push_predicate(&mut builder, key)?;
    Ok(builder.build().execute(&mut **transaction).await?)
}

/// Executes one parameterized insert while allowing omitted columns to use database defaults.
async fn execute_insert(
    transaction: &mut MySqlTransaction<'_>,
    target: &str,
    values: &[TableMutationField],
) -> Result<MySqlQueryResult, MutationExecutionError> {
    if values.is_empty() {
        let mut builder = QueryBuilder::<MySql>::new(format!("INSERT INTO {target} () VALUES ()"));
        return Ok(builder.build().execute(&mut **transaction).await?);
    }

    let mut builder = QueryBuilder::<MySql>::new(format!("INSERT INTO {target} ("));
    for (index, field) in values.iter().enumerate() {
        if index > 0 {
            builder.push(", ");
        }
        builder.push(quote_identifier(&field.name));
    }
    builder.push(") VALUES (");
    for (index, field) in values.iter().enumerate() {
        if index > 0 {
            builder.push(", ");
        }
        push_value(&mut builder, &field.value)?;
    }
    builder.push(")");
    Ok(builder.build().execute(&mut **transaction).await?)
}

/// Adds comma-separated assignments with every value represented by a bind placeholder.
fn push_assignments(
    builder: &mut QueryBuilder<MySql>,
    values: &[TableMutationField],
) -> Result<(), MutationExecutionError> {
    for (index, field) in values.iter().enumerate() {
        if index > 0 {
            builder.push(", ");
        }
        builder.push(quote_identifier(&field.name)).push(" = ");
        push_value(builder, &field.value)?;
    }
    Ok(())
}

/// Adds an AND-joined key predicate with NULL-aware bound values.
fn push_predicate(
    builder: &mut QueryBuilder<MySql>,
    key: &[TableMutationField],
) -> Result<(), MutationExecutionError> {
    for (index, field) in key.iter().enumerate() {
        if index > 0 {
            builder.push(" AND ");
        }
        builder.push(quote_identifier(&field.name));
        if matches!(&field.value, TableMutationValue::Null) {
            builder.push(" IS NULL");
        } else {
            builder.push(" = ");
            push_value(builder, &field.value)?;
        }
    }
    Ok(())
}

/// Adds one validated value as a bind parameter.
fn push_value(
    builder: &mut QueryBuilder<MySql>,
    value: &TableMutationValue,
) -> Result<(), MutationExecutionError> {
    match value {
        TableMutationValue::Null => {
            builder.push_bind(Option::<String>::None);
        }
        TableMutationValue::Boolean(value) => {
            builder.push_bind(*value);
        }
        TableMutationValue::Integer(value) => {
            let value = value.trim();
            if value.starts_with('-') {
                builder.push_bind(value.parse::<i64>().map_err(|_| invalid_value("integer"))?);
            } else {
                builder.push_bind(value.parse::<u64>().map_err(|_| invalid_value("integer"))?);
            }
        }
        TableMutationValue::Float(value) => {
            let value = value.trim();
            let parsed = value
                .parse::<f64>()
                .map_err(|_| invalid_value("floating-point"))?;
            if !parsed.is_finite() || (parsed == 0.0 && has_non_zero_mantissa(value)) {
                return Err(invalid_value("floating-point"));
            }
            builder.push_bind(parsed);
        }
        TableMutationValue::Decimal(value) => {
            builder.push_bind(
                BigDecimal::from_str(value.trim()).map_err(|_| invalid_value("decimal"))?,
            );
        }
        TableMutationValue::Text(value) | TableMutationValue::DateTime(value) => {
            builder.push_bind(value.clone());
        }
        TableMutationValue::Json(value) => {
            serde_json::from_str::<serde_json::Value>(value).map_err(|_| invalid_value("JSON"))?;
            builder.push_bind(value.clone());
        }
        TableMutationValue::Binary(value) => {
            builder.push_bind(
                STANDARD
                    .decode(value.trim())
                    .map_err(|_| invalid_value("base64 binary"))?,
            );
        }
    }
    Ok(())
}

/// Validates the immutable request shape before opening a database transaction.
fn validate_input(
    profile: &ConnectionProfile,
    input: &ApplyTableMutationsInput,
) -> Result<(), AppError> {
    if !matches!(profile.engine, Engine::MySql) {
        return Err(validation_error("Table mutations require a MySQL profile"));
    }
    if input.database.trim().is_empty() || input.table.trim().is_empty() {
        return Err(validation_error("Database and table names are required"));
    }
    if profile.id != input.connection_id {
        return Err(validation_error(
            "The mutation connection does not match the saved profile",
        ));
    }
    if profile.database.as_deref() != Some(input.database.as_str()) {
        return Err(validation_error(
            "The table database does not match the saved connection",
        ));
    }
    if input.mutations.is_empty() || input.mutations.len() > MAX_MUTATIONS_PER_REQUEST {
        return Err(validation_error(
            "A table commit must contain between 1 and 1000 mutations",
        ));
    }

    for mutation in &input.mutations {
        match mutation {
            TableMutation::Update { key, values } => {
                validate_fields(key, false)?;
                validate_fields(values, false)?;
            }
            TableMutation::Delete { key } => validate_fields(key, false)?,
            TableMutation::Insert { values } => validate_fields(values, true)?,
        }
    }
    Ok(())
}

/// Detects non-zero decimal mantissas after Rust floating-point parsing underflows to zero.
fn has_non_zero_mantissa(value: &str) -> bool {
    value
        .split(['e', 'E'])
        .next()
        .is_some_and(|mantissa| mantissa.bytes().any(|byte| matches!(byte, b'1'..=b'9')))
}

/// Rejects missing or duplicate dynamic identifiers before SQL construction.
fn validate_fields(fields: &[TableMutationField], allow_empty: bool) -> Result<(), AppError> {
    if fields.is_empty() && !allow_empty {
        return Err(validation_error("Mutation fields cannot be empty"));
    }
    let mut names = HashSet::with_capacity(fields.len());
    for field in fields {
        if field.name.trim().is_empty() || !names.insert(field.name.as_str()) {
            return Err(validation_error(
                "Mutation column names must be non-empty and unique",
            ));
        }
    }
    Ok(())
}

/// Produces a fully quoted MySQL database-table target from validated identifiers.
fn quoted_target(database: &str, table: &str) -> String {
    format!("{}.{}", quote_identifier(database), quote_identifier(table))
}

/// Escapes one MySQL identifier by doubling embedded backticks.
fn quote_identifier(identifier: &str) -> String {
    format!("`{}`", identifier.replace('`', "``"))
}

/// Builds a stable validation error without including cell contents.
fn validation_error(message: &str) -> AppError {
    AppError {
        code: AppErrorCode::Validation,
        message: message.into(),
        technical_details: None,
        retryable: false,
    }
}

/// Builds a stable optimistic-concurrency error that keeps the local change set retryable.
fn conflict_error(message: &str) -> AppError {
    AppError {
        code: AppErrorCode::Query,
        message: message.into(),
        technical_details: None,
        retryable: true,
    }
}

/// Wraps invalid typed values without exposing their content in diagnostics.
fn invalid_value(kind: &str) -> MutationExecutionError {
    MutationExecutionError::Application(validation_error(&format!(
        "A staged {kind} value is invalid"
    )))
}

/// Internal execution failures that distinguish safe application conflicts from SQLx errors.
#[derive(Debug)]
enum MutationExecutionError {
    /// Stable application-level validation or conflict error.
    Application(AppError),
    /// Driver error mapped and redacted at the adapter boundary.
    Database(sqlx_core::Error),
}

impl From<sqlx_core::Error> for MutationExecutionError {
    /// Preserves a driver error until the password-redacting adapter mapper is available.
    fn from(error: sqlx_core::Error) -> Self {
        Self::Database(error)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        push_assignments, push_predicate, push_value, quote_identifier, quoted_target,
        validate_input,
    };
    use pipa_core::{
        ApplyTableMutationsInput, ConnectionProfile, Engine, Environment, TableMutation,
        TableMutationField, TableMutationValue, TlsMode,
    };
    use sqlx_core::query_builder::QueryBuilder;
    use sqlx_mysql::MySql;
    use uuid::Uuid;

    /// Creates a MySQL profile fixed to the test database.
    fn profile() -> ConnectionProfile {
        ConnectionProfile {
            id: Uuid::nil(),
            name: "test".into(),
            engine: Engine::MySql,
            environment: Environment::Development,
            host: "127.0.0.1".into(),
            port: 3306,
            username: "test".into(),
            database: Some("shop".into()),
            tls_mode: TlsMode::Disabled,
        }
    }

    /// Verifies hostile identifiers remain inside doubled-backtick identifier tokens.
    #[test]
    fn identifiers_are_quoted_as_structure_only() {
        assert_eq!(quote_identifier("a`b"), "`a``b`");
        assert_eq!(
            quoted_target("shop`, mysql.user; --", "orders"),
            "`shop``, mysql.user; --`.`orders`"
        );
    }

    /// Verifies values containing quotes and backslashes produce placeholders, never SQL text.
    #[test]
    fn updates_use_bind_placeholders_for_all_values() {
        let key = [TableMutationField {
            name: "id".into(),
            value: TableMutationValue::Integer("1".into()),
        }];
        let values = [TableMutationField {
            name: "note".into(),
            value: TableMutationValue::Text("C:\\tmp\\'; DELETE FROM users; --".into()),
        }];
        let mut builder = QueryBuilder::<MySql>::new("UPDATE `shop`.`orders` SET ");
        push_assignments(&mut builder, &values).unwrap();
        builder.push(" WHERE ");
        push_predicate(&mut builder, &key).unwrap();
        let sql = builder.into_string();

        assert_eq!(sql, "UPDATE `shop`.`orders` SET `note` = ? WHERE `id` = ?");
        assert!(!sql.contains("DELETE"));
        assert!(!sql.contains("tmp"));
    }

    /// Verifies empty default-only inserts are accepted but unsafe update keys are rejected.
    #[test]
    fn validates_mutation_shapes_before_connecting() {
        let valid = ApplyTableMutationsInput {
            connection_id: Uuid::nil(),
            database: "shop".into(),
            table: "orders".into(),
            mutations: vec![TableMutation::Insert { values: vec![] }],
        };
        assert!(validate_input(&profile(), &valid).is_ok());

        let invalid = ApplyTableMutationsInput {
            mutations: vec![TableMutation::Update {
                key: vec![],
                values: vec![TableMutationField {
                    name: "name".into(),
                    value: TableMutationValue::Text("Pipa".into()),
                }],
            }],
            ..valid
        };
        assert!(validate_input(&profile(), &invalid).is_err());
    }

    /// Verifies a non-zero float cannot silently underflow to zero before binding.
    #[test]
    fn rejects_floating_point_underflow() {
        let mut builder = QueryBuilder::<MySql>::new("SELECT ");
        assert!(push_value(&mut builder, &TableMutationValue::Float("1e-4000".into())).is_err());

        let mut zero_builder = QueryBuilder::<MySql>::new("SELECT ");
        assert!(push_value(
            &mut zero_builder,
            &TableMutationValue::Float("0e-4000".into())
        )
        .is_ok());
    }
}
