//! Encrypted local persistence and operating-system credential storage.

#![warn(missing_docs)]

mod connection_repository;
mod secret_store;
mod workspace_repository;

use pipa_core::{AppError, AppErrorCode};
use rusqlite::Connection;
use std::{
    fmt,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

#[cfg(test)]
pub use secret_store::MemorySecretStore;
pub use secret_store::{KeyringSecretStore, SecretStore};
pub use workspace_repository::{QueryHistoryEntry, WorkspaceTab};

/// Encrypted SQLite storage for non-secret local application data.
pub struct LocalStore {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl LocalStore {
    /// Opens an encrypted database, verifies its key, and applies local schema migrations.
    pub fn open(path: impl AsRef<Path>, encryption_key: &str) -> Result<Self, AppError> {
        let path = path.as_ref().to_path_buf();
        let connection = Connection::open(&path).map_err(|error| {
            storage_error("Could not open local storage", "open database", error)
        })?;
        connection
            .pragma_update(None, "key", encryption_key)
            .and_then(|_| {
                connection.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
            })
            .and_then(|_| connection.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(())))
            .and_then(|_| {
                connection.execute_batch(
                    "CREATE TABLE IF NOT EXISTS connections (
                       id TEXT PRIMARY KEY,
                       engine TEXT NOT NULL,
                       name TEXT NOT NULL,
                       environment TEXT NOT NULL,
                       host TEXT NOT NULL,
                       port INTEGER NOT NULL,
                       username TEXT NOT NULL,
                       database_name TEXT,
                       tls_mode TEXT NOT NULL,
                       updated_at TEXT NOT NULL
                     );
                     CREATE TABLE IF NOT EXISTS workspace_tabs (
                       id TEXT PRIMARY KEY,
                       connection_id TEXT NOT NULL,
                       title TEXT NOT NULL,
                       sql_text TEXT NOT NULL,
                       position INTEGER NOT NULL
                     );
                     CREATE TABLE IF NOT EXISTS query_history (
                       id TEXT PRIMARY KEY,
                       connection_id TEXT NOT NULL,
                       sql_text TEXT NOT NULL,
                       executed_at TEXT NOT NULL
                     );",
                )
            })
            .map_err(|error| {
                storage_error(
                    "Could not open local storage",
                    "initialize encrypted database",
                    error,
                )
            })?;

        Ok(Self {
            path,
            connection: Mutex::new(connection),
        })
    }

    /// Returns the on-disk database path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Locks the database connection for one repository operation.
    fn connection(&self) -> Result<MutexGuard<'_, Connection>, AppError> {
        self.connection.lock().map_err(|_| AppError {
            code: AppErrorCode::Storage,
            message: "Could not access local storage".into(),
            technical_details: Some("database connection lock was poisoned".into()),
            retryable: false,
        })
    }
}

impl fmt::Debug for LocalStore {
    /// Formats only the non-secret database path.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalStore")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

/// Converts an implementation error into a stable storage error without secret inputs.
fn storage_error(
    message: &'static str,
    operation: &'static str,
    source: impl fmt::Display,
) -> AppError {
    AppError {
        code: AppErrorCode::Storage,
        message: message.into(),
        technical_details: Some(format!("{operation}: {source}")),
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::{LocalStore, MemorySecretStore, QueryHistoryEntry, SecretStore, WorkspaceTab};
    use chrono::{Duration, TimeZone, Utc};
    use pipa_core::{ConnectionProfile, Engine, Environment, TlsMode};
    use secrecy::{ExposeSecret, SecretString};
    use tempfile::TempDir;
    use uuid::Uuid;

    /// Creates a representative non-secret MySQL connection profile.
    fn mysql_profile() -> ConnectionProfile {
        ConnectionProfile {
            id: Uuid::new_v4(),
            name: "Local MySQL".into(),
            engine: Engine::MySql,
            environment: Environment::Development,
            host: "127.0.0.1".into(),
            port: 3306,
            username: "developer".into(),
            database: Some("pipa".into()),
            tls_mode: TlsMode::Preferred,
        }
    }

    /// Opens an encrypted store whose temporary directory remains alive for the test.
    fn test_store(encryption_key: &str) -> (TempDir, LocalStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalStore::open(directory.path().join("pipa.db"), encryption_key).unwrap();
        (directory, store)
    }

    /// Verifies profiles round-trip without introducing a password into SQLite.
    #[test]
    fn connection_round_trip_excludes_password() {
        let (_directory, store) = test_store("correct horse battery staple");
        let profile = mysql_profile();

        store.save_connection(&profile).unwrap();

        assert_eq!(
            serde_json::to_value(store.list_connections().unwrap()).unwrap(),
            serde_json::to_value([profile]).unwrap()
        );
        let bytes = std::fs::read(store.path()).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("database-password"));
    }

    /// Verifies saving an existing profile identifier replaces its non-secret fields.
    #[test]
    fn saving_connection_upserts_existing_profile() {
        let (_directory, store) = test_store("upsert-key");
        let mut profile = mysql_profile();
        store.save_connection(&profile).unwrap();
        profile.name = "Renamed MySQL".into();
        profile.host = "db.internal".into();

        store.save_connection(&profile).unwrap();

        assert_eq!(
            serde_json::to_value(store.list_connections().unwrap()).unwrap(),
            serde_json::to_value([profile]).unwrap()
        );
    }

    /// Verifies a database encrypted with one key rejects another without exposing either key.
    #[test]
    fn wrong_encryption_key_cannot_open_database() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pipa.db");
        LocalStore::open(&path, "first-key").unwrap();

        let error = LocalStore::open(&path, "wrong-key").unwrap_err();

        assert_eq!(error.message, "Could not open local storage");
        assert!(!format!("{error:?}").contains("first-key"));
        assert!(!format!("{error:?}").contains("wrong-key"));
    }

