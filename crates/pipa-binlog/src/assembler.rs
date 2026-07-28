use pipa_core::{
    BinlogChange, BinlogOperation, BinlogTableConfidence, BinlogTransaction,
    BinlogTransactionStatus, BinlogTransactionTable,
};
use std::collections::BTreeMap;
use uuid::Uuid;

/// Physical event location and header metadata used for authoritative ordering.
#[derive(Clone, Debug)]
pub(crate) struct EventLocation {
    /// RFC 3339 event timestamp.
    pub timestamp: String,
    /// Originating MySQL server identifier.
    pub server_id: u32,
    /// Basename of the physical input file.
    pub file_name: String,
    /// Physical event start offset.
    pub start_position: u64,
    /// Physical event end offset.
    pub end_position: u64,
}

/// Stateful transaction boundary assembler shared across ordered input files.
#[derive(Debug)]
pub(crate) struct TransactionAssembler {
    analysis_id: Uuid,
    transactions: Vec<BinlogTransaction>,
    pending: Option<PendingTransaction>,
    next_sequence: u64,
    pending_rows_query: Option<String>,
}

/// Mutable transaction state retained until a commit, rollback, or incomplete boundary.
#[derive(Debug)]
struct PendingTransaction {
    timestamp: String,
    gtid: Option<String>,
    xid: Option<String>,
    server_id: u32,
    file_name: String,
    start_position: u64,
    end_position: u64,
    explicit: bool,
    changes: Vec<BinlogChange>,
}

impl TransactionAssembler {
    /// Creates an empty assembler for one stable analysis identifier.
    ///
    /// # Parameters
    /// `analysis_id` becomes part of every transaction identifier.
    pub(crate) fn new(analysis_id: Uuid) -> Self {
        Self {
            analysis_id,
            transactions: Vec::new(),
            pending: None,
            next_sequence: 1,
            pending_rows_query: None,
        }
    }

    /// Starts a new GTID transaction, closing an unterminated predecessor as incomplete.
    pub(crate) fn on_gtid(&mut self, gtid: String, location: &EventLocation) {
        if self.pending.is_some() {
            self.finish(BinlogTransactionStatus::Incomplete);
        }
        let mut pending = PendingTransaction::new(location);
        pending.gtid = Some(gtid);
        self.pending = Some(pending);
    }

    /// Marks an explicit BEGIN boundary without discarding a preceding GTID.
    pub(crate) fn on_begin(&mut self, location: &EventLocation) {
        self.ensure_pending(location);
        if let Some(pending) = self.pending.as_mut() {
            pending.explicit = true;
            pending.end_position = location.end_position;
        }
    }

    /// Retains the optional RowsQuery text for the next row mutation event.
    pub(crate) fn on_rows_query(&mut self, query: String) {
        self.pending_rows_query = Some(query);
    }

    /// Adds a precisely attributed row mutation and waits for its transaction boundary.
    pub(crate) fn on_rows(&mut self, mut change: BinlogChange, location: &EventLocation) {
        self.ensure_pending(location);
        if change.sql.is_none() {
            change.sql = self.pending_rows_query.take();
        }
        if let Some(pending) = self.pending.as_mut() {
            pending.end_position = location.end_position;
            pending.changes.push(change);
        }
    }

    /// Applies a statement boundary or adds a best-effort statement change.
    pub(crate) fn on_query(&mut self, schema: &str, query: &str, location: &EventLocation) {
        let normalized = query.trim().trim_end_matches(';').trim();
        if normalized.eq_ignore_ascii_case("BEGIN")
            || normalized.eq_ignore_ascii_case("START TRANSACTION")
        {
            self.on_begin(location);
            return;
        }
        if normalized.eq_ignore_ascii_case("COMMIT") {
            self.update_end(location);
            self.finish(BinlogTransactionStatus::Committed);
            return;
        }
        if normalized.eq_ignore_ascii_case("ROLLBACK") {
            self.update_end(location);
            self.finish(BinlogTransactionStatus::RolledBack);
            return;
        }

        let Some(change) = classify_statement(schema, normalized) else {
            self.update_end(location);
            return;
        };
        let is_ddl = change.operation == BinlogOperation::Ddl;
        self.ensure_pending(location);
        if let Some(pending) = self.pending.as_mut() {
            pending.end_position = location.end_position;
            pending.changes.push(change);
            if is_ddl || (pending.gtid.is_none() && !pending.explicit) {
                self.finish(BinlogTransactionStatus::Committed);
            }
        }
    }

