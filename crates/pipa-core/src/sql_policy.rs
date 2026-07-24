//! SQL risk classification used by MCP and other guarded execution paths.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use ts_rs::TS;

/// Dangerous MySQL command keywords, clauses, and side-effect functions denied to MCP.
static DANGEROUS_SQL_KEYWORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?ix)
        \b(?:
            ALTER|ANALYZE|BACKUP|BEGIN|BINLOG|CACHE|CALL|CHANGE|CHECK|CHECKSUM|CLONE|
            COMMIT|CREATE|DEALLOCATE|DECLARE|DELETE|DO|DROP|EXEC|EXECUTE|FLUSH|GRANT|
            HANDLER|IMPORT|INSERT|INSTALL|KILL|LOAD|LOCK|MERGE|OPTIMIZE|PREPARE|
            PURGE|RELEASE|RENAME|REPAIR|REPLACE|RESET|RESTART|RESTORE|RESIGNAL|
            REVOKE|ROLLBACK|SAVEPOINT|SET|SHUTDOWN|SIGNAL|START|STOP|TRUNCATE|
            UNINSTALL|UNLOCK|
            UPDATE|UPSERT|USE|XA|
            OUTFILE|DUMPFILE|INFILE|LOAD_FILE|
            GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS|
            SLEEP|BENCHMARK|MASTER_POS_WAIT|SOURCE_POS_WAIT|WAIT_FOR_EXECUTED_GTID_SET
        )\b|
        \bFOR\s+SHARE\b",
    )
    .expect("dangerous SQL keyword regex must compile")
});

/// Who initiated a query execution request.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ExecutionSource {
    /// Desktop UI (query workspace, MCP console manual run, confirmed proposal).
    Ui,
    /// External MCP client tool call.
    Mcp,
}

/// Risk class of one SQL statement for policy gating.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SqlRisk {
    /// Safe for MCP auto-execution (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH…SELECT).
    Read,
    /// Data-changing DML (INSERT / UPDATE / DELETE / REPLACE / MERGE).
    WriteData,
    /// Schema or privilege changing DDL/admin SQL.
    SchemaChange,
    /// Unrecognized, multi-statement, or otherwise unsafe to auto-run.
    Unknown,
}

impl SqlRisk {
    /// Returns whether MCP may execute this statement without user confirmation.
    pub fn allows_mcp_auto_execute(self) -> bool {
        matches!(self, Self::Read)
    }
}

/// SQL tokens needed for conservative statement classification.
#[derive(Clone, Debug, Eq, PartialEq)]
enum SqlToken {
    /// Unquoted ASCII word normalized to uppercase.
    Word(String),
    /// String literal or quoted identifier whose contents cannot contain SQL structure.
    Atom,
    /// Opening parenthesis.
    OpenParen,
    /// Closing parenthesis.
    CloseParen,
    /// Statement separator.
    Semicolon,
    /// Other ASCII punctuation retained to preserve keyword adjacency.
    Symbol(u8),
}

/// Classifies SQL for MCP / guarded execution.
///
/// The lexer evaluates both MySQL backslash-escape modes and fails closed when their token
/// boundaries differ. MySQL executable comments and multiple statements are never auto-run.
pub fn classify_sql(sql: &str) -> SqlRisk {
    let Some(tokens) = lex_consistently(sql) else {
        return SqlRisk::Unknown;
    };
    let Some(statement) = single_statement(&tokens) else {
        return SqlRisk::Unknown;
    };
    if statement.is_empty() || !parentheses_are_balanced(statement) {
        return SqlRisk::Unknown;
    }

    classify_statement(statement)
}

/// Returns whether an MCP-sourced request may proceed to the database adapter.
pub fn mcp_may_execute(sql: &str) -> Result<(), SqlRisk> {
    let risk = classify_sql(sql);
    if contains_dangerous_sql_keyword(sql) {
        return Err(if risk == SqlRisk::Read {
            SqlRisk::Unknown
        } else {
            risk
        });
    }
    if !risk.allows_mcp_auto_execute() {
        return Err(risk);
    }
    Ok(())
}

