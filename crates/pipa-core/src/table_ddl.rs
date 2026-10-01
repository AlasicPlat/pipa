//! Visual structure-editor DDL generation for MySQL tables.
//!
//! This logic previously lived in the frontend, which assembled `ALTER TABLE` text in TypeScript
//! and then executed it verbatim through the generic query command. Unlike table data, DDL cannot
//! use bound parameters: identifiers, type declarations, and defaults are part of SQL structure by
//! definition. That makes the escaping and the type allowlist the only thing standing between a
//! user-typed column name and arbitrary SQL, so both are owned by the backend now.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::table_filter::{mysql_string_literal, quote_identifier};

/// One column as reconstructed by the visual structure editor.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TableColumnDefinition {
    /// Original database column name, or `None` for a column being added.
    pub source_name: Option<String>,
    /// Current column name.
    pub name: String,
    /// Full MySQL type declaration, such as `varchar(50)`.
    #[serde(rename = "type")]
    pub column_type: String,
    /// Whether the column accepts NULL.
    pub nullable: bool,
    /// Server default as text, or `None` when the column has no default.
    pub default_value: Option<String>,
    /// Whether `default_value` is an expression rather than a literal.
    pub default_expression: bool,
    /// Column comment; empty when absent.
    pub comment: String,
    /// Whether the column participates in the primary key.
    pub primary: bool,
    /// Raw `INFORMATION_SCHEMA.COLUMNS.EXTRA` text.
    pub extra: String,
    /// Column character set, when the type is a character type.
    pub character_set: Option<String>,
    /// Column collation, when the type is a character type.
    pub collation: Option<String>,
    /// Generated-column expression; empty when the column is not generated.
    pub generation_expression: String,
}

/// Ordered DDL statements and the validation errors that suppressed statements.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TableDdlPlan {
    /// Ordered native MySQL DDL statements.
    pub statements: Vec<String>,
    /// Localized reasons why one or more edited columns produced no statement.
    pub errors: Vec<String>,
}

/// Closed allowlist of type declarations the visual editor may emit.
///
/// Anything outside this shape — expressions, `ENUM`/`SET` value lists, charset clauses inside the
/// type, or vendor syntax — is refused rather than escaped, because a type declaration cannot be
/// quoted the way an identifier can.
static SAFE_COLUMN_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?ix)^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|
           bit|boolean|bool|date|time|datetime|timestamp|year|char|varchar|binary|varbinary|
           tinyblob|blob|mediumblob|longblob|tinytext|text|mediumtext|longtext|json|geometry|point|
           linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)
           (?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s+unsigned)?(?:\s+zerofill)?$",
    )
    .expect("column type allowlist is a valid regex")
});

static CHARACTER_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b")
        .expect("character type prefix is a valid regex")
});

static SPATIAL_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b",
    )
    .expect("spatial type prefix is a valid regex")
});

static BINARY_DEFAULT_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:bit|binary|varbinary)\b").expect("binary type prefix is a valid regex")
});

static NUMERIC_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit)",
    )
    .expect("numeric type prefix is a valid regex")
});

static TEMPORAL_DEFAULT_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:date|datetime|timestamp)\b")
        .expect("temporal type prefix is a valid regex")
});

static CURRENT_TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^CURRENT_TIMESTAMP(?:\(\d*\))?$")
        .expect("current timestamp token is a valid regex")
});

static NUMERIC_LITERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$").expect("numeric literal is a valid regex")
});

static ON_UPDATE_CLAUSE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bon update (CURRENT_TIMESTAMP(?:\(\d*\))?)")
        .expect("on update clause is a valid regex")
});

/// Reports why one type declaration cannot be emitted by the visual editor.
#[must_use]
pub fn column_type_validation_error(database_type: &str) -> Option<&'static str> {
    if SAFE_COLUMN_TYPE.is_match(database_type.trim()) {
        None
    } else {
        Some("字段类型包含可视化编辑器不支持的复杂语法，请使用显式 ALTER TABLE")
    }
}

/// Returns whether a server default is the SQL-mode-independent current-timestamp token.
fn is_current_timestamp_expression(value: Option<&String>) -> bool {
    value.is_some_and(|value| CURRENT_TIMESTAMP.is_match(value.trim()))
}