    /// Commits the current transaction at an XID event.
    pub(crate) fn on_xid(&mut self, xid: u64, location: &EventLocation) {
        self.ensure_pending(location);
        if let Some(pending) = self.pending.as_mut() {
            pending.xid = Some(xid.to_string());
            pending.end_position = location.end_position;
        }
        self.finish(BinlogTransactionStatus::Committed);
    }

    /// Extends the current transaction's physical range for non-change events.
    pub(crate) fn update_end(&mut self, location: &EventLocation) {
        if let Some(pending) = self.pending.as_mut() {
            pending.end_position = location.end_position;
        }
    }

    /// Finalizes any transaction still open at the end of the last input file.
    pub(crate) fn finish_input(&mut self) {
        if self.pending.is_some() {
            self.finish(BinlogTransactionStatus::Incomplete);
        }
    }

    /// Returns the assembled transactions in stable sequence order.
    pub(crate) fn into_transactions(mut self) -> Vec<BinlogTransaction> {
        self.finish_input();
        self.transactions
    }

    /// Returns the number of transactions already closed at a terminal boundary.
    pub(crate) fn transaction_count(&self) -> u64 {
        self.transactions.len() as u64
    }

    /// Ensures a pending transaction exists for a row or statement event.
    fn ensure_pending(&mut self, location: &EventLocation) {
        if self.pending.is_none() {
            self.pending = Some(PendingTransaction::new(location));
        }
    }

    /// Converts the mutable pending state into an immutable transport transaction.
    fn finish(&mut self, status: BinlogTransactionStatus) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        self.pending_rows_query = None;
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        let row_change_count = pending.changes.iter().map(|change| change.row_count).sum();
        let tables = summarize_transaction_tables(&pending.changes);
        self.transactions.push(BinlogTransaction {
            id: format!("{}:{sequence}", self.analysis_id),
            sequence,
            timestamp: pending.timestamp,
            gtid: pending.gtid,
            xid: pending.xid,
            server_id: pending.server_id,
            file_name: pending.file_name,
            start_position: pending.start_position,
            end_position: pending.end_position,
            status,
            row_change_count,
            tables,
            changes: pending.changes,
        });
    }
}

impl PendingTransaction {
    /// Creates pending state at the first physical event in a transaction.
    fn new(location: &EventLocation) -> Self {
        Self {
            timestamp: location.timestamp.clone(),
            gtid: None,
            xid: None,
            server_id: location.server_id,
            file_name: location.file_name.clone(),
            start_position: location.start_position,
            end_position: location.end_position,
            explicit: false,
            changes: Vec::new(),
        }
    }
}