/// Checks dangerous whole-word tokens after removing quoted content and inert comments.
fn contains_dangerous_sql_keyword(sql: &str) -> bool {
    let Some(tokens) = lex_consistently(sql) else {
        return true;
    };
    let words = tokens
        .iter()
        .filter_map(|token| match token {
            SqlToken::Word(word) => Some(word.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ");
    DANGEROUS_SQL_KEYWORDS.is_match(&words)
}

/// Tokenizes under both possible backslash-escape modes and accepts only an identical result.
fn lex_consistently(sql: &str) -> Option<Vec<SqlToken>> {
    let escaped = lex_mysql(sql, true).ok()?;
    let literal_backslashes = lex_mysql(sql, false).ok()?;
    (escaped == literal_backslashes).then_some(escaped)
}

/// Tokenizes the small MySQL lexical subset needed by the policy.
fn lex_mysql(sql: &str, backslash_escapes: bool) -> Result<Vec<SqlToken>, ()> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            byte if byte.is_ascii_whitespace() => index += 1,
            b'\'' | b'"' => {
                index = consume_quoted(bytes, index, bytes[index], backslash_escapes)?;
                tokens.push(SqlToken::Atom);
            }
            b'`' => {
                index = consume_quoted(bytes, index, b'`', false)?;
                tokens.push(SqlToken::Atom);
            }
            b'#' => index = consume_line_comment(bytes, index + 1),
            b'-' if bytes.get(index + 1) == Some(&b'-')
                && bytes
                    .get(index + 2)
                    .is_some_and(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control()) =>
            {
                index = consume_line_comment(bytes, index + 2);
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                if is_executable_comment(bytes, index) {
                    return Err(());
                }
                index = consume_block_comment(bytes, index + 2)?;
            }
            b'(' => {
                tokens.push(SqlToken::OpenParen);
                index += 1;
            }
            b')' => {
                tokens.push(SqlToken::CloseParen);
                index += 1;
            }
            b';' => {
                tokens.push(SqlToken::Semicolon);
                index += 1;
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'_' | b'$'))
                {
                    index += 1;
                }
                tokens.push(SqlToken::Word(sql[start..index].to_ascii_uppercase()));
            }
            byte if byte.is_ascii_punctuation() => {
                tokens.push(SqlToken::Symbol(byte));
                index += 1;
            }
            _ => index += 1,
        }
    }

    Ok(tokens)
}

/// Consumes one quoted literal or identifier and returns the first following byte index.
fn consume_quoted(
    bytes: &[u8],
    mut index: usize,
    quote: u8,
    backslash_escapes: bool,
) -> Result<usize, ()> {
    index += 1;
    while index < bytes.len() {
        if backslash_escapes && bytes[index] == b'\\' {
            if index + 1 >= bytes.len() {
                return Err(());
            }
            index += 2;
            continue;
        }
        if bytes[index] == quote {
            if bytes.get(index + 1) == Some(&quote) {
                index += 2;
                continue;
            }
            return Ok(index + 1);
        }
        index += 1;
    }
    Err(())
}

/// Consumes a line comment through, but not including, its newline.
fn consume_line_comment(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index] != b'\n' {
        index += 1;
    }
    index
}

/// Returns whether a block comment is executable MySQL or MariaDB syntax.
fn is_executable_comment(bytes: &[u8], index: usize) -> bool {
    bytes.get(index + 2) == Some(&b'!')
        || matches!(bytes.get(index + 2), Some(b'M' | b'm')) && bytes.get(index + 3) == Some(&b'!')
}

/// Consumes a non-executable block comment and rejects an unterminated comment.
fn consume_block_comment(bytes: &[u8], mut index: usize) -> Result<usize, ()> {
    while index + 1 < bytes.len() {
        if bytes[index] == b'*' && bytes[index + 1] == b'/' {
            return Ok(index + 2);
        }
        index += 1;
    }
    Err(())
}

/// Returns the sole statement tokens, permitting one optional trailing semicolon.
fn single_statement(tokens: &[SqlToken]) -> Option<&[SqlToken]> {
    let semicolons: Vec<usize> = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| matches!(token, SqlToken::Semicolon).then_some(index))
        .collect();
    match semicolons.as_slice() {
        [] => Some(tokens),
        [index] if *index + 1 == tokens.len() => Some(&tokens[..*index]),
        _ => None,
    }
}