/// Reports whether the visual editor may rewrite one existing column.
///
/// Columns carrying syntax the editor cannot faithfully reproduce are refused, so a `CHANGE COLUMN`
/// can never silently drop a generated expression, a spatial type, or an unrecognized EXTRA clause.
#[must_use]
pub fn is_structure_column_editable(column: &TableColumnDefinition) -> bool {
    let normalized_type = column.column_type.trim().to_lowercase();
    if SPATIAL_TYPE.is_match(&normalized_type)
        || !column.generation_expression.is_empty()
        || (column.default_value.is_some() && BINARY_DEFAULT_TYPE.is_match(&normalized_type))
        || (column.default_expression
            && !is_current_timestamp_expression(column.default_value.as_ref()))
    {
        return false;
    }

    // Every clause the generator knows how to reproduce is stripped; anything left is unknown.
    let mut known_extra = column.extra.clone();
    for pattern in [
        r"(?i)\bDEFAULT_GENERATED\b",
        r"(?i)\bAUTO_INCREMENT\b",
        r"(?i)\b(?:VIRTUAL|STORED) GENERATED\b",
        r"(?i)\bINVISIBLE\b",
        r"(?i)\bon update CURRENT_TIMESTAMP(?:\(\d*\))?(?:[^A-Za-z0-9_]|$)",
    ] {
        let regex = Regex::new(pattern).expect("extra clause pattern is a valid regex");
        known_extra = regex.replace_all(&known_extra, "").into_owned();
    }
    known_extra.trim().is_empty() && column_type_validation_error(&column.column_type).is_none()
}

/// Returns only the column clauses the generator can reproduce from EXTRA.
fn preserved_extra_clauses(extra: &str) -> Vec<String> {
    let mut clauses = Vec::new();
    if Regex::new(r"(?i)\bAUTO_INCREMENT\b")
        .expect("auto increment is a valid regex")
        .is_match(extra)
    {
        clauses.push("AUTO_INCREMENT".to_owned());
    }
    if let Some(captures) = ON_UPDATE_CLAUSE.captures(extra) {
        clauses.push(format!("ON UPDATE {}", captures[1].to_uppercase()));
    }
    if Regex::new(r"(?i)\bINVISIBLE\b")
        .expect("invisible is a valid regex")
        .is_match(extra)
    {
        clauses.push("INVISIBLE".to_owned());
    }
    clauses
}

/// Encodes a literal default for its column type.
fn default_literal(value: &str, database_type: &str) -> String {
    let trimmed = value.trim();
    let declaration = database_type.trim();
    if TEMPORAL_DEFAULT_TYPE.is_match(declaration) && CURRENT_TIMESTAMP.is_match(trimmed) {
        return trimmed.to_uppercase();
    }
    if NUMERIC_TYPE.is_match(declaration) && NUMERIC_LITERAL.is_match(trimmed) {
        return trimmed.to_owned();
    }
    mysql_string_literal(value)
}

/// Reconstructs a server expression default, preserving the timestamp shorthand.
fn expression_default(value: &str) -> String {
    if CURRENT_TIMESTAMP.is_match(value.trim()) {
        value.trim().to_uppercase()
    } else {
        format!("({value})")
    }
}

/// Formats one complete MySQL column definition for `ADD` or `CHANGE`.
///
/// The caller must have validated the type with `column_type_validation_error` first; the type text
/// is the one piece here that cannot be quoted, so it is only ever emitted from the allowlist.
fn column_sql(column: &TableColumnDefinition) -> String {
    let declaration = column.column_type.trim();
    let mut pieces = vec![
        quote_identifier(&column.name),
        if declaration.is_empty() {
            "VARCHAR(255)".to_owned()
        } else {
            declaration.to_owned()
        },
    ];

    let character_type = CHARACTER_TYPE.is_match(declaration);
    if character_type {
        if let Some(character_set) = &column.character_set {
            pieces.push(format!("CHARACTER SET {}", quote_identifier(character_set)));
        }
        if let Some(collation) = &column.collation {
            pieces.push(format!("COLLATE {}", quote_identifier(collation)));
        }
    }

    if !column.generation_expression.is_empty() {
        let storage = if Regex::new(r"(?i)\bSTORED GENERATED\b")
            .expect("stored generated is a valid regex")
            .is_match(&column.extra)
        {
            "STORED"
        } else {
            "VIRTUAL"
        };
        pieces.push(format!(
            "GENERATED ALWAYS AS ({}) {storage}",
            column.generation_expression
        ));
    }

    pieces.push(if column.nullable { "NULL" } else { "NOT NULL" }.to_owned());

    if column.generation_expression.is_empty() {
        if let Some(default_value) = &column.default_value {
            let rendered = if column.default_expression {
                expression_default(default_value)
            } else {
                default_literal(default_value, &column.column_type)
            };
            pieces.push(format!("DEFAULT {rendered}"));
        }
    }

    pieces.extend(preserved_extra_clauses(&column.extra));

    if !column.comment.is_empty() {
        pieces.push(format!("COMMENT {}", mysql_string_literal(&column.comment)));
    }
    pieces.join(" ")
}

