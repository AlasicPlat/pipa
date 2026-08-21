//! Safe, reviewable reset SQL derived from decoded row images.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use bigdecimal::BigDecimal;
use pipa_core::{
    BinlogCell, BinlogChange, BinlogOperation, BinlogResetSql, BinlogTransaction,
    BinlogTransactionStatus, CellValue,
};
use std::{collections::BTreeMap, str::FromStr};

const MAX_RESET_STATEMENTS: usize = 10_000;
const MAX_RESET_WARNINGS: usize = 100;

/// Mutable output retained while row mutations are visited in reverse order.
#[derive(Default)]
struct ResetSqlBuilder {
    statements: Vec<String>,
    warnings: Vec<String>,
    warnings_truncated: bool,
}

impl ResetSqlBuilder {
    /// Adds one generated statement while enforcing the copy-size safety bound.
    fn push_statement(&mut self, statement: String) -> bool {
        if self.statements.len() >= MAX_RESET_STATEMENTS {
            self.push_warning(format!(
                "Reset SQL was truncated after {MAX_RESET_STATEMENTS} statements"
            ));
            return false;
        }
        self.statements.push(statement);
        true
    }

    /// Adds one safe diagnostic without allowing malformed logs to create unbounded feedback.
    fn push_warning(&mut self, warning: String) {
        if self.warnings.len() < MAX_RESET_WARNINGS {
            self.warnings.push(warning);
        } else if !self.warnings_truncated {
            self.warnings_truncated = true;
            self.warnings
                .push("Additional reset SQL warnings were omitted".into());
        }
    }
}

/// Generates reviewable MySQL statements that reverse one committed transaction projection.
///
/// # Parameters
/// `transaction` contains the ordered decoded row images selected by the caller.
///
/// # Returns
/// Statements in reverse mutation order plus explicit warnings for every unsafe row.
///
/// # Side effects
/// None. The generated SQL is never executed.
pub fn generate_transaction_reset_sql(transaction: &BinlogTransaction) -> BinlogResetSql {
    let mut builder = ResetSqlBuilder::default();
    if transaction.status != BinlogTransactionStatus::Committed {
        builder.push_warning(
            "Reset SQL is generated only for transactions with an observed commit boundary".into(),
        );
        return finish(transaction, builder);
    }

    if transaction.changes.is_empty() {
        builder.push_warning("The transaction contains no reversible row changes".into());
        return finish(transaction, builder);
    }

    'changes: for (change_index, change) in transaction.changes.iter().enumerate().rev() {
        if change.operation == BinlogOperation::Ddl {
            builder.push_warning(format!(
                "Skipped change {} because DDL cannot be reversed safely",
                change_index + 1
            ));
            continue;
        }
        if change.rows.is_empty() {
            builder.push_warning(format!(
                "Skipped change {} because it has no decoded row images",
                change_index + 1
            ));
            continue;
        }

        for (row_index, row) in change.rows.iter().enumerate().rev() {
            let result = match change.operation {
                BinlogOperation::Insert => reset_insert(change, row.after.as_ref()),
                BinlogOperation::Update => {
                    reset_update(change, row.before.as_ref(), row.after.as_ref())
                }
                BinlogOperation::Delete => reset_delete(change, row.before.as_ref()),
                BinlogOperation::Ddl => unreachable!("DDL is handled before row iteration"),
            };
            match result {
                Ok(statement) => {
                    if !builder.push_statement(statement) {
                        break 'changes;
                    }
                }
                Err(reason) => builder.push_warning(format!(
                    "Skipped change {} row {}: {reason}",
                    change_index + 1,
                    row_index + 1
                )),
            }
        }
    }

    if builder.statements.is_empty() && builder.warnings.is_empty() {
        builder.push_warning("The transaction contains no reversible row changes".into());
    }
    finish(transaction, builder)
}