/// Classifies supported DML and DDL query events and infers their first target table.
fn classify_statement(schema: &str, query: &str) -> Option<BinlogChange> {
    let tokens = query.split_whitespace().collect::<Vec<_>>();
    let first = tokens.first()?.to_ascii_uppercase();
    let (operation, table_token) = match first.as_str() {
        "INSERT" | "REPLACE" => (
            BinlogOperation::Insert,
            token_after_keyword(&tokens, "INTO"),
        ),
        "UPDATE" => (BinlogOperation::Update, tokens.get(1).copied()),
        "DELETE" => (
            BinlogOperation::Delete,
            token_after_keyword(&tokens, "FROM"),
        ),
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" => {
            (BinlogOperation::Ddl, token_after_keyword(&tokens, "TABLE"))
        }
        _ => return None,
    };
    let (database, table, confidence) = table_token
        .and_then(parse_qualified_table)
        .map(|(database, table)| {
            (
                database.unwrap_or_else(|| schema.to_owned()),
                table,
                BinlogTableConfidence::SqlParsed,
            )
        })
        .unwrap_or_else(|| {
            (
                schema.to_owned(),
                String::new(),
                BinlogTableConfidence::Unknown,
            )
        });

    Some(BinlogChange {
        database,
        table,
        operation,
        row_count: 0,
        columns: Vec::new(),
        rows: Vec::new(),
        table_confidence: confidence,
        sql: Some(query.to_owned()),
    })
}

/// Finds the first token following a case-insensitive SQL keyword.
fn token_after_keyword<'a>(tokens: &'a [&str], keyword: &str) -> Option<&'a str> {
    tokens
        .windows(2)
        .find(|pair| pair[0].eq_ignore_ascii_case(keyword))
        .map(|pair| pair[1])
        .and_then(|token| {
            if token.eq_ignore_ascii_case("IF") {
                None
            } else {
                Some(token)
            }
        })
        .or_else(|| {
            let keyword_position = tokens
                .iter()
                .position(|token| token.eq_ignore_ascii_case(keyword))?;
            tokens
                .iter()
                .skip(keyword_position + 1)
                .copied()
                .find(|token| {
                    !token.eq_ignore_ascii_case("IF")
                        && !token.eq_ignore_ascii_case("NOT")
                        && !token.eq_ignore_ascii_case("EXISTS")
                })
        })
}

/// Normalizes one optionally qualified and backtick-quoted table token.
fn parse_qualified_table(token: &str) -> Option<(Option<String>, String)> {
    let token =
        token.trim_matches(|character: char| matches!(character, '`' | ',' | ';' | '(' | ')'));
    if token.is_empty() {
        return None;
    }
    let parts = token
        .split('.')
        .map(|part| part.trim_matches('`').to_owned())
        .collect::<Vec<_>>();
    match parts.as_slice() {
        [table] if !table.is_empty() => Some((None, table.clone())),
        [database, table] if !database.is_empty() && !table.is_empty() => {
            Some((Some(database.clone()), table.clone()))
        }
        _ => None,
    }
}