/// Compares every field the visual structure editor can reconstruct.
fn same_column(left: &TableColumnDefinition, right: &TableColumnDefinition) -> bool {
    left.name == right.name
        && left.column_type == right.column_type
        && left.nullable == right.nullable
        && left.default_value == right.default_value
        && left.default_expression == right.default_expression
        && left.comment == right.comment
        && left.extra == right.extra
        && left.character_set == right.character_set
        && left.collation == right.collation
        && left.generation_expression == right.generation_expression
}

/// Compiles the visual structure edits into ordered MySQL DDL.
///
/// Drops come first so a rename that reuses a dropped column's name cannot collide. Columns whose
/// type falls outside the allowlist, and existing columns the editor cannot faithfully reproduce,
/// yield an error instead of a statement rather than being emitted unvalidated.
#[must_use]
pub fn build_table_ddl_plan(
    database: &str,
    table: &str,
    original_columns: &[TableColumnDefinition],
    draft_columns: &[TableColumnDefinition],
) -> TableDdlPlan {
    let target = format!("{}.{}", quote_identifier(database), quote_identifier(table));
    let retained_source_names: BTreeSet<&str> = draft_columns
        .iter()
        .filter_map(|column| column.source_name.as_deref())
        .collect();

    let mut statements: Vec<String> = original_columns
        .iter()
        .filter(|column| !retained_source_names.contains(column.name.as_str()))
        .map(|column| {
            format!(
                "ALTER TABLE {target} DROP COLUMN {};",
                quote_identifier(&column.name)
            )
        })
        .collect();
    let mut errors: Vec<String> = Vec::new();

    for column in draft_columns {
        let Some(source_name) = column.source_name.as_deref() else {
            match column_type_validation_error(&column.column_type) {
                None => statements.push(format!(
                    "ALTER TABLE {target} ADD COLUMN {};",
                    column_sql(column)
                )),
                Some(reason) => errors.push(format!("{}：{reason}", column.name)),
            }
            continue;
        };

        let Some(original) = original_columns
            .iter()
            .find(|item| item.name == source_name)
        else {
            continue;
        };
        if same_column(original, column) {
            continue;
        }
        if !is_structure_column_editable(original) {
            errors.push(format!(
                "{source_name}：该列包含可视化编辑器无法重建的定义，请使用显式 ALTER TABLE"
            ));
            continue;
        }
        if let Some(reason) = column_type_validation_error(&column.column_type) {
            errors.push(format!("{}：{reason}", column.name));
            continue;
        }
        statements.push(format!(
            "ALTER TABLE {target} CHANGE COLUMN {} {};",
            quote_identifier(source_name),
            column_sql(column)
        ));
    }

    TableDdlPlan {
        statements,
        errors: deduplicate(errors),
    }
}

/// Builds DDL that updates only the table-level `COMMENT` option.
#[must_use]
pub fn build_alter_table_comment_statement(database: &str, table: &str, comment: &str) -> String {
    format!(
        "ALTER TABLE {}.{} COMMENT = {};",
        quote_identifier(database),
        quote_identifier(table),
        mysql_string_literal(comment)
    )
}

/// Removes duplicate messages while preserving first-seen order.
fn deduplicate(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

/// Longest schema name MySQL accepts.
const MAX_DATABASE_NAME_LENGTH: usize = 64;

/// One selectable character set and the collations offered with it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DatabaseCharsetOption {
    /// Character set name.
    pub charset: String,
    /// Collations valid for this character set.
    pub collations: Vec<String>,
}