/// Finalizes SQL comments and the transport result without including row values in warnings.
fn finish(transaction: &BinlogTransaction, builder: ResetSqlBuilder) -> BinlogResetSql {
    let ResetSqlBuilder {
        statements,
        warnings,
        ..
    } = builder;
    let statement_count = statements.len() as u64;
    let complete = statement_count > 0 && warnings.is_empty();
    let sql = if statements.is_empty() {
        String::new()
    } else {
        let mut lines = vec![
            format!(
                "-- Pipa Reset SQL for transaction {}",
                transaction.sequence
            ),
            "-- Review before execution. MySQL row events do not identify primary keys; predicates use every reconstructed current value.".into(),
        ];
        lines.extend(
            warnings
                .iter()
                .map(|warning| format!("-- WARNING: {warning}")),
        );
        lines.push(String::new());
        lines.extend(statements);
        lines.join("\n")
    };
    BinlogResetSql {
        sql,
        statement_count,
        complete,
        warnings,
    }
}

/// Reverses an original INSERT with a single-row DELETE predicate.
fn reset_insert(
    change: &BinlogChange,
    after: Option<&BTreeMap<String, BinlogCell>>,
) -> Result<String, &'static str> {
    let table = qualified_table(change)?;
    let after = after.ok_or("the INSERT after image is missing")?;
    let predicates = predicate_values(change, after, false)?;
    Ok(format!(
        "DELETE FROM {table} WHERE {} LIMIT 1;",
        predicates.join(" AND ")
    ))
}

/// Reverses an original UPDATE by restoring before values and locating the current row image.
fn reset_update(
    change: &BinlogChange,
    before: Option<&BTreeMap<String, BinlogCell>>,
    after: Option<&BTreeMap<String, BinlogCell>>,
) -> Result<String, &'static str> {
    let table = qualified_table(change)?;
    let before = before.ok_or("the UPDATE before image is missing")?;
    let after = after.ok_or("the UPDATE after image is missing")?;
    reject_unusable_logged_cells(before)?;
    reject_unusable_logged_cells(after)?;

    for column in &change.columns {
        let after_cell = after.get(column);
        if is_recorded(after_cell) && !is_sql_value(before.get(column)) {
            return Err("a changed column is missing its restorable before value");
        }
    }

    let assignments = ordered_values(change, before, false)?
        .into_iter()
        .map(|(column, value)| format!("{} = {value}", quote_identifier(column)))
        .collect::<Vec<_>>();
    if assignments.is_empty() {
        return Err("the UPDATE before image has no restorable values");
    }

    let mut current = BTreeMap::new();
    for (column, cell) in before {
        if is_sql_value(Some(cell)) {
            current.insert(column.clone(), cell.clone());
        }
    }
    for (column, cell) in after {
        if is_sql_value(Some(cell)) {
            current.insert(column.clone(), cell.clone());
        }
    }
    let predicates = predicate_values(change, &current, false)?;
    Ok(format!(
        "UPDATE {table} SET {} WHERE {} LIMIT 1;",
        assignments.join(", "),
        predicates.join(" AND ")
    ))
}

/// Reverses an original DELETE with an INSERT built from its complete before image.
fn reset_delete(
    change: &BinlogChange,
    before: Option<&BTreeMap<String, BinlogCell>>,
) -> Result<String, &'static str> {
    let table = qualified_table(change)?;
    let before = before.ok_or("the DELETE before image is missing")?;
    let values = ordered_values(change, before, true)?;
    if values.is_empty() {
        return Err("the DELETE before image has no restorable values");
    }
    let columns = values
        .iter()
        .map(|(column, _)| quote_identifier(column))
        .collect::<Vec<_>>();
    let literals = values
        .into_iter()
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    Ok(format!(
        "INSERT INTO {table} ({}) VALUES ({});",
        columns.join(", "),
        literals.join(", ")
    ))
}

/// Produces an exact quoted database/table reference or refuses unknown attribution.
fn qualified_table(change: &BinlogChange) -> Result<String, &'static str> {
    if change.database.is_empty() || change.table.is_empty() {
        return Err("the database or table name is unknown");
    }
    Ok(format!(
        "{}.{}",
        quote_identifier(&change.database),
        quote_identifier(&change.table)
    ))
}

