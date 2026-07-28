use pipa_core::{
    BinlogOperation, BinlogSummary, BinlogTransaction, BinlogTransactionFilter,
    BinlogTransactionPage, BinlogTransactionSummary,
};
use std::{
    collections::HashMap,
    sync::{PoisonError, RwLock},
};
use uuid::Uuid;

const DEFAULT_PAGE_SIZE: usize = 100;
const MAX_PAGE_SIZE: usize = 500;

/// Complete in-process data retained for one analysis session.
#[derive(Clone, Debug)]
pub struct AnalysisSession {
    /// Mutable summary reflecting the session's terminal or parsing state.
    pub summary: BinlogSummary,
    /// Transactions ordered by their stable sequence.
    pub transactions: Vec<BinlogTransaction>,
}

/// Repository failures exposed to the application transport.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RepositoryError {
    /// The requested analysis does not exist.
    #[error("Binlog analysis was not found")]
    NotFound,
    /// A live session already uses the supplied identifier.
    #[error("Binlog analysis already exists")]
    AlreadyExists,
    /// A pagination cursor was not produced by this repository.
    #[error("Binlog transaction cursor is invalid")]
    InvalidCursor,
    /// The process-wide repository lock was poisoned by a prior panic.
    #[error("Binlog analysis repository is unavailable")]
    Unavailable,
}

/// Storage boundary for ephemeral binlog summaries and transaction pages.
pub trait AnalysisRepository: Send + Sync {
    /// Registers an empty session before its background parser starts.
    fn create(&self, summary: BinlogSummary) -> Result<(), RepositoryError>;

    /// Atomically replaces one session with its latest parser output.
    fn replace(
        &self,
        summary: BinlogSummary,
        transactions: Vec<BinlogTransaction>,
    ) -> Result<(), RepositoryError>;

    /// Returns a cloned summary without exposing the full transaction collection.
    fn get_summary(&self, analysis_id: Uuid) -> Result<BinlogSummary, RepositoryError>;

    /// Applies exact filters and returns one bounded cursor page.
    fn list_transactions(
        &self,
        analysis_id: Uuid,
        filter: BinlogTransactionFilter,
    ) -> Result<BinlogTransactionPage, RepositoryError>;

    /// Returns one full transaction projected through the active timeline filter.
    fn get_transaction(
        &self,
        analysis_id: Uuid,
        sequence: u64,
        filter: BinlogTransactionFilter,
    ) -> Result<BinlogTransaction, RepositoryError>;

    /// Idempotently removes one session and all row values retained by it.
    fn close(&self, analysis_id: Uuid) -> Result<(), RepositoryError>;
}

/// Thread-safe ephemeral repository that can later be replaced by a SQLCipher implementation.
#[derive(Debug, Default)]
pub struct InMemoryAnalysisRepository {
    sessions: RwLock<HashMap<Uuid, AnalysisSession>>,
}

impl InMemoryAnalysisRepository {
    /// Creates an empty repository.
    ///
    /// # Returns
    /// A repository with no analysis sessions.
    pub fn new() -> Self {
        Self::default()
    }
}

impl AnalysisRepository for InMemoryAnalysisRepository {
    /// Registers an empty session before its background parser starts.
    fn create(&self, summary: BinlogSummary) -> Result<(), RepositoryError> {
        let mut sessions = self.sessions.write().map_err(lock_error)?;
        if sessions.contains_key(&summary.analysis_id) {
            return Err(RepositoryError::AlreadyExists);
        }
        sessions.insert(
            summary.analysis_id,
            AnalysisSession {
                summary,
                transactions: Vec::new(),
            },
        );
        Ok(())
    }

    /// Atomically replaces one session with its latest parser output.
    fn replace(
        &self,
        summary: BinlogSummary,
        transactions: Vec<BinlogTransaction>,
    ) -> Result<(), RepositoryError> {
        let mut sessions = self.sessions.write().map_err(lock_error)?;
        let session = sessions
            .get_mut(&summary.analysis_id)
            .ok_or(RepositoryError::NotFound)?;
        *session = AnalysisSession {
            summary,
            transactions,
        };
        Ok(())
    }

    /// Returns a cloned summary without exposing the full transaction collection.
    fn get_summary(&self, analysis_id: Uuid) -> Result<BinlogSummary, RepositoryError> {
        self.sessions
            .read()
            .map_err(lock_error)?
            .get(&analysis_id)
            .map(|session| session.summary.clone())
            .ok_or(RepositoryError::NotFound)
    }