/// Checks structural parentheses after quoted content and comments have been removed.
fn parentheses_are_balanced(tokens: &[SqlToken]) -> bool {
    let mut depth = 0_u32;
    for token in tokens {
        match token {
            SqlToken::OpenParen => depth = depth.saturating_add(1),
            SqlToken::CloseParen if depth == 0 => return false,
            SqlToken::CloseParen => depth -= 1,
            _ => {}
        }
    }
    depth == 0
}

/// Classifies one already-tokenized statement by its leading keyword.
fn classify_statement(tokens: &[SqlToken]) -> SqlRisk {
    let Some(SqlToken::Word(first)) = tokens.first() else {
        return SqlRisk::Unknown;
    };
    match first.as_str() {
        "SELECT" => classify_select(tokens),
        "SHOW" => SqlRisk::Read,
        "DESCRIBE" | "DESC" => classify_describe(&tokens[1..]),
        "EXPLAIN" => classify_explain_body(&tokens[1..]),
        "WITH" => classify_with(tokens),
        "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "MERGE" => SqlRisk::WriteData,
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "GRANT" | "REVOKE" | "CALL"
        | "LOAD" | "IMPORT" | "HANDLER" | "LOCK" | "UNLOCK" | "SET" | "USE" | "START" | "BEGIN"
        | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "FLUSH" | "RESET" | "PURGE"
        | "ANALYZE" | "OPTIMIZE" | "REPAIR" | "CHECK" | "CHECKSUM" | "BACKUP" | "RESTORE"
        | "KILL" | "DO" | "EXECUTE" | "PREPARE" | "DEALLOCATE" | "XA" => SqlRisk::SchemaChange,
        _ => SqlRisk::Unknown,
    }
}

/// Classifies SELECT while rejecting server-side file export forms.
fn classify_select(tokens: &[SqlToken]) -> SqlRisk {
    if contains_adjacent_words(tokens, "INTO", "OUTFILE")
        || contains_adjacent_words(tokens, "INTO", "DUMPFILE")
    {
        SqlRisk::SchemaChange
    } else {
        SqlRisk::Read
    }
}

/// Classifies DESCRIBE/DESC as table inspection unless it uses EXPLAIN-style syntax.
fn classify_describe(body: &[SqlToken]) -> SqlRisk {
    let explain_style = matches!(
        body.first(),
        Some(SqlToken::Word(word))
            if matches!(
                word.as_str(),
                "ANALYZE"
                    | "FORMAT"
                    | "SELECT"
                    | "WITH"
                    | "INSERT"
                    | "UPDATE"
                    | "DELETE"
                    | "REPLACE"
                    | "MERGE"
                    | "FOR"
            )
    );
    if explain_style {
        classify_explain_body(body)
    } else if body.is_empty() {
        SqlRisk::Unknown
    } else {
        SqlRisk::Read
    }
}

/// Classifies the statement body following EXPLAIN, DESCRIBE, or DESC.
fn classify_explain_body(body: &[SqlToken]) -> SqlRisk {
    let mut index = 0;
    loop {
        match body.get(index) {
            Some(SqlToken::Word(word)) if word == "ANALYZE" => index += 1,
            Some(SqlToken::Word(word)) if word == "FORMAT" => {
                index += 1;
                if matches!(body.get(index), Some(SqlToken::Symbol(b'='))) {
                    index += 1;
                }
                if matches!(body.get(index), Some(SqlToken::Word(_) | SqlToken::Atom)) {
                    index += 1;
                }
            }
            _ => break,
        }
    }

    let remaining = &body[index..];
    let Some(SqlToken::Word(first)) = remaining.first() else {
        return SqlRisk::Unknown;
    };
    match first.as_str() {
        "SELECT" => classify_select(remaining),
        "SHOW" | "DESCRIBE" | "DESC" | "TABLE" => SqlRisk::Read,
        "WITH" => classify_with(remaining),
        "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "MERGE" => SqlRisk::WriteData,
        "FOR"
            if matches!(
                remaining.get(1),
                Some(SqlToken::Word(word)) if word == "CONNECTION"
            ) =>
        {
            SqlRisk::Read
        }
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "GRANT" | "REVOKE" | "CALL"
        | "LOAD" | "IMPORT" | "SET" | "ANALYZE" | "OPTIMIZE" | "REPAIR" | "CHECK" => {
            SqlRisk::SchemaChange
        }
        _ => SqlRisk::Unknown,
    }
}

