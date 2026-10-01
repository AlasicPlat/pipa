//! Quick-filter compilation into MySQL `WHERE` clauses.
//!
//! This logic previously lived in the frontend, where SQL text was assembled in TypeScript. It is
//! owned by the backend now so the rules that keep user text out of SQL structure — a closed
//! operator allowlist, schema-authorized column names, and literal-encoded operands — are enforced
//! on the side that talks to the database rather than in the UI layer.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Closed allowlist of comparison operators the quick filter may emit.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[ts(export)]
pub enum TableFilterOperator {
    /// `=`
    #[serde(rename = "=")]
    Equal,
    /// `!=`
    #[serde(rename = "!=")]
    NotEqual,
    /// `>`
    #[serde(rename = ">")]
    Greater,
    /// `>=`
    #[serde(rename = ">=")]
    GreaterOrEqual,
    /// `<`
    #[serde(rename = "<")]
    Less,
    /// `<=`
    #[serde(rename = "<=")]
    LessOrEqual,
    /// `LIKE` with user-supplied wildcards.
    #[serde(rename = "LIKE")]
    Like,
    /// `NOT LIKE` with user-supplied wildcards.
    #[serde(rename = "NOT LIKE")]
    NotLike,
    /// Substring match with wildcards escaped.
    #[serde(rename = "CONTAINS")]
    Contains,
    /// Prefix match with wildcards escaped.
    #[serde(rename = "STARTS_WITH")]
    StartsWith,
    /// Suffix match with wildcards escaped.
    #[serde(rename = "ENDS_WITH")]
    EndsWith,
    /// `IN (...)` over a comma-separated list.
    #[serde(rename = "IN")]
    In,
    /// `NOT IN (...)` over a comma-separated list.
    #[serde(rename = "NOT IN")]
    NotIn,
    /// `BETWEEN a AND b` over exactly two comma-separated bounds.
    #[serde(rename = "BETWEEN")]
    Between,
    /// `IS NULL`; takes no operand.
    #[serde(rename = "IS NULL")]
    IsNull,
    /// `IS NOT NULL`; takes no operand.
    #[serde(rename = "IS NOT NULL")]
    IsNotNull,
}

/// Boolean connector joining one condition to the preceding one.
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[ts(export)]
pub enum TableFilterConjunction {
    /// Logical conjunction.
    #[default]
    #[serde(rename = "AND")]
    And,
    /// Logical disjunction.
    #[serde(rename = "OR")]
    Or,
}

/// One draft condition supplied by the filter bar.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TableFilterCondition {
    /// Column name that must exist in the supplied schema.
    pub column_name: String,
    /// Allowlisted comparison operator.
    pub operator: TableFilterOperator,
    /// Untrusted user text; ignored for unary operators.
    pub value: String,
    /// Connector joining this condition to the preceding one.
    pub conjunction: TableFilterConjunction,
    /// Whether this condition participates in the compiled clause.
    pub enabled: bool,
}

/// Minimal column facts needed to authorize and type-check one condition.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TableFilterColumn {
    /// Exact column name reported by the database.
    pub name: String,
    /// Full MySQL `COLUMN_TYPE` declaration, such as `varchar(50)`.
    #[serde(rename = "type")]
    pub column_type: String,
}

/// Compiled clause, its validation errors, and the applied condition count.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TableFilterClause {
    /// Complete clause beginning with ` WHERE`, or an empty string when inactive.
    #[serde(rename = "where")]
    #[ts(rename = "where")]
    pub where_clause: String,
    /// Localized validation errors that block submission.
    pub errors: Vec<String>,
    /// Number of conditions contributing to the clause.
    pub active_count: u32,
}

const NUMERIC_FILTER_BASE_TYPES: &[&str] = &[
    "tinyint",
    "smallint",
    "mediumint",
    "int",
    "integer",
    "bigint",
    "decimal",
    "numeric",
    "float",
    "double",
    "real",
    "year",
    "bit",
];

const TEMPORAL_FILTER_BASE_TYPES: &[&str] = &["date", "time", "datetime", "timestamp"];