/// Closed allowlist of character sets and the collations each one permits.
///
/// Both values are copied out of this list rather than from the request, so neither can contribute
/// SQL structure even though `CHARACTER SET` and `COLLATE` cannot take bound parameters.
const DATABASE_CHARSETS: &[(&str, &[&str])] = &[
    (
        "utf8mb4",
        &[
            "utf8mb4_0900_ai_ci",
            "utf8mb4_general_ci",
            "utf8mb4_unicode_ci",
            "utf8mb4_unicode_520_ci",
            "utf8mb4_bin",
        ],
    ),
    (
        "utf8mb3",
        &["utf8mb3_general_ci", "utf8mb3_unicode_ci", "utf8mb3_bin"],
    ),
    ("gbk", &["gbk_chinese_ci", "gbk_bin"]),
    (
        "gb18030",
        &[
            "gb18030_chinese_ci",
            "gb18030_unicode_520_ci",
            "gb18030_bin",
        ],
    ),
    ("big5", &["big5_chinese_ci", "big5_bin"]),
    (
        "latin1",
        &["latin1_swedish_ci", "latin1_general_ci", "latin1_bin"],
    ),
    ("ascii", &["ascii_general_ci", "ascii_bin"]),
    ("binary", &["binary"]),
];

/// Returns the character sets and collations the create-database action may emit.
#[must_use]
pub fn database_charset_options() -> Vec<DatabaseCharsetOption> {
    DATABASE_CHARSETS
        .iter()
        .map(|(charset, collations)| DatabaseCharsetOption {
            charset: (*charset).to_owned(),
            collations: collations.iter().map(|value| (*value).to_owned()).collect(),
        })
        .collect()
}

/// Reports why one schema name cannot be created, before any statement is built.
#[must_use]
pub fn database_name_validation_error(database_name: &str) -> Option<String> {
    let trimmed = database_name.trim();
    if trimmed.is_empty() {
        return Some("数据库名不能为空。".to_owned());
    }
    if trimmed.chars().count() > MAX_DATABASE_NAME_LENGTH {
        return Some(format!(
            "数据库名不能超过 {MAX_DATABASE_NAME_LENGTH} 个字符。"
        ));
    }
    // MySQL maps schema names onto directory names, so the server rejects these separators.
    if trimmed.contains(['/', '\\', '.']) {
        return Some("数据库名不能包含 / \\ . 这三种字符。".to_owned());
    }
    if trimmed
        .chars()
        .any(|character| character.is_control() || character == '\u{7f}')
    {
        return Some("数据库名不能包含控制字符。".to_owned());
    }
    None
}

/// One validated `CREATE DATABASE` statement, or the reason the name was refused.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreateDatabasePlan {
    /// Executable statement, or an empty string when `error` is set.
    pub statement: String,
    /// Localized reason the name was refused, or `None` when the statement is valid.
    pub error: Option<String>,
}

