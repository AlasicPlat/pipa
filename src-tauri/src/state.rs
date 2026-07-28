use crate::bootstrap::{try_path_exists, BootstrapStore};
use crate::mcp::{
    initial_mcp_settings, shared_connection_scope, McpDeps, McpQueue, McpServerHandle,
    SharedMcpConnectionScope, SharedMcpServer,
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use pipa_binlog::InMemoryAnalysisRepository;
use pipa_core::{AppError, AppErrorCode};
use pipa_mysql::MySqlAdapter;
use pipa_redis::RedisAdapter;
use pipa_store::LocalStore;
use std::{collections::HashMap, fmt, path::Path, sync::Arc};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const LOCAL_DATABASE_KEY_LENGTH: usize = 32;
const LOCAL_DATABASE_FILENAME: &str = "pipa-data.db";
const BOOTSTRAP_DATABASE_FILENAME: &str = "pipa-bootstrap.db";

/// Shared application dependencies managed by the Tauri runtime.
pub struct AppState {
    /// SQLCipher-encrypted local persistence, including database credentials.
    pub local_store: Arc<LocalStore>,
    /// Stateless MySQL database adapter.
    pub mysql: Arc<MySqlAdapter>,
    /// Stateless Redis connection adapter.
    pub redis: Arc<RedisAdapter>,
    /// Cancellation tokens for currently running queries.
    pub cancellations: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
    /// Ephemeral summaries and decoded transactions for open binlog analyses.
    pub binlog_analyses: Arc<InMemoryAnalysisRepository>,
    /// Cancellation tokens for currently running binlog imports.
    pub binlog_cancellations: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
    /// In-process MCP HTTP server handle.
    pub mcp_server: SharedMcpServer,
    /// MCP proposal queue and activity log.
    pub mcp_queue: McpQueue,
    /// Live MCP connection visibility and authorization boundary.
    pub mcp_connection_scope: SharedMcpConnectionScope,
}

impl AppState {
    /// Initializes application dependencies inside the supplied app-data directory.
    ///
    /// # Side effects
    /// Opens or creates the local bootstrap and SQLCipher database without accessing the
    /// operating-system keyring or inspecting legacy `pipa.db` files.
    pub fn initialize(app_data_dir: &Path) -> Result<Self, AppError> {
        let local_store = initialize_local_storage(app_data_dir, |key| {
            getrandom::fill(key).map_err(|error| {
                startup_storage_error(
                    "Could not generate local storage encryption key",
                    "read operating-system randomness",
                    error,
                )
            })
        })?;
        let mcp_settings = initial_mcp_settings(&local_store);
        let mcp_connection_scope = shared_connection_scope(&mcp_settings);

        Ok(Self {
            local_store: Arc::new(local_store),
            mysql: Arc::new(MySqlAdapter::new()),
            redis: Arc::new(RedisAdapter::new()),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
            binlog_analyses: Arc::new(InMemoryAnalysisRepository::new()),
            binlog_cancellations: Arc::new(Mutex::new(HashMap::new())),
            mcp_server: Arc::new(Mutex::new(McpServerHandle::from_settings(mcp_settings))),
            mcp_queue: McpQueue::new(),
            mcp_connection_scope,
        })
    }

    /// Clones dependencies needed by the MCP HTTP tool surface.
    pub fn mcp_deps(&self) -> McpDeps {
        McpDeps {
            local_store: self.local_store.clone(),
            mysql: self.mysql.clone(),
            queue: self.mcp_queue.clone(),
            connection_scope: self.mcp_connection_scope.clone(),
            binlog_analyses: self.binlog_analyses.clone(),
            binlog_cancellations: self.binlog_cancellations.clone(),
        }
    }
}

/// Opens local storage from a complete bootstrap or creates a new independent data store.
fn initialize_local_storage(
    app_data_dir: &Path,
    fill_random: impl FnOnce(&mut [u8]) -> Result<(), AppError>,
) -> Result<LocalStore, AppError> {
    prepare_app_data_directory(app_data_dir)?;
    let bootstrap_path = app_data_dir.join(BOOTSTRAP_DATABASE_FILENAME);
    let main_database_path = app_data_dir.join(LOCAL_DATABASE_FILENAME);

    let root_key = if try_path_exists(&bootstrap_path, "probe bootstrap during startup")? {
        BootstrapStore::open(&bootstrap_path)?.load()?.root_key
    } else {
        let mut root_key = Zeroizing::new(vec![0_u8; LOCAL_DATABASE_KEY_LENGTH]);
        fill_random(&mut root_key)?;
        let bootstrap = BootstrapStore::create(&bootstrap_path, &root_key)?;
        let stored_root_key = bootstrap.load()?.root_key;
        drop(bootstrap);
        stored_root_key
    };

    open_main_store(&main_database_path, &root_key)
}

/// Opens the SQLCipher main database with a validated, base64-encoded root key.
fn open_main_store(path: &Path, root_key: &[u8]) -> Result<LocalStore, AppError> {
    if root_key.len() != LOCAL_DATABASE_KEY_LENGTH {
        return Err(AppError {
            code: AppErrorCode::Storage,
            message: "Local storage encryption key is invalid".into(),
            technical_details: Some("root key did not contain exactly 32 bytes".into()),
            retryable: false,
        });
    }
    let encoded_key = Zeroizing::new(STANDARD_NO_PAD.encode(root_key));
    LocalStore::open(path, &encoded_key)
}

/// Creates and restricts the app-data directory to the current Unix user where supported.
fn prepare_app_data_directory(path: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(path).map_err(|error| {
        startup_storage_error(
            "Could not prepare local storage directory",
            "create app-data directory",
            error,
        )
    })?;
    #[cfg(unix)]
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|error| {
        startup_storage_error(
            "Could not secure local storage directory",
            "set app-data directory permissions",
            error,
        )
    })?;
    Ok(())
}