/// Binary and spatial types need explicit SQL functions, so the quick filter refuses them.
const UNFILTERABLE_BASE_TYPES: &[&str] = &[
    "geometry",
    "point",
    "linestring",
    "polygon",
    "multipoint",
    "multilinestring",
    "multipolygon",
    "geometrycollection",
    "tinyblob",
    "blob",
    "mediumblob",
    "longblob",
    "binary",
    "varbinary",
];

const ORDERED_FILTER_OPERATORS: &[TableFilterOperator] = &[
    TableFilterOperator::Equal,
    TableFilterOperator::NotEqual,
    TableFilterOperator::Greater,
    TableFilterOperator::GreaterOrEqual,
    TableFilterOperator::Less,
    TableFilterOperator::LessOrEqual,
    TableFilterOperator::Between,
    TableFilterOperator::In,
    TableFilterOperator::NotIn,
    TableFilterOperator::IsNull,
    TableFilterOperator::IsNotNull,
];

const TEXT_FILTER_OPERATORS: &[TableFilterOperator] = &[
    TableFilterOperator::Equal,
    TableFilterOperator::NotEqual,
    TableFilterOperator::Contains,
    TableFilterOperator::StartsWith,
    TableFilterOperator::EndsWith,
    TableFilterOperator::Like,
    TableFilterOperator::NotLike,
    TableFilterOperator::In,
    TableFilterOperator::NotIn,
    TableFilterOperator::IsNull,
    TableFilterOperator::IsNotNull,
];

const EQUALITY_FILTER_OPERATORS: &[TableFilterOperator] = &[
    TableFilterOperator::Equal,
    TableFilterOperator::NotEqual,
    TableFilterOperator::In,
    TableFilterOperator::NotIn,
    TableFilterOperator::IsNull,
    TableFilterOperator::IsNotNull,
];

impl TableFilterOperator {
    /// Returns the exact SQL text for this operator.
    fn sql(self) -> &'static str {
        match self {
            Self::Equal => "=",
            Self::NotEqual => "!=",
            Self::Greater => ">",
            Self::GreaterOrEqual => ">=",
            Self::Less => "<",
            Self::LessOrEqual => "<=",
            Self::Like => "LIKE",
            Self::NotLike => "NOT LIKE",
            Self::Contains => "CONTAINS",
            Self::StartsWith => "STARTS_WITH",
            Self::EndsWith => "ENDS_WITH",
            Self::In => "IN",
            Self::NotIn => "NOT IN",
            Self::Between => "BETWEEN",
            Self::IsNull => "IS NULL",
            Self::IsNotNull => "IS NOT NULL",
        }
    }

    /// Reports whether this operator needs no value operand.
    #[must_use]
    pub fn is_unary(self) -> bool {
        matches!(self, Self::IsNull | Self::IsNotNull)
    }
}

impl TableFilterConjunction {
    /// Returns the exact SQL keyword for this connector.
    fn sql(self) -> &'static str {
        match self {
            Self::And => "AND",
            Self::Or => "OR",
        }
    }
}

/// Extracts the bare MySQL base type used to classify filter behaviour.
fn filter_base_type(database_type: &str) -> String {
    database_type
        .trim()
        .chars()
        .take_while(|character| character.is_ascii_alphabetic())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Reports whether the quick filter can build a predicate for one column type.
#[must_use]
pub fn is_filterable_column_type(database_type: &str) -> bool {
    !UNFILTERABLE_BASE_TYPES.contains(&filter_base_type(database_type).as_str())
}

/// Chooses the operators that are meaningful for one MySQL column type.
#[must_use]
pub fn filter_operators_for_column_type(database_type: &str) -> &'static [TableFilterOperator] {
    if !is_filterable_column_type(database_type) {
        return &[];
    }
    let base_type = filter_base_type(database_type);
    if NUMERIC_FILTER_BASE_TYPES.contains(&base_type.as_str())
        || TEMPORAL_FILTER_BASE_TYPES.contains(&base_type.as_str())
    {
        return ORDERED_FILTER_OPERATORS;
    }
    match base_type.as_str() {
        "json" => EQUALITY_FILTER_OPERATORS,
        _ => TEXT_FILTER_OPERATORS,
    }
}