    /// Verifies workspace rows load by position and a save replaces prior rows.
    #[test]
    fn workspace_round_trip_is_ordered_and_replaces_existing_tabs() {
        let (_directory, store) = test_store("workspace-key");
        let connection_id = Uuid::new_v4();
        let first = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id,
            title: "First".into(),
            sql_text: "SELECT 1".into(),
            position: 1,
        };
        let second = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id,
            title: "Second".into(),
            sql_text: "SELECT 2".into(),
            position: 2,
        };

        store
            .save_workspace(&[second.clone(), first.clone()])
            .unwrap();
        assert_eq!(store.load_workspace().unwrap(), vec![first, second]);

        let replacement = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id,
            title: "Replacement".into(),
            sql_text: "SELECT 3".into(),
            position: 0,
        };
        store
            .save_workspace(std::slice::from_ref(&replacement))
            .unwrap();
        assert_eq!(store.load_workspace().unwrap(), vec![replacement]);
    }

    /// Verifies a failed replacement rolls back the deletion of existing tabs.
    #[test]
    fn workspace_replacement_is_transactional() {
        let (_directory, store) = test_store("transaction-key");
        let existing = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            title: "Existing".into(),
            sql_text: "SELECT 1".into(),
            position: 0,
        };
        store
            .save_workspace(std::slice::from_ref(&existing))
            .unwrap();
        let duplicate = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            title: "Duplicate".into(),
            sql_text: "SELECT 2".into(),
            position: 0,
        };

        assert!(store
            .save_workspace(&[duplicate.clone(), duplicate])
            .is_err());
        assert_eq!(store.load_workspace().unwrap(), vec![existing]);
    }

    /// Verifies history is newest-first, honors limit clamping, and retains 1,000 rows.
    #[test]
    fn query_history_is_bounded_and_newest_first() {
        let (_directory, store) = test_store("history-key");
        let connection_id = Uuid::new_v4();
        let start = Utc.with_ymd_and_hms(2026, 7, 12, 0, 0, 0).unwrap();

        for offset in 0..=1_000 {
            store
                .record_query_history(&QueryHistoryEntry {
                    id: Uuid::new_v4(),
                    connection_id,
                    sql_text: format!("SELECT {offset}"),
                    executed_at: start + Duration::seconds(offset),
                })
                .unwrap();
        }

        let history = store.list_query_history(2_000).unwrap();
        assert_eq!(history.len(), 1_000);
        assert_eq!(history.first().unwrap().sql_text, "SELECT 1000");
        assert_eq!(history.last().unwrap().sql_text, "SELECT 1");
        assert_eq!(store.list_query_history(0).unwrap().len(), 1);
        assert_eq!(store.list_query_history(2).unwrap().len(), 2);
    }

    /// Verifies the test secret store supports isolated set, get, and delete operations.
    #[test]
    fn memory_secret_store_round_trip_and_delete() {
        let store = MemorySecretStore::default();
        let connection_id = Uuid::new_v4();
        let password = SecretString::from("database-password");

        store.set(connection_id, &password).unwrap();
        assert_eq!(
            store.get(connection_id).unwrap().expose_secret(),
            "database-password"
        );
        store.delete(connection_id).unwrap();
        assert!(store.get(connection_id).is_err());
    }
}