/// Aggregates repeated changes by database and table without losing transaction change order.
fn summarize_transaction_tables(changes: &[BinlogChange]) -> Vec<BinlogTransactionTable> {
    let mut tables = BTreeMap::<(String, String), BinlogTransactionTable>::new();
    for change in changes {
        if change.table.is_empty() {
            continue;
        }
        let table = tables
            .entry((change.database.clone(), change.table.clone()))
            .or_insert_with(|| BinlogTransactionTable {
                database: change.database.clone(),
                table: change.table.clone(),
                insert_count: 0,
                update_count: 0,
                delete_count: 0,
                ddl_count: 0,
                row_change_count: 0,
            });
        table.row_change_count += change.row_count;
        match change.operation {
            BinlogOperation::Insert => table.insert_count += change.row_count,
            BinlogOperation::Update => table.update_count += change.row_count,
            BinlogOperation::Delete => table.delete_count += change.row_count,
            BinlogOperation::Ddl => table.ddl_count += 1,
        }
    }
    tables.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::{EventLocation, TransactionAssembler};
    use pipa_core::{
        BinlogCell, BinlogChange, BinlogOperation, BinlogRowChange, BinlogTableConfidence,
        BinlogTransactionStatus, CellValue,
    };
    use std::collections::BTreeMap;
    use uuid::Uuid;

    /// Creates a stable event location for transaction assembler tests.
    fn location(position: u64) -> EventLocation {
        EventLocation {
            timestamp: "2026-01-01T00:00:00Z".into(),
            server_id: 7,
            file_name: "mysql-bin.000001".into(),
            start_position: position,
            end_position: position + 10,
        }
    }

    /// Creates one exact UPDATE row event with distinct before and after images.
    fn update_change() -> BinlogChange {
        BinlogChange {
            database: "sales".into(),
            table: "orders".into(),
            operation: BinlogOperation::Update,
            row_count: 1,
            columns: vec!["id".into(), "status".into()],
            rows: vec![BinlogRowChange {
                before: Some(BTreeMap::from([
                    (
                        "id".into(),
                        BinlogCell::Value {
                            value: CellValue::Integer("42".into()),
                        },
                    ),
                    (
                        "status".into(),
                        BinlogCell::Value {
                            value: CellValue::Text("pending".into()),
                        },
                    ),
                ])),
                after: Some(BTreeMap::from([
                    ("id".into(), BinlogCell::NotLogged),
                    (
                        "status".into(),
                        BinlogCell::Value {
                            value: CellValue::Text("paid".into()),
                        },
                    ),
                ])),
            }],
            table_confidence: BinlogTableConfidence::Exact,
            sql: None,
        }
    }

    /// Verifies GTID, row images, XID, and table impact form one committed transaction.
    #[test]
    fn row_events_are_assembled_into_one_committed_transaction() {
        let analysis_id = Uuid::new_v4();
        let mut assembler = TransactionAssembler::new(analysis_id);
        assembler.on_gtid(
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:9".into(),
            &location(4),
        );
        assembler.on_rows(update_change(), &location(40));
        assembler.on_xid(91, &location(80));

        let transactions = assembler.into_transactions();

        assert_eq!(transactions.len(), 1);
        assert_eq!(transactions[0].id, format!("{analysis_id}:1"));
        assert_eq!(transactions[0].status, BinlogTransactionStatus::Committed);
        assert_eq!(transactions[0].xid.as_deref(), Some("91"));
        assert_eq!(transactions[0].row_change_count, 1);
        assert_eq!(
            transactions[0].changes[0].rows[0]
                .before
                .as_ref()
                .unwrap()
                .len(),
            2
        );
        assert!(matches!(
            transactions[0].changes[0].rows[0].after.as_ref().unwrap()["id"],
            BinlogCell::NotLogged
        ));
    }

    /// Verifies an unterminated transaction is preserved and marked incomplete.
    #[test]
    fn end_of_input_preserves_incomplete_transaction() {
        let mut assembler = TransactionAssembler::new(Uuid::new_v4());
        assembler.on_begin(&location(4));
        assembler.on_rows(update_change(), &location(40));

        let transactions = assembler.into_transactions();

        assert_eq!(transactions.len(), 1);
        assert_eq!(transactions[0].status, BinlogTransactionStatus::Incomplete);
    }

    /// Verifies statement events are classified without claiming exact TableMap evidence.
    #[test]
    fn statement_query_uses_sql_parsed_table_confidence() {
        let mut assembler = TransactionAssembler::new(Uuid::new_v4());
        assembler.on_query(
            "sales",
            "UPDATE `orders` SET status = 'paid' WHERE id = 42",
            &location(4),
        );

        let transactions = assembler.into_transactions();

        assert_eq!(transactions.len(), 1);
        assert_eq!(transactions[0].changes[0].table, "orders");
        assert_eq!(
            transactions[0].changes[0].table_confidence,
            BinlogTableConfidence::SqlParsed
        );
    }

    /// Verifies an unclassified statement still extends an existing transaction boundary.
    #[test]
    fn unclassified_statement_extends_pending_transaction_position() {
        let mut assembler = TransactionAssembler::new(Uuid::new_v4());
        assembler.on_begin(&location(4));
        assembler.on_query("sales", "SET @flag = 1", &location(100));

        let transactions = assembler.into_transactions();

        assert_eq!(transactions[0].end_position, 110);
        assert!(transactions[0].tables.is_empty());
    }
}
