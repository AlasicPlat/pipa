//! SQLCipher-encrypted local persistence for application data and database credentials.

#![warn(missing_docs)]

mod connection_repository;
mod settings_repository;
mod sql_library_repository;
mod workspace_repository;

use pipa_core::{AppError, AppErrorCode};
use rusqlite::Connection;
use std::{
    fmt,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

pub use settings_repository::McpSettings;
pub use sql_library_repository::{CommonSql, SqlFolder, SqlLibrary};
pub use workspace_repository::{QueryHistoryEntry, WorkspaceTab};

/// Encrypted SQLite storage for local application data and database credentials.
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
            .and_then(|_| connection.pragma_update(None, "foreign_keys", "ON"))
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
                     CREATE TABLE IF NOT EXISTS connection_credentials (
                       connection_id TEXT PRIMARY KEY,
                       password TEXT NOT NULL,
                       FOREIGN KEY(connection_id) REFERENCES connections(id) ON DELETE CASCADE
                     );
                     CREATE TABLE IF NOT EXISTS workspace_tabs (
                       id TEXT PRIMARY KEY,
                       connection_id TEXT NOT NULL,
                       title TEXT NOT NULL,
                       sql_text TEXT NOT NULL,
                       position INTEGER NOT NULL,
                       window_label TEXT NOT NULL DEFAULT 'main'
                     );
                     CREATE TABLE IF NOT EXISTS query_history (
                       id TEXT PRIMARY KEY,
                       connection_id TEXT NOT NULL,
                       sql_text TEXT NOT NULL,
                       executed_at TEXT NOT NULL
                     );
                     CREATE TABLE IF NOT EXISTS app_settings (
                       key TEXT PRIMARY KEY,
                       value TEXT NOT NULL
                     );
                     CREATE TABLE IF NOT EXISTS sql_folders (
                       id TEXT PRIMARY KEY,
                       engine TEXT NOT NULL,
                       name TEXT NOT NULL,
                       updated_at TEXT NOT NULL,
                       UNIQUE(engine, name COLLATE NOCASE)
                     );
                     CREATE TABLE IF NOT EXISTS common_sql (
                       id TEXT PRIMARY KEY,
                       engine TEXT NOT NULL,
                       folder_id TEXT,
                       name TEXT NOT NULL,
                       sql_text TEXT NOT NULL,
                       updated_at TEXT NOT NULL,
                       FOREIGN KEY(folder_id) REFERENCES sql_folders(id) ON DELETE SET NULL
                     );
                     CREATE INDEX IF NOT EXISTS common_sql_engine_index
                       ON common_sql(engine, updated_at DESC);
                     CREATE INDEX IF NOT EXISTS common_sql_folder_index
                       ON common_sql(folder_id);",
                )
            })
            .and_then(|_| ensure_workspace_window_scope(&connection))
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