/// Escapes a MySQL identifier by doubling embedded backticks.
///
/// Identifiers are never taken from raw user text: callers resolve them against a live schema
/// first, and this quoting keeps even a hostile name inside one identifier token.
#[must_use]
pub fn quote_identifier(identifier: &str) -> String {
    format!("`{}`", identifier.replace('`', "``"))
}

/// Encodes untrusted text as a MySQL string literal.
///
/// Backslashes are doubled and single quotes are doubled, so the result cannot terminate its own
/// literal and cannot introduce SQL structure.
#[must_use]
pub fn mysql_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

/// Escapes LIKE wildcards so substring operators match user text literally.
fn escape_like_wildcards(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// Splits a comma-separated list while allowing `\,` to escape a literal comma.
fn split_filter_list(value: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            ',' => items.push(std::mem::take(&mut current)),
            _ => current.push(character),
        }
    }
    items.push(current);
    items
}

/// Reports whether text is an accepted MySQL numeric literal.
///
/// Mirrors `^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$` without a regex dependency, so numeric
/// columns never receive quoted operands and never receive arbitrary text.
fn is_numeric_literal(value: &str) -> bool {
    let mut rest = value;
    if let Some(stripped) = rest.strip_prefix(['+', '-']) {
        rest = stripped;
    }

    let mantissa_end = rest.find(['e', 'E']).unwrap_or(rest.len());
    let (mantissa, exponent) = rest.split_at(mantissa_end);

    let (integer_part, fraction_part) = match mantissa.split_once('.') {
        Some((integer_part, fraction_part)) => (integer_part, Some(fraction_part)),
        None => (mantissa, None),
    };
    let integer_digits = integer_part.chars().all(|c| c.is_ascii_digit());
    let mantissa_valid = match fraction_part {
        // `1.` and `1.5` are accepted; a fraction may be empty only when an integer part exists.
        Some(fraction) => {
            integer_digits
                && fraction.chars().all(|c| c.is_ascii_digit())
                && (!integer_part.is_empty() || !fraction.is_empty())
        }
        None => integer_digits && !integer_part.is_empty(),
    };
    if !mantissa_valid {
        return false;
    }

    if exponent.is_empty() {
        return true;
    }
    let mut digits = &exponent[1..];
    if let Some(stripped) = digits.strip_prefix(['+', '-']) {
        digits = stripped;
    }
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

/// Encodes one filter operand as a MySQL literal matching its column type.
fn filter_value_literal(value: &str, column: &TableFilterColumn) -> Result<String, String> {
    let base_type = filter_base_type(&column.column_type);
    let trimmed = value.trim();
    if NUMERIC_FILTER_BASE_TYPES.contains(&base_type.as_str()) {
        if !is_numeric_literal(trimmed) {
            return Err(format!("{} 需要数值", column.name));
        }
        return Ok(trimmed.to_owned());
    }
    if TEMPORAL_FILTER_BASE_TYPES.contains(&base_type.as_str()) {
        if trimmed.is_empty() {
            return Err(format!("{} 需要时间值", column.name));
        }
        return Ok(mysql_string_literal(trimmed));
    }
    Ok(mysql_string_literal(value))
}

/// Builds one predicate for a single enabled condition.
fn filter_predicate(
    condition: &TableFilterCondition,
    column: &TableFilterColumn,
) -> Result<String, String> {
    let identifier = quote_identifier(&column.name);
    let operator = condition.operator;
    if operator.is_unary() {
        return Ok(format!("{identifier} {}", operator.sql()));
    }

    match operator {
        TableFilterOperator::In | TableFilterOperator::NotIn => {
            let items: Vec<String> = split_filter_list(&condition.value)
                .into_iter()
                .map(|item| item.trim().to_owned())
                .filter(|item| !item.is_empty())
                .collect();
            if items.is_empty() {
                return Err(format!(
                    "{} 的 {} 需要至少一个值",
                    column.name,
                    operator.sql()
                ));
            }
            let mut literals = Vec::with_capacity(items.len());
            for item in &items {
                literals.push(filter_value_literal(item, column)?);
            }
            Ok(format!(
                "{identifier} {} ({})",
                operator.sql(),
                literals.join(", ")
            ))
        }
        TableFilterOperator::Between => {
            let bounds = split_filter_list(&condition.value);
            if bounds.len() != 2 || bounds.iter().any(|bound| bound.trim().is_empty()) {
                return Err(format!("{} 的 BETWEEN 需要用逗号分隔的两个值", column.name));
            }
            let lower = filter_value_literal(&bounds[0], column)?;
            let upper = filter_value_literal(&bounds[1], column)?;
            Ok(format!("{identifier} BETWEEN {lower} AND {upper}"))
        }
        TableFilterOperator::Contains
        | TableFilterOperator::StartsWith
        | TableFilterOperator::EndsWith => {
            if condition.value.is_empty() {
                return Err(format!("{} 需要筛选值", column.name));
            }
            let escaped = escape_like_wildcards(&condition.value);
            let pattern = match operator {
                TableFilterOperator::Contains => format!("%{escaped}%"),
                TableFilterOperator::StartsWith => format!("{escaped}%"),
                _ => format!("%{escaped}"),
            };
            Ok(format!(
                "{identifier} LIKE {} ESCAPE '\\\\'",
                mysql_string_literal(&pattern)
            ))
        }
        TableFilterOperator::Like | TableFilterOperator::NotLike => {
            if condition.value.is_empty() {
                return Err(format!("{} 需要筛选值", column.name));
            }
            Ok(format!(
                "{identifier} {} {}",
                operator.sql(),
                mysql_string_literal(&condition.value)
            ))
        }
        _ => {
            let literal = filter_value_literal(&condition.value, column)?;
            Ok(format!("{identifier} {} {literal}", operator.sql()))
        }
    }
}

/// Compiles quick-filter conditions into one MySQL `WHERE` clause.
///
/// Column names are matched against the supplied schema and quoted, operators come from a closed
/// allowlist, and every operand is encoded as a literal, so user text can never alter structure.
///
/// Mixed `AND`/`OR` is grouped strictly left to right, so the executed clause matches the visual
/// order instead of silently following MySQL's `AND`-before-`OR` precedence.
#[must_use]
pub fn build_table_filter_clause(
    conditions: &[TableFilterCondition],
    schema: &[TableFilterColumn],
) -> TableFilterClause {
    let mut errors: Vec<String> = Vec::new();
    let mut parts: Vec<(String, TableFilterConjunction)> = Vec::new();

    for condition in conditions {
        // A half-written row is incomplete rather than wrong, so it is ignored without an error.
        let incomplete = !condition.operator.is_unary() && condition.value.trim().is_empty();
        if !condition.enabled || condition.column_name.is_empty() || incomplete {
            continue;
        }
        let Some(column) = schema
            .iter()
            .find(|column| column.name == condition.column_name)
        else {
            errors.push(format!("字段 {} 不在当前表结构中", condition.column_name));
            continue;
        };
        if !filter_operators_for_column_type(&column.column_type).contains(&condition.operator) {
            errors.push(format!(
                "{}（{}）不支持该比较符",
                column.name, column.column_type
            ));
            continue;
        }
        match filter_predicate(condition, column) {
            Ok(predicate) => parts.push((predicate, condition.conjunction)),
            Err(error) => errors.push(error),
        }
    }

    if !errors.is_empty() || parts.is_empty() {
        return TableFilterClause {
            where_clause: String::new(),
            errors: deduplicate(errors),
            active_count: 0,
        };
    }

    let mixed = parts
        .iter()
        .skip(1)
        .map(|(_, conjunction)| *conjunction)
        .collect::<BTreeSet<_>>()
        .len()
        > 1;
    let active_count = u32::try_from(parts.len()).unwrap_or(u32::MAX);
    let mut iterator = parts.into_iter();
    let mut clause = iterator
        .next()
        .map(|(predicate, _)| predicate)
        .unwrap_or_default();
    for (index, (predicate, conjunction)) in iterator.enumerate() {
        clause = if mixed && index > 0 {
            format!("({clause}) {} {predicate}", conjunction.sql())
        } else {
            format!("{clause} {} {predicate}", conjunction.sql())
        };
    }

    TableFilterClause {
        where_clause: format!(" WHERE {clause}"),
        errors: Vec::new(),
        active_count,
    }
}

/// Removes duplicate messages while preserving first-seen order.
fn deduplicate(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds the two-column schema shared by the filter cases.
    fn schema() -> Vec<TableFilterColumn> {
        vec![
            TableFilterColumn {
                name: "id".into(),
                column_type: "bigint unsigned".into(),
            },
            TableFilterColumn {
                name: "name".into(),
                column_type: "varchar(50)".into(),
            },
        ]
    }

    /// Builds one enabled condition against the `name` column.
    fn condition(
        column_name: &str,
        operator: TableFilterOperator,
        value: &str,
    ) -> TableFilterCondition {
        TableFilterCondition {
            column_name: column_name.into(),
            operator,
            value: value.into(),
            conjunction: TableFilterConjunction::And,
            enabled: true,
        }
    }

    /// Verifies numeric operands stay bare while text operands are quoted and escaped.
    #[test]
    fn emits_bare_numeric_and_quoted_text_literals() {
        let clause = build_table_filter_clause(
            &[condition(
                "id",
                TableFilterOperator::GreaterOrEqual,
                "18446744073709551615",
            )],
            &schema(),
        );
        assert_eq!(clause.where_clause, " WHERE `id` >= 18446744073709551615");
        assert!(clause.errors.is_empty());
        assert_eq!(clause.active_count, 1);

        let text = build_table_filter_clause(
            &[condition("name", TableFilterOperator::Equal, "O'Reilly")],
            &schema(),
        );
        assert_eq!(text.where_clause, " WHERE `name` = 'O''Reilly'");
    }

    /// Verifies injected quotes and comment markers cannot escape the literal.
    #[test]
    fn keeps_injected_sql_inside_a_literal() {
        let clause = build_table_filter_clause(
            &[condition(
                "name",
                TableFilterOperator::Equal,
                "x' OR 1=1 -- ",
            )],
            &schema(),
        );
        assert_eq!(clause.where_clause, " WHERE `name` = 'x'' OR 1=1 -- '");
        assert!(clause.errors.is_empty());
    }

    /// Verifies unknown columns, type-incompatible operators, and bad numbers are rejected.
    #[test]
    fn rejects_unknown_columns_and_incompatible_operators() {
        let unknown = build_table_filter_clause(
            &[condition("dropped", TableFilterOperator::Equal, "x")],
            &schema(),
        );
        assert_eq!(unknown.where_clause, "");
        assert_eq!(unknown.errors, vec!["字段 dropped 不在当前表结构中"]);
        assert_eq!(unknown.active_count, 0);

        let wrong_operator = build_table_filter_clause(
            &[condition("id", TableFilterOperator::Contains, "1")],
            &schema(),
        );
        assert_eq!(
            wrong_operator.errors,
            vec!["id（bigint unsigned）不支持该比较符"]
        );

        let bad_number = build_table_filter_clause(
            &[condition("id", TableFilterOperator::Equal, "abc")],
            &schema(),
        );
        assert_eq!(bad_number.errors, vec!["id 需要数值"]);
    }

    /// Verifies substring operators escape wildcards while explicit LIKE preserves them.
    #[test]
    fn escapes_wildcards_only_for_substring_operators() {
        let contains = build_table_filter_clause(
            &[condition("name", TableFilterOperator::Contains, "50%_a")],
            &schema(),
        );
        assert_eq!(
            contains.where_clause,
            r" WHERE `name` LIKE '%50\\%\\_a%' ESCAPE '\\'"
        );

        let like = build_table_filter_clause(
            &[condition("name", TableFilterOperator::Like, "ab%")],
            &schema(),
        );
        assert_eq!(like.where_clause, " WHERE `name` LIKE 'ab%'");
    }

    /// Verifies list and range operands split on unescaped commas only.
    #[test]
    fn builds_list_and_range_predicates() {
        let numeric_list = build_table_filter_clause(
            &[condition("id", TableFilterOperator::In, "1, 2 ,3")],
            &schema(),
        );
        assert_eq!(numeric_list.where_clause, " WHERE `id` IN (1, 2, 3)");

        let escaped_list = build_table_filter_clause(
            &[condition("name", TableFilterOperator::In, r"a\,b,c")],
            &schema(),
        );
        assert_eq!(escaped_list.where_clause, " WHERE `name` IN ('a,b', 'c')");

        let range = build_table_filter_clause(
            &[condition("id", TableFilterOperator::Between, "1,10")],
            &schema(),
        );
        assert_eq!(range.where_clause, " WHERE `id` BETWEEN 1 AND 10");

        let incomplete_range = build_table_filter_clause(
            &[condition("id", TableFilterOperator::Between, "1")],
            &schema(),
        );
        assert_eq!(
            incomplete_range.errors,
            vec!["id 的 BETWEEN 需要用逗号分隔的两个值"]
        );
    }

    /// Verifies unary operators drop their operand and disabled rows contribute nothing.
    #[test]
    fn omits_operand_for_unary_operators_and_skips_disabled() {
        let unary = build_table_filter_clause(
            &[condition("name", TableFilterOperator::IsNull, "ignored")],
            &schema(),
        );
        assert_eq!(unary.where_clause, " WHERE `name` IS NULL");

        let mut disabled = condition("id", TableFilterOperator::Equal, "1");
        disabled.enabled = false;
        let clause = build_table_filter_clause(
            &[
                condition("name", TableFilterOperator::IsNotNull, ""),
                disabled,
            ],
            &schema(),
        );
        assert_eq!(clause.where_clause, " WHERE `name` IS NOT NULL");
        assert!(clause.errors.is_empty());
        assert_eq!(clause.active_count, 1);
    }

    /// Verifies mixed connectors group left to right while uniform ones stay flat.
    #[test]
    fn groups_mixed_connectors_left_to_right() {
        let uniform = build_table_filter_clause(
            &[
                condition("id", TableFilterOperator::Greater, "1"),
                condition("name", TableFilterOperator::Contains, "x"),
                condition("name", TableFilterOperator::IsNull, ""),
            ],
            &schema(),
        );
        assert_eq!(
            uniform.where_clause,
            r" WHERE `id` > 1 AND `name` LIKE '%x%' ESCAPE '\\' AND `name` IS NULL"
        );
        assert_eq!(uniform.active_count, 3);

        let mut second = condition("name", TableFilterOperator::Equal, "x");
        second.conjunction = TableFilterConjunction::Or;
        let mixed = build_table_filter_clause(
            &[
                condition("id", TableFilterOperator::Greater, "1"),
                second,
                condition("id", TableFilterOperator::Less, "9"),
            ],
            &schema(),
        );
        assert_eq!(
            mixed.where_clause,
            " WHERE (`id` > 1 OR `name` = 'x') AND `id` < 9"
        );
    }

    /// Verifies a half-written condition is ignored rather than reported as invalid.
    #[test]
    fn treats_half_written_conditions_as_incomplete() {
        let empty = build_table_filter_clause(
            &[condition("name", TableFilterOperator::Equal, "")],
            &schema(),
        );
        assert_eq!(empty.where_clause, "");
        assert!(empty.errors.is_empty());
        assert_eq!(empty.active_count, 0);

        let partial = build_table_filter_clause(
            &[
                condition("id", TableFilterOperator::Equal, "7"),
                condition("name", TableFilterOperator::Equal, "  "),
            ],
            &schema(),
        );
        assert_eq!(partial.where_clause, " WHERE `id` = 7");
        assert!(partial.errors.is_empty());
        assert_eq!(partial.active_count, 1);

        assert_eq!(build_table_filter_clause(&[], &schema()).where_clause, "");
    }

    /// Verifies numeric literal acceptance matches the original frontend regex.
    #[test]
    fn numeric_literal_matches_original_regex() {
        for accepted in [
            "1", "-1", "+1", "1.5", "1.", ".5", "1e5", "1.5E-3", "-.5e+2",
        ] {
            assert!(is_numeric_literal(accepted), "should accept {accepted}");
        }
        for rejected in ["", ".", "abc", "1e", "1e+", "--1", "1.2.3", "0x1f", "1 2"] {
            assert!(!is_numeric_literal(rejected), "should reject {rejected}");
        }
    }
}