/// Converts one row image to ordered SQL literals, optionally requiring every column.
fn ordered_values<'a>(
    change: &'a BinlogChange,
    image: &'a BTreeMap<String, BinlogCell>,
    require_complete: bool,
) -> Result<Vec<(&'a str, String)>, &'static str> {
    reject_unusable_logged_cells(image)?;
    let mut values = Vec::new();
    for column in &change.columns {
        if placeholder_column(column) {
            if require_complete || is_recorded(image.get(column)) {
                return Err("the binlog does not contain real column names");
            }
            continue;
        }
        match image.get(column) {
            Some(BinlogCell::NotLogged) | None if require_complete => {
                return Err("the row image is incomplete")
            }
            Some(BinlogCell::NotLogged) | None => {}
            Some(cell) => values.push((column.as_str(), cell_literal(cell)?)),
        }
    }
    Ok(values)
}

/// Builds MySQL NULL-safe predicates from every usable value in one current row image.
fn predicate_values(
    change: &BinlogChange,
    image: &BTreeMap<String, BinlogCell>,
    require_complete: bool,
) -> Result<Vec<String>, &'static str> {
    let predicates = ordered_values(change, image, require_complete)?
        .into_iter()
        .map(|(column, value)| format!("{} <=> {value}", quote_identifier(column)))
        .collect::<Vec<_>>();
    if predicates.is_empty() {
        return Err("the current row image has no values usable as a predicate");
    }
    Ok(predicates)
}

/// Rejects decoded-error or partial cells because they cannot round-trip through SQL.
fn reject_unusable_logged_cells(image: &BTreeMap<String, BinlogCell>) -> Result<(), &'static str> {
    if image.values().any(|cell| {
        matches!(
            cell,
            BinlogCell::DecodeError { .. } | BinlogCell::Partial { .. }
        )
    }) {
        return Err("a logged column could not be decoded completely");
    }
    Ok(())
}

/// Returns whether a row-image cell was present in the physical event.
fn is_recorded(cell: Option<&BinlogCell>) -> bool {
    cell.is_some_and(|cell| !matches!(cell, BinlogCell::NotLogged))
}

/// Returns whether a cell can be serialized into an exact SQL literal.
fn is_sql_value(cell: Option<&BinlogCell>) -> bool {
    matches!(
        cell,
        Some(BinlogCell::Null | BinlogCell::Value { .. } | BinlogCell::UnixTimestamp { .. })
    )
}

/// Identifies parser placeholders that are not valid source column metadata.
fn placeholder_column(column: &str) -> bool {
    column.strip_prefix('@').is_some_and(|suffix| {
        !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
    })
}

/// Escapes a MySQL identifier by doubling embedded backticks.
fn quote_identifier(identifier: &str) -> String {
    format!("`{}`", identifier.replace('`', "``"))
}

/// Serializes one decoded cell without relying on connection SQL modes.
fn cell_literal(cell: &BinlogCell) -> Result<String, &'static str> {
    match cell {
        BinlogCell::Null => Ok("NULL".into()),
        BinlogCell::Value { value } => value_literal(value),
        BinlogCell::UnixTimestamp { value } => unix_timestamp_literal(value),
        BinlogCell::NotLogged => Err("the row image is incomplete"),
        BinlogCell::DecodeError { .. } | BinlogCell::Partial { .. } => {
            Err("a logged column could not be decoded completely")
        }
    }
}

/// Converts exact Unix seconds back through MySQL's TIMESTAMP-aware session semantics.
fn unix_timestamp_literal(value: &str) -> Result<String, &'static str> {
    let value = value.trim();
    let parsed = BigDecimal::from_str(value)
        .map_err(|_| "a TIMESTAMP value is not valid decimal Unix seconds")?;
    if parsed < 0 {
        return Err("a TIMESTAMP value is not valid decimal Unix seconds");
    }
    Ok(format!("FROM_UNIXTIME({value})"))
}