/** Adds per-window workspace ownership to databases created before detached windows existed. */
fn ensure_workspace_window_scope(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(workspace_tabs)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    if !columns.iter().any(|column| column == "window_label") {
        connection.execute(
            "ALTER TABLE workspace_tabs
             ADD COLUMN window_label TEXT NOT NULL DEFAULT 'main'",
            [],
        )?;
    }
    connection.execute(
        "CREATE INDEX IF NOT EXISTS workspace_tabs_window_index
         ON workspace_tabs(window_label, position)",
        [],
    )?;
    Ok(())
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
pub(crate) fn storage_error(
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
    use super::{LocalStore, QueryHistoryEntry, WorkspaceTab};
    use chrono::{Duration, TimeZone, Utc};
    use pipa_core::{ConnectionProfile, Engine, Environment, TlsMode};
    use rusqlite::params;
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

    /// Verifies profiles round-trip without adding secret fields to their public shape.
    #[test]
    fn connection_round_trip_excludes_password() {
        let (_directory, store) = test_store("correct horse battery staple");
        let profile = mysql_profile();
        let password = SecretString::from("profile-roundtrip-test-password");

        store
            .save_connection_with_credential(&profile, &password)
            .unwrap();

        assert_eq!(
            serde_json::to_value(store.list_connections().unwrap()).unwrap(),
            serde_json::to_value([&profile]).unwrap()
        );
        let profile_json = serde_json::to_string(&profile).unwrap();
        assert!(!profile_json.contains("password"));
        assert!(!profile_json.contains("profile-roundtrip-test-password"));
    }

    /// Verifies a connection credential round-trips while SQLCipher hides it on disk.
    #[test]
    fn credential_round_trip_is_encrypted_at_rest() {
        let (_directory, store) = test_store("credential-key");
        let profile = mysql_profile();
        let password = SecretString::from("encrypted-database-password");

        store
            .save_connection_with_credential(&profile, &password)
            .unwrap();

        assert_eq!(
            store
                .get_connection_credential(profile.id)
                .unwrap()
                .expose_secret(),
            "encrypted-database-password"
        );
        let database_path = store.path().to_path_buf();
        drop(store);
        let bytes = std::fs::read(database_path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("encrypted-database-password"));
    }

    /// Verifies a credential-write failure rolls back its new connection profile atomically.
    #[test]
    fn credential_failure_leaves_no_connection_or_credential() {
        let (_directory, store) = test_store("atomic-key");
        let profile = mysql_profile();
        let password = SecretString::from("rollback-database-password");
        store
            .connection()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_connection_credential
                 BEFORE INSERT ON connection_credentials
                 BEGIN
                   SELECT RAISE(ABORT, 'injected credential failure');
                 END;",
            )
            .unwrap();

        let error = store
            .save_connection_with_credential(&profile, &password)
            .unwrap_err();

        assert!(store.list_connections().unwrap().is_empty());
        assert!(store.get_connection_credential(profile.id).is_err());
        assert!(!format!("{error:?}").contains("rollback-database-password"));
    }

    /// Verifies saving an existing profile identifier replaces its non-secret fields.
    #[test]
    fn saving_connection_upserts_existing_profile() {
        let (_directory, store) = test_store("upsert-key");
        let mut profile = mysql_profile();
        store
            .save_connection_with_credential(&profile, &SecretString::from("initial-test-password"))
            .unwrap();
        profile.name = "Renamed MySQL".into();
        profile.host = "db.internal".into();

        store
            .save_connection_with_credential(&profile, &SecretString::from("updated-test-password"))
            .unwrap();

        assert_eq!(
            serde_json::to_value(store.list_connections().unwrap()).unwrap(),
            serde_json::to_value([&profile]).unwrap()
        );
        assert_eq!(
            store
                .get_connection_credential(profile.id)
                .unwrap()
                .expose_secret(),
            "updated-test-password"
        );
    }

    /// Verifies renaming changes only the profile name and remains safe to retry.
    #[test]
    fn renaming_connection_preserves_credential_and_is_idempotent() {
        let (_directory, store) = test_store("rename-key");
        let mut profile = mysql_profile();
        store
            .save_connection_with_credential(&profile, &SecretString::from("rename-password"))
            .unwrap();

        let renamed = store
            .rename_connection(profile.id, "Renamed MySQL")
            .unwrap();
        let retried = store
            .rename_connection(profile.id, "Renamed MySQL")
            .unwrap();

        profile.name = "Renamed MySQL".into();
        assert_eq!(
            serde_json::to_value([renamed, retried]).unwrap(),
            serde_json::to_value([&profile, &profile]).unwrap()
        );
        assert_eq!(store.get_connection(profile.id).unwrap().name, profile.name);
        assert_eq!(
            store
                .get_connection_credential(profile.id)
                .unwrap()
                .expose_secret(),
            "rename-password"
        );
    }

    /// Verifies reading or renaming an unknown connection returns the stable not-found category.
    #[test]
    fn unknown_connection_profile_returns_not_found() {
        let (_directory, store) = test_store("not-found-key");
        let connection_id = Uuid::new_v4();

        let read_error = store.get_connection(connection_id).unwrap_err();
        let rename_error = store
            .rename_connection(connection_id, "Missing")
            .unwrap_err();

        assert!(matches!(read_error.code, pipa_core::AppErrorCode::NotFound));
        assert!(matches!(
            rename_error.code,
            pipa_core::AppErrorCode::NotFound
        ));
        assert_eq!(read_error.message, "Database connection was not found");
        assert_eq!(rename_error.message, "Database connection was not found");
    }

    /// Verifies deletion is atomic, removes related local data, and is safe to retry.
    #[test]
    fn deleting_connection_removes_related_local_data_idempotently() {
        let (_directory, store) = test_store("delete-key");
        let deleted_profile = mysql_profile();
        let retained_profile = mysql_profile();
        store
            .save_connection_with_credential(
                &deleted_profile,
                &SecretString::from("deleted-password"),
            )
            .unwrap();
        store
            .save_connection_with_credential(
                &retained_profile,
                &SecretString::from("retained-password"),
            )
            .unwrap();
        let deleted_tab = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id: deleted_profile.id,
            title: "Deleted connection tab".into(),
            sql_text: "SELECT deleted".into(),
            position: 0,
        };
        let retained_tab = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id: retained_profile.id,
            title: "Retained connection tab".into(),
            sql_text: "SELECT retained".into(),
            position: 1,
        };
        store
            .save_workspace("main", &[deleted_tab, retained_tab.clone()])
            .unwrap();
        store
            .record_query_history(&QueryHistoryEntry {
                id: Uuid::new_v4(),
                connection_id: deleted_profile.id,
                sql_text: "SELECT deleted history".into(),
                executed_at: Utc::now(),
            })
            .unwrap();
        store
            .record_query_history(&QueryHistoryEntry {
                id: Uuid::new_v4(),
                connection_id: retained_profile.id,
                sql_text: "SELECT retained history".into(),
                executed_at: Utc::now(),
            })
            .unwrap();

        store.delete_connection(deleted_profile.id).unwrap();
        store.delete_connection(deleted_profile.id).unwrap();

        assert_eq!(
            serde_json::to_value(store.list_connections().unwrap()).unwrap(),
            serde_json::to_value([&retained_profile]).unwrap()
        );
        assert!(store.get_connection_credential(deleted_profile.id).is_err());
        assert_eq!(
            store
                .get_connection_credential(retained_profile.id)
                .unwrap()
                .expose_secret(),
            "retained-password"
        );
        assert_eq!(store.load_workspace("main").unwrap(), vec![retained_tab]);
        let history = store.list_query_history(10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].connection_id, retained_profile.id);
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
            .save_workspace("main", &[second.clone(), first.clone()])
            .unwrap();
        assert_eq!(store.load_workspace("main").unwrap(), vec![first, second]);

        let replacement = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id,
            title: "Replacement".into(),
            sql_text: "SELECT 3".into(),
            position: 0,
        };
        store
            .save_workspace("main", std::slice::from_ref(&replacement))
            .unwrap();
        assert_eq!(store.load_workspace("main").unwrap(), vec![replacement]);
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
            .save_workspace("main", std::slice::from_ref(&existing))
            .unwrap();
        let duplicate = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            title: "Duplicate".into(),
            sql_text: "SELECT 2".into(),
            position: 0,
        };

        assert!(store
            .save_workspace("main", &[duplicate.clone(), duplicate])
            .is_err());
        assert_eq!(store.load_workspace("main").unwrap(), vec![existing]);
    }

    /// Verifies window-scoped replacement and atomic transfer never overwrite another window.
    #[test]
    fn workspace_tabs_are_isolated_and_transfer_between_windows() {
        let (_directory, store) = test_store("workspace-window-key");
        let main_tab = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            title: "Main query".into(),
            sql_text: "SELECT 'main'".into(),
            position: 0,
        };
        let detached_tab = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            title: "Detached query".into(),
            sql_text: "SELECT 'detached'".into(),
            position: 0,
        };

        store
            .save_workspace("main", &[main_tab.clone(), detached_tab.clone()])
            .unwrap();
        store
            .transfer_workspace_tab(&detached_tab, "main", "workspace-detached")
            .unwrap();
        store
            .save_workspace("main", std::slice::from_ref(&main_tab))
            .unwrap();

        assert_eq!(store.load_workspace("main").unwrap(), vec![main_tab]);
        assert_eq!(
            store.load_workspace("workspace-detached").unwrap(),
            vec![WorkspaceTab {
                position: 0,
                ..detached_tab
            }]
        );
        assert_eq!(
            store.list_workspace_window_labels().unwrap(),
            vec!["workspace-detached"]
        );
    }

    /// Verifies legacy workspace rows are retained and assigned to the main desktop window.
    #[test]
    fn legacy_workspace_schema_migrates_to_main_window() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("legacy-workspace.db");
        let tab = WorkspaceTab {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            title: "Legacy query".into(),
            sql_text: "SELECT 'legacy'".into(),
            position: 0,
        };
        let connection = rusqlite::Connection::open(&database_path).unwrap();
        connection.pragma_update(None, "key", "legacy-key").unwrap();
        connection
            .execute_batch(
                "CREATE TABLE workspace_tabs (
                   id TEXT PRIMARY KEY,
                   connection_id TEXT NOT NULL,
                   title TEXT NOT NULL,
                   sql_text TEXT NOT NULL,
                   position INTEGER NOT NULL
                 );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workspace_tabs (id, connection_id, title, sql_text, position)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    tab.id,
                    tab.connection_id,
                    tab.title,
                    tab.sql_text,
                    tab.position,
                ],
            )
            .unwrap();
        drop(connection);

        let store = LocalStore::open(database_path, "legacy-key").unwrap();

        assert_eq!(store.load_workspace("main").unwrap(), vec![tab]);
        assert!(store
            .load_workspace("workspace-detached")
            .unwrap()
            .is_empty());
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

    /// Verifies replaying the same started query identifier cannot duplicate history.
    #[test]
    fn query_history_is_idempotent_by_query_id() {
        let (_directory, store) = test_store("idempotent-history-key");
        let query_id = Uuid::new_v4();
        let first = QueryHistoryEntry {
            id: query_id,
            connection_id: Uuid::new_v4(),
            sql_text: "SELECT first".into(),
            executed_at: Utc.with_ymd_and_hms(2026, 7, 12, 1, 0, 0).unwrap(),
        };
        let duplicate = QueryHistoryEntry {
            id: query_id,
            connection_id: Uuid::new_v4(),
            sql_text: "SELECT duplicate".into(),
            executed_at: Utc.with_ymd_and_hms(2026, 7, 12, 2, 0, 0).unwrap(),
        };

        store.record_query_history(&first).unwrap();
        store.record_query_history(&duplicate).unwrap();

        assert_eq!(store.list_query_history(10).unwrap(), vec![first]);
    }
}