    /// Applies exact filters and returns one bounded cursor page.
    fn list_transactions(
        &self,
        analysis_id: Uuid,
        filter: BinlogTransactionFilter,
    ) -> Result<BinlogTransactionPage, RepositoryError> {
        let sessions = self.sessions.read().map_err(lock_error)?;
        let session = sessions
            .get(&analysis_id)
            .ok_or(RepositoryError::NotFound)?;
        paginate_transactions(&session.transactions, &filter)
    }

    /// Returns one full transaction projected through the active timeline filter.
    fn get_transaction(
        &self,
        analysis_id: Uuid,
        sequence: u64,
        filter: BinlogTransactionFilter,
    ) -> Result<BinlogTransaction, RepositoryError> {
        let sessions = self.sessions.read().map_err(lock_error)?;
        let session = sessions
            .get(&analysis_id)
            .ok_or(RepositoryError::NotFound)?;
        session
            .transactions
            .iter()
            .find(|transaction| transaction.sequence == sequence)
            .and_then(|transaction| project_transaction(transaction, &filter))
            .ok_or(RepositoryError::NotFound)
    }

    /// Idempotently removes one session and all row values retained by it.
    fn close(&self, analysis_id: Uuid) -> Result<(), RepositoryError> {
        self.sessions
            .write()
            .map_err(lock_error)?
            .remove(&analysis_id);
        Ok(())
    }
}

/// Applies exact table and operation filters before stable cursor pagination.
fn paginate_transactions(
    transactions: &[BinlogTransaction],
    filter: &BinlogTransactionFilter,
) -> Result<BinlogTransactionPage, RepositoryError> {
    let after_sequence = filter
        .cursor
        .as_deref()
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|_| RepositoryError::InvalidCursor)?
        .unwrap_or(0);
    let limit = filter
        .limit
        .map(|limit| limit as usize)
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);

    let mut matching = transactions
        .iter()
        .filter(|transaction| transaction.sequence > after_sequence)
        .filter_map(|transaction| summarize_transaction(transaction, filter))
        .take(limit + 1)
        .collect::<Vec<_>>();
    let has_more = matching.len() > limit;
    if has_more {
        matching.pop();
    }
    let next_cursor = has_more
        .then(|| {
            matching
                .last()
                .map(|transaction| transaction.sequence.to_string())
        })
        .flatten();

    Ok(BinlogTransactionPage {
        items: matching,
        next_cursor,
    })
}

/// Builds timeline metadata without cloning row images that are not yet visible.
fn summarize_transaction(
    transaction: &BinlogTransaction,
    filter: &BinlogTransactionFilter,
) -> Option<BinlogTransactionSummary> {
    let has_database_filter = filter
        .database
        .as_deref()
        .is_some_and(|value| !value.is_empty());
    let has_table_filter = filter
        .table
        .as_deref()
        .is_some_and(|value| !value.is_empty());
    let row_change_count =
        if !has_database_filter && !has_table_filter && filter.operation.is_none() {
            transaction.row_change_count
        } else {
            let mut matched = false;
            let row_change_count = transaction
                .changes
                .iter()
                .filter(|change| {
                    let matches =
                        optional_exact_match(filter.database.as_deref(), &change.database)
                            && optional_exact_match(filter.table.as_deref(), &change.table)
                            && optional_operation_match(filter.operation, change.operation);
                    matched |= matches;
                    matches
                })
                .map(|change| change.row_count)
                .sum();
            if !matched {
                return None;
            }
            row_change_count
        };

    Some(BinlogTransactionSummary {
        id: transaction.id.clone(),
        sequence: transaction.sequence,
        timestamp: transaction.timestamp.clone(),
        gtid: transaction.gtid.clone(),
        xid: transaction.xid.clone(),
        server_id: transaction.server_id,
        file_name: transaction.file_name.clone(),
        start_position: transaction.start_position,
        end_position: transaction.end_position,
        status: transaction.status,
        row_change_count,
        tables: transaction.tables.clone(),
    })
}