/// Classifies a CTE by finding its first top-level statement verb.
fn classify_with(tokens: &[SqlToken]) -> SqlRisk {
    let mut depth = 0_u32;
    for (index, token) in tokens.iter().enumerate().skip(1) {
        match token {
            SqlToken::OpenParen => depth += 1,
            SqlToken::CloseParen => depth -= 1,
            SqlToken::Word(word) if depth == 0 => match word.as_str() {
                "SELECT" => return classify_select(&tokens[index..]),
                "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "MERGE" => {
                    return SqlRisk::WriteData;
                }
                _ => {}
            },
            _ => {}
        }
    }
    SqlRisk::Unknown
}

/// Returns whether two whole-word tokens appear directly next to each other.
fn contains_adjacent_words(tokens: &[SqlToken], first: &str, second: &str) -> bool {
    tokens.windows(2).any(|pair| {
        matches!(
            pair,
            [SqlToken::Word(left), SqlToken::Word(right)]
                if left == first && right == second
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{classify_sql, mcp_may_execute, SqlRisk};

    #[test]
    fn classifies_basic_reads() {
        assert_eq!(classify_sql("SELECT 1"), SqlRisk::Read);
        assert_eq!(classify_sql("  select * from t "), SqlRisk::Read);
        assert_eq!(classify_sql("SHOW TABLES;"), SqlRisk::Read);
        assert_eq!(classify_sql("DESCRIBE users"), SqlRisk::Read);
        assert_eq!(classify_sql("DESC `users`"), SqlRisk::Read);
        assert_eq!(classify_sql("EXPLAIN SELECT 1"), SqlRisk::Read);
        assert_eq!(
            classify_sql("WITH cte AS (SELECT 1 AS n) SELECT * FROM cte"),
            SqlRisk::Read
        );
    }

    #[test]
    fn classifies_writes_and_schema() {
        assert_eq!(classify_sql("UPDATE t SET a=1"), SqlRisk::WriteData);
        assert_eq!(classify_sql("DELETE FROM t"), SqlRisk::WriteData);
        assert_eq!(classify_sql("INSERT INTO t VALUES (1)"), SqlRisk::WriteData);
        assert_eq!(classify_sql("DROP TABLE t"), SqlRisk::SchemaChange);
        assert_eq!(
            classify_sql("CREATE TABLE t (id INT)"),
            SqlRisk::SchemaChange
        );
        assert_eq!(classify_sql("TRUNCATE TABLE t"), SqlRisk::SchemaChange);
        assert_eq!(classify_sql("GRANT ALL ON t TO u"), SqlRisk::SchemaChange);
        assert_eq!(classify_sql("CALL proc()"), SqlRisk::SchemaChange);
    }

    #[test]
    fn comments_cannot_hide_write() {
        assert_eq!(
            classify_sql("-- SELECT 1\nUPDATE t SET a=1"),
            SqlRisk::WriteData
        );
        assert_eq!(
            classify_sql("/* SELECT 1 */ DELETE FROM t"),
            SqlRisk::WriteData
        );
        assert_eq!(
            classify_sql("# SELECT\nDROP TABLE t"),
            SqlRisk::SchemaChange
        );
    }

    #[test]
    fn multi_statement_is_unknown() {
        assert_eq!(classify_sql("SELECT 1; SELECT 2"), SqlRisk::Unknown);
        assert_eq!(classify_sql("SELECT 1; DELETE FROM t"), SqlRisk::Unknown);
    }

    #[test]
    fn with_write_is_write_data() {
        assert_eq!(
            classify_sql(
                "WITH cte AS (SELECT 1 AS id) DELETE FROM t WHERE id IN (SELECT id FROM cte)"
            ),
            SqlRisk::WriteData
        );
        assert_eq!(
            classify_sql("WITH cte AS (SELECT 1 AS id) INSERT INTO t SELECT * FROM cte"),
            SqlRisk::WriteData
        );
        assert_eq!(
            classify_sql("WITH cte AS (SELECT ')SELECT' AS id) UPDATE t SET id = 1"),
            SqlRisk::WriteData
        );
    }

    #[test]
    fn mcp_gate_allows_only_read() {
        assert!(mcp_may_execute("SELECT 1").is_ok());
        assert_eq!(mcp_may_execute("UPDATE t SET a=1"), Err(SqlRisk::WriteData));
        assert_eq!(mcp_may_execute("DELETE FROM t"), Err(SqlRisk::WriteData));
        assert_eq!(mcp_may_execute("DROP TABLE t"), Err(SqlRisk::SchemaChange));
        assert_eq!(mcp_may_execute(""), Err(SqlRisk::Unknown));
    }

    #[test]
    fn mcp_gate_rejects_dangerous_keywords_inside_read_statements() {
        for sql in [
            "SELECT * FROM users FOR UPDATE",
            "SHOW CREATE TABLE users",
            "EXPLAIN ANALYZE SELECT * FROM users",
            "SELECT GET_LOCK('pipa', 1)",
            "SELECT RELEASE_LOCK('pipa')",
            "SELECT SLEEP(1)",
            "SELECT BENCHMARK(1, SHA2('pipa', 256))",
            "SELECT LOAD_FILE('/etc/passwd')",
        ] {
            assert!(
                mcp_may_execute(sql).is_err(),
                "dangerous SQL should be rejected: {sql}"
            );
        }
    }

    #[test]
    fn mcp_dangerous_keyword_regex_ignores_quoted_content_and_partial_words() {
        for sql in [
            "SELECT 'DELETE DROP SLEEP' AS message",
            "SELECT `delete` FROM users",
            "SELECT deleted_at, updated_at FROM users",
            "SELECT 1 /* DROP TABLE users */",
        ] {
            assert!(
                mcp_may_execute(sql).is_ok(),
                "non-executable keyword text should remain readable: {sql}"
            );
        }
    }

    #[test]
    fn string_semicolon_is_not_multi_statement() {
        assert_eq!(classify_sql("SELECT 'a;b' AS x FROM dual"), SqlRisk::Read);
    }

    #[test]
    fn explain_analyze_write_is_not_read() {
        assert_eq!(classify_sql("EXPLAIN SELECT 1"), SqlRisk::Read);
        assert_eq!(
            classify_sql("EXPLAIN ANALYZE SELECT 1 FROM t"),
            SqlRisk::Read
        );
        assert_eq!(
            classify_sql("EXPLAIN ANALYZE DELETE FROM t WHERE id = 1"),
            SqlRisk::WriteData
        );
        assert_eq!(
            classify_sql("EXPLAIN FORMAT=TREE UPDATE t SET a = 1"),
            SqlRisk::WriteData
        );
        assert_eq!(
            mcp_may_execute("EXPLAIN ANALYZE DELETE FROM t"),
            Err(SqlRisk::WriteData)
        );
    }

    #[test]
    fn select_into_outfile_is_not_read() {
        assert_eq!(
            classify_sql("SELECT * FROM t INTO OUTFILE '/tmp/x.csv'"),
            SqlRisk::SchemaChange
        );
        assert_eq!(
            classify_sql("SELECT a INTO DUMPFILE '/tmp/a.bin' FROM t"),
            SqlRisk::SchemaChange
        );
        assert_eq!(
            classify_sql("SELECT id INTO @outfile FROM t LIMIT 1"),
            SqlRisk::Read
        );
        assert_eq!(
            mcp_may_execute("SELECT 1 INTO OUTFILE '/tmp/x'"),
            Err(SqlRisk::SchemaChange)
        );
    }

    #[test]
    fn mysql_lexical_edge_cases_fail_closed() {
        assert_eq!(classify_sql("SELECT 1--1; DELETE FROM t"), SqlRisk::Unknown);
        assert_eq!(
            classify_sql("SELECT 1 /*! INTO OUTFILE '/tmp/pipa' */"),
            SqlRisk::Unknown
        );
        assert_eq!(
            classify_sql(r"SELECT '\'x'; DELETE FROM t"),
            SqlRisk::Unknown
        );
    }

    #[test]
    fn describe_analyze_write_is_not_read() {
        assert_eq!(
            classify_sql("DESC ANALYZE DELETE t FROM t JOIN u ON u.id = t.id"),
            SqlRisk::WriteData
        );
    }
}