/// Builds one `CREATE DATABASE` statement with an allowlisted character set and collation.
///
/// The schema name is validated and then quoted as an identifier; the character set and collation are
/// matched against the allowlist and emitted from it, never copied from the request text.
#[must_use]
pub fn build_create_database_plan(
    database_name: &str,
    charset: Option<&str>,
    collation: Option<&str>,
) -> CreateDatabasePlan {
    if let Some(error) = database_name_validation_error(database_name) {
        return CreateDatabasePlan {
            statement: String::new(),
            error: Some(error),
        };
    }

    let matched = charset.and_then(|requested| {
        DATABASE_CHARSETS
            .iter()
            .find(|(candidate, _)| *candidate == requested)
    });
    let charset_clause = match matched {
        Some((charset, _)) => format!(" CHARACTER SET {charset}"),
        None => String::new(),
    };
    let collation_clause = match (matched, collation) {
        (Some((_, collations)), Some(requested)) if collations.contains(&requested) => {
            format!(" COLLATE {requested}")
        }
        _ => String::new(),
    };

    CreateDatabasePlan {
        statement: format!(
            "CREATE DATABASE {}{charset_clause}{collation_clause};",
            quote_identifier(database_name.trim())
        ),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a plain, editable `varchar` column.
    fn text_column(name: &str) -> TableColumnDefinition {
        TableColumnDefinition {
            source_name: Some(name.to_owned()),
            name: name.to_owned(),
            column_type: "varchar(50)".into(),
            nullable: true,
            default_value: None,
            default_expression: false,
            comment: String::new(),
            primary: false,
            extra: String::new(),
            character_set: Some("utf8mb4".into()),
            collation: Some("utf8mb4_0900_ai_ci".into()),
            generation_expression: String::new(),
        }
    }

    /// Verifies a hostile identifier stays inside one quoted token instead of becoming SQL.
    #[test]
    fn keeps_injected_identifiers_quoted() {
        let mut added = text_column("evil");
        added.source_name = None;
        added.name = "a` , DROP TABLE users; -- ".into();
        let plan = build_table_ddl_plan("shop", "orders", &[], &[added]);
        assert_eq!(plan.statements.len(), 1);
        assert!(plan.statements[0].contains("ADD COLUMN `a`` , DROP TABLE users; -- `"));
        assert!(plan.errors.is_empty());

        // The table and schema names are quoted the same way.
        let hostile = build_alter_table_comment_statement("sh`op", "ord`ers", "it's fine");
        assert_eq!(
            hostile,
            "ALTER TABLE `sh``op`.`ord``ers` COMMENT = 'it''s fine';"
        );
    }

    /// Verifies a type outside the allowlist is refused rather than emitted.
    #[test]
    fn refuses_type_declarations_outside_the_allowlist() {
        let mut added = text_column("c");
        added.source_name = None;
        added.column_type = "varchar(50) DEFAULT 'x', ADD INDEX evil (id)".into();
        let plan = build_table_ddl_plan("shop", "orders", &[], &[added]);
        assert!(plan.statements.is_empty());
        assert_eq!(plan.errors.len(), 1);
        assert!(plan.errors[0].contains("不支持的复杂语法"));

        assert!(column_type_validation_error("bigint unsigned").is_none());
        assert!(column_type_validation_error("decimal(10,4)").is_none());
        assert!(column_type_validation_error("enum('a','b')").is_some());
    }

    /// Verifies drops precede adds so a reused column name cannot collide.
    #[test]
    fn orders_drops_before_other_statements() {
        let original = vec![text_column("old"), text_column("kept")];
        let mut added = text_column("old");
        added.source_name = None;
        let plan = build_table_ddl_plan("shop", "orders", &original, &[text_column("kept"), added]);
        assert_eq!(plan.statements.len(), 2);
        assert!(plan.statements[0].starts_with("ALTER TABLE `shop`.`orders` DROP COLUMN `old`"));
        assert!(plan.statements[1].contains("ADD COLUMN `old`"));
    }

    /// Verifies an unchanged column produces no statement while a real edit produces CHANGE.
    #[test]
    fn emits_change_only_for_real_edits() {
        let original = vec![text_column("title")];
        let unchanged = build_table_ddl_plan("shop", "orders", &original, &original);
        assert!(unchanged.statements.is_empty());
        assert!(unchanged.errors.is_empty());

        let mut edited = text_column("title");
        edited.nullable = false;
        edited.comment = "标题".into();
        let changed = build_table_ddl_plan("shop", "orders", &original, &[edited]);
        assert_eq!(changed.statements.len(), 1);
        assert_eq!(
            changed.statements[0],
            "ALTER TABLE `shop`.`orders` CHANGE COLUMN `title` `title` varchar(50) \
             CHARACTER SET `utf8mb4` COLLATE `utf8mb4_0900_ai_ci` NOT NULL COMMENT '标题';"
        );
    }

    /// Verifies defaults, generated columns, and EXTRA clauses round-trip as the editor showed them.
    #[test]
    fn preserves_defaults_and_extra_clauses() {
        let mut timestamp = text_column("created_at");
        timestamp.source_name = None;
        timestamp.column_type = "datetime".into();
        timestamp.default_value = Some("CURRENT_TIMESTAMP".into());
        timestamp.default_expression = true;
        timestamp.extra = "DEFAULT_GENERATED on update CURRENT_TIMESTAMP".into();
        timestamp.character_set = None;
        timestamp.collation = None;
        let plan = build_table_ddl_plan("shop", "orders", &[], &[timestamp]);
        assert_eq!(
            plan.statements[0],
            "ALTER TABLE `shop`.`orders` ADD COLUMN `created_at` datetime NULL \
             DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;"
        );

        // A numeric default stays bare; a text default is quoted.
        let mut numeric = text_column("qty");
        numeric.source_name = None;
        numeric.column_type = "int".into();
        numeric.default_value = Some("0".into());
        numeric.nullable = false;
        numeric.character_set = None;
        numeric.collation = None;
        let numeric_plan = build_table_ddl_plan("shop", "orders", &[], &[numeric]);
        assert!(numeric_plan.statements[0].ends_with("`qty` int NOT NULL DEFAULT 0;"));

        let mut text_default = text_column("label");
        text_default.source_name = None;
        text_default.default_value = Some("it's".into());
        let text_plan = build_table_ddl_plan("shop", "orders", &[], &[text_default]);
        assert!(text_plan.statements[0].contains("DEFAULT 'it''s'"));
    }

    /// Verifies columns the editor cannot rebuild are reported instead of silently rewritten.
    #[test]
    fn refuses_columns_the_editor_cannot_rebuild() {
        let mut generated = text_column("total");
        generated.generation_expression = "price * qty".into();
        generated.extra = "STORED GENERATED".into();
        assert!(!is_structure_column_editable(&generated));

        let mut edited = generated.clone();
        edited.comment = "改动".into();
        let plan = build_table_ddl_plan("shop", "orders", &[generated], &[edited]);
        assert!(plan.statements.is_empty());
        assert_eq!(plan.errors.len(), 1);
        assert!(plan.errors[0].contains("无法重建"));

        // An unknown EXTRA clause also blocks editing.
        let mut unknown = text_column("weird");
        unknown.extra = "SOMETHING_NEW".into();
        assert!(!is_structure_column_editable(&unknown));

        // Known clauses do not block it.
        let mut known = text_column("id");
        known.column_type = "bigint unsigned".into();
        known.extra = "auto_increment".into();
        known.character_set = None;
        known.collation = None;
        assert!(is_structure_column_editable(&known));
    }

    /// Verifies a hostile schema name is quoted and charset options come only from the allowlist.
    #[test]
    fn builds_create_database_from_allowlisted_options() {
        let plan = build_create_database_plan("shop", Some("utf8mb4"), Some("utf8mb4_bin"));
        assert_eq!(plan.error, None);
        assert_eq!(
            plan.statement,
            "CREATE DATABASE `shop` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;"
        );

        // A collation that does not belong to the chosen charset is dropped, not emitted.
        let mismatched = build_create_database_plan("shop", Some("ascii"), Some("utf8mb4_bin"));
        assert_eq!(
            mismatched.statement,
            "CREATE DATABASE `shop` CHARACTER SET ascii;"
        );

        // Unknown charsets fall back to the server default rather than being interpolated.
        let unknown = build_create_database_plan("shop", Some("utf8mb4; DROP DATABASE x"), None);
        assert_eq!(unknown.statement, "CREATE DATABASE `shop`;");

        // A backtick in the name cannot escape its identifier token.
        let hostile = build_create_database_plan("a`b", None, None);
        assert_eq!(hostile.statement, "CREATE DATABASE `a``b`;");
    }

    /// Verifies schema names the server would reject are refused before a statement is built.
    #[test]
    fn refuses_invalid_schema_names() {
        assert!(build_create_database_plan("   ", None, None)
            .error
            .is_some_and(|error| error.contains("不能为空")));
        assert!(build_create_database_plan("a/b", None, None)
            .error
            .is_some_and(|error| error.contains("/ \\ .")));
        assert!(build_create_database_plan("a\tb", None, None)
            .error
            .is_some_and(|error| error.contains("控制字符")));
        assert!(build_create_database_plan(&"x".repeat(65), None, None)
            .error
            .is_some_and(|error| error.contains("64")));
        // A 64-character name is accepted, and multi-byte names count characters, not bytes.
        assert_eq!(
            build_create_database_plan(&"x".repeat(64), None, None).error,
            None
        );
        assert_eq!(build_create_database_plan("库名", None, None).error, None);
        // Every advertised charset lists at least one collation.
        assert!(database_charset_options()
            .iter()
            .all(|option| !option.collations.is_empty()));
    }
}