/// Builds a stable startup storage error without including secret inputs.
fn startup_storage_error(
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
    use super::{initialize_local_storage, BOOTSTRAP_DATABASE_FILENAME, LOCAL_DATABASE_FILENAME};
    use crate::bootstrap::BootstrapStore;
    use pipa_core::{AppErrorCode, ConnectionProfile, Engine, Environment, TlsMode};
    use secrecy::{ExposeSecret, SecretString};
    use std::cell::Cell;
    use uuid::Uuid;

    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};

    /// Creates a representative connection used to prove the new encrypted store is usable.
    fn mysql_profile() -> ConnectionProfile {
        ConnectionProfile {
            id: Uuid::new_v4(),
            name: "New Local MySQL".into(),
            engine: Engine::MySql,
            environment: Environment::Development,
            host: "127.0.0.1".into(),
            port: 3306,
            username: "developer".into(),
            database: Some("pipa".into()),
            tls_mode: TlsMode::Preferred,
        }
    }

    /// Verifies a new installation generates a stable 32-byte key and reuses it without RNG.
    #[test]
    fn new_installation_bootstrap_key_is_stable() {
        let directory = tempfile::tempdir().unwrap();
        let first = initialize_local_storage(directory.path(), |key| {
            key.fill(0xA5);
            Ok(())
        })
        .unwrap();
        drop(first);

        let bootstrap_path = directory.path().join(BOOTSTRAP_DATABASE_FILENAME);
        let bootstrap_state = BootstrapStore::open(&bootstrap_path)
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(bootstrap_state.root_key.as_slice(), &[0xA5; 32]);

        initialize_local_storage(directory.path(), |_| {
            panic!("an existing bootstrap key must be reused")
        })
        .unwrap();

        #[cfg(unix)]
        {
            assert_eq!(
                std::fs::metadata(directory.path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(bootstrap_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    /// Verifies a failed bootstrap existence probe aborts before random generation or file writes.
    #[cfg(unix)]
    #[test]
    fn bootstrap_probe_error_fails_closed_without_generating_key() {
        let directory = tempfile::tempdir().unwrap();
        let bootstrap_path = directory.path().join(BOOTSTRAP_DATABASE_FILENAME);
        symlink(&bootstrap_path, &bootstrap_path).unwrap();
        let generated = Cell::new(false);

        let error = initialize_local_storage(directory.path(), |_| {
            generated.set(true);
            Ok(())
        })
        .unwrap_err();

        assert!(matches!(error.code, AppErrorCode::Storage));
        assert_eq!(error.message, "Could not inspect local storage path");
        assert!(!generated.get());
        assert!(!directory
            .path()
            .join(LOCAL_DATABASE_FILENAME)
            .try_exists()
            .unwrap());
    }

    /// Verifies arbitrary legacy files remain untouched while the new database is created.
    #[test]
    fn legacy_database_files_are_ignored_and_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let legacy_files = [
            ("pipa.db", b"legacy-main".as_slice()),
            ("pipa.db-wal", b"legacy-wal".as_slice()),
            ("pipa.db-shm", b"legacy-shm".as_slice()),
        ];
        for (name, bytes) in legacy_files {
            std::fs::write(directory.path().join(name), bytes).unwrap();
        }

        let store = initialize_local_storage(directory.path(), |key| {
            key.fill(0x3C);
            Ok(())
        })
        .unwrap();
        let profile = mysql_profile();
        store
            .save_connection_with_credential(&profile, &SecretString::from("new-database-password"))
            .unwrap();

        assert_eq!(
            store
                .get_connection_credential(profile.id)
                .unwrap()
                .expose_secret(),
            "new-database-password"
        );
        assert!(directory
            .path()
            .join(LOCAL_DATABASE_FILENAME)
            .try_exists()
            .unwrap());
        for (name, bytes) in legacy_files {
            assert_eq!(std::fs::read(directory.path().join(name)).unwrap(), bytes);
        }
    }
}