/// Returns an optionally filtered transaction while retaining its full table-impact context.
fn project_transaction(
    transaction: &BinlogTransaction,
    filter: &BinlogTransactionFilter,
) -> Option<BinlogTransaction> {
    let has_database_filter = filter
        .database
        .as_deref()
        .is_some_and(|value| !value.is_empty());
    let has_table_filter = filter
        .table
        .as_deref()
        .is_some_and(|value| !value.is_empty());
    if !has_database_filter && !has_table_filter && filter.operation.is_none() {
        return Some(transaction.clone());
    }
    let changes = transaction
        .changes
        .iter()
        .filter(|change| {
            optional_exact_match(filter.database.as_deref(), &change.database)
                && optional_exact_match(filter.table.as_deref(), &change.table)
                && optional_operation_match(filter.operation, change.operation)
        })
        .cloned()
        .collect::<Vec<_>>();
    if changes.is_empty() {
        return None;
    }
    Some(BinlogTransaction {
        id: transaction.id.clone(),
        sequence: transaction.sequence,
        timestamp: transaction.timestamp.clone(),
        gtid: transaction.gtid.clone(),
        xid: transaction.xid.clone(),
        server_id: transaction.server_id,
        file_name: transaction.file_name.clone(),
        start_position: transaction.start_position,
        end_position: transaction.end_position,
        status: transaction.status,
        row_change_count: changes.iter().map(|change| change.row_count).sum(),
        tables: transaction.tables.clone(),
        changes,
    })
}

/// Treats `None` and an empty filter value as unrestricted, otherwise compares exactly.
fn optional_exact_match(filter: Option<&str>, actual: &str) -> bool {
    filter
        .filter(|value| !value.is_empty())
        .is_none_or(|expected| expected == actual)
}

/// Treats a missing operation as unrestricted, otherwise compares exact enum values.
fn optional_operation_match(expected: Option<BinlogOperation>, actual: BinlogOperation) -> bool {
    expected.is_none_or(|expected| expected == actual)
}

/// Maps an implementation lock poison error without exposing internal values.
fn lock_error<T>(_error: PoisonError<T>) -> RepositoryError {
    RepositoryError::Unavailable
}

#[cfg(test)]
mod tests {
    use super::{AnalysisRepository, InMemoryAnalysisRepository, RepositoryError};
    use pipa_core::{
        BinlogAnalysisStatus, BinlogChange, BinlogOperation, BinlogSummary, BinlogTableConfidence,
        BinlogTransaction, BinlogTransactionFilter, BinlogTransactionStatus,
        BinlogTransactionTable,
    };
    use uuid::Uuid;

    /// Creates a summary suitable for repository-only tests.
    fn summary(analysis_id: Uuid) -> BinlogSummary {
        BinlogSummary {
            analysis_id,
            files: Vec::new(),
            status: BinlogAnalysisStatus::Complete,
            started_at: "2026-01-01T00:00:00Z".into(),
            ended_at: Some("2026-01-01T00:00:01Z".into()),
            first_event_at: None,
            last_event_at: None,
            transaction_count: 2,
            event_count: 4,
            row_change_count: 2,
            tables: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    /// Creates one minimal transaction with an exact row-event table attribution.
    fn transaction(
        analysis_id: Uuid,
        sequence: u64,
        database: &str,
        table: &str,
        operation: BinlogOperation,
    ) -> BinlogTransaction {
        BinlogTransaction {
            id: format!("{analysis_id}:{sequence}"),
            sequence,
            timestamp: "2026-01-01T00:00:00Z".into(),
            gtid: None,
            xid: None,
            server_id: 1,
            file_name: "mysql-bin.000001".into(),
            start_position: sequence * 10,
            end_position: sequence * 10 + 9,
            status: BinlogTransactionStatus::Committed,
            row_change_count: 1,
            tables: Vec::new(),
            changes: vec![BinlogChange {
                database: database.into(),
                table: table.into(),
                operation,
                row_count: 1,
                columns: Vec::new(),
                rows: Vec::new(),
                table_confidence: BinlogTableConfidence::Exact,
                sql: None,
            }],
        }
    }

    /// Verifies exact table filters run before cursor pagination.
    #[test]
    fn table_filter_and_cursor_are_stable() {
        let analysis_id = Uuid::new_v4();
        let repository = InMemoryAnalysisRepository::new();
        repository.create(summary(analysis_id)).unwrap();
        repository
            .replace(
                summary(analysis_id),
                vec![
                    transaction(analysis_id, 1, "sales", "orders", BinlogOperation::Insert),
                    transaction(
                        analysis_id,
                        2,
                        "sales",
                        "customers",
                        BinlogOperation::Update,
                    ),
                    transaction(analysis_id, 3, "sales", "orders", BinlogOperation::Delete),
                ],
            )
            .unwrap();

        let first = repository
            .list_transactions(
                analysis_id,
                BinlogTransactionFilter {
                    database: Some("sales".into()),
                    table: Some("orders".into()),
                    operation: None,
                    cursor: None,
                    limit: Some(1),
                },
            )
            .unwrap();
        assert_eq!(first.items[0].sequence, 1);
        assert_eq!(first.items[0].row_change_count, 1);
        assert_eq!(first.next_cursor.as_deref(), Some("1"));

        let second = repository
            .list_transactions(
                analysis_id,
                BinlogTransactionFilter {
                    database: Some("sales".into()),
                    table: Some("orders".into()),
                    operation: None,
                    cursor: first.next_cursor,
                    limit: Some(1),
                },
            )
            .unwrap();
        assert_eq!(second.items[0].sequence, 3);
        assert_eq!(second.next_cursor, None);
    }

    /// Verifies malformed cursors fail without returning an ambiguous first page.
    #[test]
    fn invalid_cursor_is_rejected() {
        let analysis_id = Uuid::new_v4();
        let repository = InMemoryAnalysisRepository::new();
        repository.create(summary(analysis_id)).unwrap();

        let error = repository
            .list_transactions(
                analysis_id,
                BinlogTransactionFilter {
                    cursor: Some("not-a-cursor".into()),
                    ..BinlogTransactionFilter::default()
                },
            )
            .unwrap_err();

        assert_eq!(error, RepositoryError::InvalidCursor);
    }

    /// Verifies closing is idempotent and makes retained values unreachable.
    #[test]
    fn close_is_idempotent() {
        let analysis_id = Uuid::new_v4();
        let repository = InMemoryAnalysisRepository::new();
        repository.create(summary(analysis_id)).unwrap();

        repository.close(analysis_id).unwrap();
        repository.close(analysis_id).unwrap();

        assert_eq!(
            repository.get_summary(analysis_id).unwrap_err(),
            RepositoryError::NotFound
        );
    }

    /// Verifies the complete timeline retains control-only transactions when no filter is active.
    #[test]
    fn unfiltered_page_includes_transaction_without_changes() {
        let analysis_id = Uuid::new_v4();
        let repository = InMemoryAnalysisRepository::new();
        repository.create(summary(analysis_id)).unwrap();
        let mut empty_transaction = transaction(analysis_id, 1, "", "", BinlogOperation::Insert);
        empty_transaction.changes.clear();
        empty_transaction.row_change_count = 0;
        repository
            .replace(summary(analysis_id), vec![empty_transaction])
            .unwrap();

        let page = repository
            .list_transactions(analysis_id, BinlogTransactionFilter::default())
            .unwrap();

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].sequence, 1);
    }