/// Serializes one lossless value using validated numerics, quoted text, and binary literals.
fn value_literal(value: &CellValue) -> Result<String, &'static str> {
    match value {
        CellValue::Null => Ok("NULL".into()),
        CellValue::Boolean(value) => Ok(if *value { "1" } else { "0" }.into()),
        CellValue::Integer(value) | CellValue::Decimal(value) => BigDecimal::from_str(value.trim())
            .map(|_| value.trim().to_owned())
            .map_err(|_| "a numeric value is not valid MySQL syntax"),
        CellValue::Float(value) if value.is_finite() => Ok(value.to_string()),
        CellValue::Float(_) => Err("a floating-point value is not finite"),
        CellValue::Text(value) | CellValue::DateTime(value) => Ok(quoted_string(value)),
        CellValue::Json(value) => Ok(quoted_string(value)),
        CellValue::Binary(value) => STANDARD
            .decode(value)
            .map(|bytes| format!("X'{}'", hex(&bytes)))
            .map_err(|_| "a binary value is not valid base64"),
    }
}

/// 将文本编码为可读的 MySQL 字符串字面量。
///
/// `value` 是待写入的原始文本；返回值会双写单引号和反斜杠，不修改其他字符。
/// 此函数无副作用。
fn quoted_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

/// Encodes bytes as uppercase hexadecimal without adding an extra dependency.
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{generate_transaction_reset_sql, quoted_string};
    use pipa_core::{
        BinlogCell, BinlogChange, BinlogOperation, BinlogRowChange, BinlogTableConfidence,
        BinlogTransaction, BinlogTransactionStatus, CellValue,
    };
    use std::collections::BTreeMap;

    /// Creates one decoded value cell for compact row fixtures.
    fn text(value: &str) -> BinlogCell {
        BinlogCell::Value {
            value: CellValue::Text(value.into()),
        }
    }

    /// Creates one transaction whose changes can be replaced by each focused test.
    fn transaction(changes: Vec<BinlogChange>) -> BinlogTransaction {
        BinlogTransaction {
            id: "analysis:1".into(),
            sequence: 1,
            timestamp: "2026-01-01T00:00:00Z".into(),
            gtid: None,
            xid: Some("9".into()),
            server_id: 1,
            file_name: "mysql-bin.000001".into(),
            start_position: 4,
            end_position: 200,
            status: BinlogTransactionStatus::Committed,
            row_change_count: 1,
            tables: Vec::new(),
            changes,
        }
    }

    /// Creates one exact row change with stable column order.
    fn change(
        operation: BinlogOperation,
        before: Option<BTreeMap<String, BinlogCell>>,
        after: Option<BTreeMap<String, BinlogCell>>,
    ) -> BinlogChange {
        BinlogChange {
            database: "shop".into(),
            table: "orders".into(),
            operation,
            row_count: 1,
            columns: vec!["id".into(), "status".into(), "note".into()],
            rows: vec![BinlogRowChange { before, after }],
            table_confidence: BinlogTableConfidence::Exact,
            sql: None,
        }
    }

    /// Verifies UPDATE reset SQL restores before values and matches reconstructed current values.
    #[test]
    fn update_restores_before_image_with_null_safe_predicates() {
        let before = BTreeMap::from([
            (
                "id".into(),
                BinlogCell::Value {
                    value: CellValue::Integer("7".into()),
                },
            ),
            ("status".into(), text("pending")),
            ("note".into(), BinlogCell::Null),
        ]);
        let after = BTreeMap::from([
            ("id".into(), BinlogCell::NotLogged),
            ("status".into(), text("paid")),
            ("note".into(), BinlogCell::NotLogged),
        ]);

        let output = generate_transaction_reset_sql(&transaction(vec![change(
            BinlogOperation::Update,
            Some(before),
            Some(after),
        )]));

        assert!(output.complete);
        assert_eq!(output.statement_count, 1);
        assert!(output
            .sql
            .contains("UPDATE `shop`.`orders` SET `id` = 7, `status` = 'pending', `note` = NULL"));
        assert!(output.sql.contains("`id` <=> 7"));
        assert!(output.sql.contains("`status` <=> 'paid'"));
    }

    /// 验证 Reset SQL 的文本保持可读，并安全转义引号和反斜杠。
    #[test]
    fn text_literals_are_quoted_without_hex_conversion() {
        assert_eq!(quoted_string("O'Reilly\\archive"), "'O''Reilly\\\\archive'");
    }

    /// Verifies INSERT and DELETE are inverted and transaction order is reversed.
    #[test]
    fn insert_and_delete_are_inverted_in_reverse_order() {
        let row = BTreeMap::from([
            (
                "id".into(),
                BinlogCell::Value {
                    value: CellValue::Integer("7".into()),
                },
            ),
            ("status".into(), text("paid")),
            ("note".into(), BinlogCell::Null),
        ]);
        let output = generate_transaction_reset_sql(&transaction(vec![
            change(BinlogOperation::Insert, None, Some(row.clone())),
            change(BinlogOperation::Delete, Some(row), None),
        ]));

        assert!(output.complete);
        assert_eq!(output.statement_count, 2);
        let insert_position = output.sql.find("INSERT INTO").unwrap();
        let delete_position = output.sql.find("DELETE FROM").unwrap();
        assert!(insert_position < delete_position);
    }

    /// Verifies MINIMAL DELETE images and placeholder columns never produce destructive SQL.
    #[test]
    fn incomplete_or_unnamed_rows_are_refused() {
        let before = BTreeMap::from([
            (
                "@1".into(),
                BinlogCell::Value {
                    value: CellValue::Integer("7".into()),
                },
            ),
            ("status".into(), BinlogCell::NotLogged),
            ("note".into(), BinlogCell::NotLogged),
        ]);
        let mut change = change(BinlogOperation::Delete, Some(before), None);
        change.columns[0] = "@1".into();

        let output = generate_transaction_reset_sql(&transaction(vec![change]));

        assert!(!output.complete);
        assert!(output.sql.is_empty());
        assert!(output.warnings[0].contains("real column names"));
    }

    /// Verifies rolled-back transactions and DDL never receive a misleading inverse statement.
    #[test]
    fn non_committed_and_ddl_transactions_are_not_inverted() {
        let mut rolled_back = transaction(Vec::new());
        rolled_back.status = BinlogTransactionStatus::RolledBack;
        let rolled_back_output = generate_transaction_reset_sql(&rolled_back);
        assert!(rolled_back_output.sql.is_empty());
        assert!(rolled_back_output.warnings[0].contains("commit boundary"));

        let ddl = BinlogChange {
            database: "shop".into(),
            table: "orders".into(),
            operation: BinlogOperation::Ddl,
            row_count: 0,
            columns: Vec::new(),
            rows: Vec::new(),
            table_confidence: BinlogTableConfidence::SqlParsed,
            sql: Some("ALTER TABLE orders ADD COLUMN note TEXT".into()),
        };
        let ddl_output = generate_transaction_reset_sql(&transaction(vec![ddl]));
        assert!(ddl_output.sql.is_empty());
        assert!(ddl_output.warnings[0].contains("DDL"));
    }

    /// Verifies TIMESTAMP cells use epoch-aware SQL instead of numeric or text assignment.
    #[test]
    fn timestamp_cells_use_from_unixtime() {
        let row = BTreeMap::from([
            (
                "id".into(),
                BinlogCell::Value {
                    value: CellValue::Integer("7".into()),
                },
            ),
            (
                "status".into(),
                BinlogCell::UnixTimestamp {
                    value: "1722067200.123456".into(),
                },
            ),
            ("note".into(), BinlogCell::Null),
        ]);

        let output = generate_transaction_reset_sql(&transaction(vec![change(
            BinlogOperation::Delete,
            Some(row),
            None,
        )]));

        assert!(output.complete);
        assert!(output.sql.contains("FROM_UNIXTIME(1722067200.123456)"));
    }

    /// Verifies charset-uncertain raw bytes never receive a purportedly lossless inverse.
    #[test]
    fn partial_character_bytes_are_not_inverted() {
        let row = BTreeMap::from([
            (
                "id".into(),
                BinlogCell::Value {
                    value: CellValue::Integer("7".into()),
                },
            ),
            (
                "status".into(),
                BinlogCell::Partial {
                    value: CellValue::Binary("6Q==".into()),
                    message: Some("Character data uses latin1; raw bytes were retained".into()),
                },
            ),
            ("note".into(), BinlogCell::Null),
        ]);

        let output = generate_transaction_reset_sql(&transaction(vec![change(
            BinlogOperation::Delete,
            Some(row),
            None,
        )]));

        assert!(!output.complete);
        assert!(output.sql.is_empty());
        assert!(output.warnings[0].contains("decoded completely"));
    }
}