    /// Verifies table filtering hides unrelated rows but retains cross-table transaction context.
    #[test]
    fn filtered_page_projects_changes_and_keeps_full_table_context() {
        let analysis_id = Uuid::new_v4();
        let repository = InMemoryAnalysisRepository::new();
        repository.create(summary(analysis_id)).unwrap();
        let mut cross_table =
            transaction(analysis_id, 1, "sales", "orders", BinlogOperation::Update);
        cross_table.changes.push(BinlogChange {
            database: "sales".into(),
            table: "customers".into(),
            operation: BinlogOperation::Update,
            row_count: 3,
            columns: Vec::new(),
            rows: Vec::new(),
            table_confidence: BinlogTableConfidence::Exact,
            sql: None,
        });
        cross_table.row_change_count = 4;
        cross_table.tables = vec![
            BinlogTransactionTable {
                database: "sales".into(),
                table: "orders".into(),
                insert_count: 0,
                update_count: 1,
                delete_count: 0,
                ddl_count: 0,
                row_change_count: 1,
            },
            BinlogTransactionTable {
                database: "sales".into(),
                table: "customers".into(),
                insert_count: 0,
                update_count: 3,
                delete_count: 0,
                ddl_count: 0,
                row_change_count: 3,
            },
        ];
        repository
            .replace(summary(analysis_id), vec![cross_table])
            .unwrap();

        let page = repository
            .list_transactions(
                analysis_id,
                BinlogTransactionFilter {
                    database: Some("sales".into()),
                    table: Some("orders".into()),
                    operation: None,
                    cursor: None,
                    limit: Some(10),
                },
            )
            .unwrap();

        assert_eq!(page.items[0].row_change_count, 1);
        assert_eq!(page.items[0].tables.len(), 2);

        let transaction = repository
            .get_transaction(
                analysis_id,
                1,
                BinlogTransactionFilter {
                    database: Some("sales".into()),
                    table: Some("orders".into()),
                    operation: None,
                    cursor: None,
                    limit: None,
                },
            )
            .unwrap();
        assert_eq!(transaction.changes.len(), 1);
        assert_eq!(transaction.changes[0].table, "orders");
    }
}
