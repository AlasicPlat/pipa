use crate::{
    bootstrap::BootstrapStore,
    legacy_keyring::{KeyringLegacyMigration, LegacySecretMigration},
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use pipa_core::{AppError, AppErrorCode};
use pipa_mysql::MySqlAdapter;
use pipa_store::LocalStore;
use std::{collections::HashMap, fmt, path::Path, sync::Arc};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const LOCAL_DATABASE_KEY_LENGTH: usize = 32;
const LOCAL_DATABASE_FILENAME: &str = "pipa.db";
const BOOTSTRAP_DATABASE_FILENAME: &str = "pipa-bootstrap.db";

/// Shared application dependencies managed by the Tauri runtime.
pub struct AppState {
    /// SQLCipher-encrypted local persistence, including database credentials.
    pub local_store: Arc<LocalStore>,
    /// Stateless MySQL database adapter.
    pub mysql: Arc<MySqlAdapter>,
    /// Cancellation tokens for currently running queries.
    pub cancellations: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
}

impl AppState {
    /// Initializes application dependencies inside the supplied app-data directory.
    ///
    /// # Side effects
    /// Opens local SQLite files and accesses the operating-system keyring only when a legacy main
    /// database still needs its one-time migration.
    pub fn initialize(app_data_dir: &Path) -> Result<Self, AppError> {
        let legacy = KeyringLegacyMigration;
        let local_store = initialize_local_storage(app_data_dir, &legacy, |key| {
            getrandom::fill(key).map_err(|error| {
                startup_storage_error(
                    "Could not generate local storage encryption key",
                    "read operating-system randomness",
                    error,
                )
            })
        })?;

        Ok(Self {
            local_store: Arc::new(local_store),
            mysql: Arc::new(MySqlAdapter::new()),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}

/// Opens local storage from the bootstrap or performs the one-time legacy keyring migration.
fn initialize_local_storage(
    app_data_dir: &Path,
    legacy: &impl LegacySecretMigration,
    fill_random: impl FnOnce(&mut [u8]) -> Result<(), AppError>,
) -> Result<LocalStore, AppError> {
    prepare_app_data_directory(app_data_dir)?;
    let bootstrap_path = app_data_dir.join(BOOTSTRAP_DATABASE_FILENAME);
    let main_database_path = app_data_dir.join(LOCAL_DATABASE_FILENAME);

    if bootstrap_path.exists() {
        let bootstrap = BootstrapStore::open(&bootstrap_path)?;
        let bootstrap_state = bootstrap.load()?;
        let local_store = open_main_store(&main_database_path, &bootstrap_state.root_key)?;
        if !bootstrap_state.legacy_migration_complete {
            migrate_legacy_credentials(&local_store, legacy)?;
            bootstrap.mark_legacy_migration_complete()?;
        }
        return Ok(local_store);
    }

    if main_database_path.exists() {
        let root_key = legacy.load_root_key()?;
        validate_root_key(&root_key)?;
        let bootstrap = BootstrapStore::create(&bootstrap_path, &root_key, false)?;
        let local_store = open_main_store(&main_database_path, &root_key)?;
        migrate_legacy_credentials(&local_store, legacy)?;
        bootstrap.mark_legacy_migration_complete()?;
        return Ok(local_store);
    }

    let mut root_key = Zeroizing::new(vec![0_u8; LOCAL_DATABASE_KEY_LENGTH]);
    fill_random(&mut root_key)?;
    let _bootstrap = BootstrapStore::create(&bootstrap_path, &root_key, true)?;
    open_main_store(&main_database_path, &root_key)
}

/// Imports every legacy connection password in one encrypted-main-database transaction.
fn migrate_legacy_credentials(
    local_store: &LocalStore,
    legacy: &impl LegacySecretMigration,
) -> Result<(), AppError> {
    let profiles = local_store.list_connections()?;
    let mut credentials = Vec::with_capacity(profiles.len());
    for profile in profiles {
        credentials.push((profile.id, legacy.load_connection_credential(profile.id)?));
    }
    local_store.import_connection_credentials(&credentials)
}

/// Opens the SQLCipher main database with a validated, base64-encoded root key.
fn open_main_store(path: &Path, root_key: &[u8]) -> Result<LocalStore, AppError> {
    validate_root_key(root_key)?;
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

/// Rejects malformed root-key material without logging or formatting its contents.
fn validate_root_key(root_key: &[u8]) -> Result<(), AppError> {
    if root_key.len() == LOCAL_DATABASE_KEY_LENGTH {
        Ok(())
    } else {
        Err(AppError {
            code: AppErrorCode::Storage,
            message: "Local storage encryption key is invalid".into(),
            technical_details: Some("root key did not contain exactly 32 bytes".into()),
            retryable: false,
        })
    }
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
    use crate::{bootstrap::BootstrapStore, legacy_keyring::LegacySecretMigration};
    use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
    use pipa_core::{AppError, AppErrorCode, ConnectionProfile, Engine, Environment, TlsMode};
    use pipa_store::LocalStore;
    use secrecy::{ExposeSecret, SecretString};
    use std::{
        cell::{Cell, RefCell},
        collections::HashMap,
    };
    use uuid::Uuid;
    use zeroize::Zeroizing;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    /// Deterministic read-only legacy boundary used without a real operating-system keyring.
    struct FakeLegacyMigration {
        root_key: Vec<u8>,
        credentials: RefCell<HashMap<Uuid, SecretString>>,
        root_key_reads: Cell<usize>,
        credential_reads: Cell<usize>,
    }

    impl FakeLegacyMigration {
        /// Creates a fake boundary with one root key and no connection credentials.
        fn new(root_key: Vec<u8>) -> Self {
            Self {
                root_key,
                credentials: RefCell::new(HashMap::new()),
                root_key_reads: Cell::new(0),
                credential_reads: Cell::new(0),
            }
        }

        /// Adds or replaces one fake legacy connection password.
        fn insert_credential(&self, connection_id: Uuid, password: &str) {
            self.credentials
                .borrow_mut()
                .insert(connection_id, SecretString::from(password));
        }
    }

    impl LegacySecretMigration for FakeLegacyMigration {
        /// Returns the configured root key and records one legacy access.
        fn load_root_key(&self) -> Result<Zeroizing<Vec<u8>>, AppError> {
            self.root_key_reads.set(self.root_key_reads.get() + 1);
            Ok(Zeroizing::new(self.root_key.clone()))
        }

        /// Returns a configured password or the stable legacy not-found error.
        fn load_connection_credential(
            &self,
            connection_id: Uuid,
        ) -> Result<SecretString, AppError> {
            self.credential_reads.set(self.credential_reads.get() + 1);
            self.credentials
                .borrow()
                .get(&connection_id)
                .cloned()
                .ok_or_else(|| AppError {
                    code: AppErrorCode::NotFound,
                    message: "Legacy database credential was not found".into(),
                    technical_details: Some("legacy credential entry is missing".into()),
                    retryable: false,
                })
        }
    }

    /// Legacy boundary that proves a completed bootstrap never reaches the keyring path.
    struct PanicLegacyMigration;

    impl LegacySecretMigration for PanicLegacyMigration {
        /// Panics because a completed bootstrap must never request the legacy root key.
        fn load_root_key(&self) -> Result<Zeroizing<Vec<u8>>, AppError> {
            panic!("completed bootstrap unexpectedly requested the legacy root key")
        }

        /// Panics because a completed bootstrap must never request legacy connection passwords.
        fn load_connection_credential(
            &self,
            _connection_id: Uuid,
        ) -> Result<SecretString, AppError> {
            panic!("completed bootstrap unexpectedly requested a legacy credential")
        }
    }

    /// Creates a representative legacy connection profile.
    fn mysql_profile(name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: Uuid::new_v4(),
            name: name.into(),
            engine: Engine::MySql,
            environment: Environment::Development,
            host: "127.0.0.1".into(),
            port: 3306,
            username: "developer".into(),
            database: Some("pipa".into()),
            tls_mode: TlsMode::Preferred,
        }
    }

    /// Creates an encrypted legacy main database without a bootstrap file.
    fn create_legacy_main_database(
        directory: &std::path::Path,
        root_key: &[u8],
        profiles: &[ConnectionProfile],
    ) {
        let encoded_key = STANDARD_NO_PAD.encode(root_key);
        let store =
            LocalStore::open(directory.join(LOCAL_DATABASE_FILENAME), &encoded_key).unwrap();
        for profile in profiles {
            store.save_connection(profile).unwrap();
        }
    }

    /// Verifies a new installation generates a stable 32-byte key and never touches legacy data.
    #[test]
    fn new_installation_bootstrap_key_is_stable() {
        let directory = tempfile::tempdir().unwrap();
        let first = initialize_local_storage(directory.path(), &PanicLegacyMigration, |key| {
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
        assert!(bootstrap_state.legacy_migration_complete);

        initialize_local_storage(directory.path(), &PanicLegacyMigration, |_| {
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

    /// Verifies an old encrypted database imports its key and passwords exactly once.
    #[test]
    fn legacy_database_migrates_credentials_only_once() {
        let directory = tempfile::tempdir().unwrap();
        let root_key = vec![0x33; 32];
        let profile = mysql_profile("Legacy MySQL");
        create_legacy_main_database(directory.path(), &root_key, std::slice::from_ref(&profile));
        let legacy = FakeLegacyMigration::new(root_key);
        legacy.insert_credential(profile.id, "legacy-database-password");

        let first = initialize_local_storage(directory.path(), &legacy, |_| {
            panic!("a legacy database must reuse its existing root key")
        })
        .unwrap();
        assert_eq!(
            first
                .get_connection_credential(profile.id)
                .unwrap()
                .expose_secret(),
            "legacy-database-password"
        );
        drop(first);
        initialize_local_storage(directory.path(), &legacy, |_| {
            panic!("an existing bootstrap must reuse its root key")
        })
        .unwrap();

        assert_eq!(legacy.root_key_reads.get(), 1);
        assert_eq!(legacy.credential_reads.get(), 1);
        assert!(
            BootstrapStore::open(&directory.path().join(BOOTSTRAP_DATABASE_FILENAME))
                .unwrap()
                .load()
                .unwrap()
                .legacy_migration_complete
        );
    }

    /// Verifies a failed credential migration preserves the main DB and remains retryable.
    #[test]
    fn failed_legacy_migration_preserves_main_database_and_marker() {
        let directory = tempfile::tempdir().unwrap();
        let root_key = vec![0x44; 32];
        let first_profile = mysql_profile("First Legacy MySQL");
        let second_profile = mysql_profile("Second Legacy MySQL");
        create_legacy_main_database(
            directory.path(),
            &root_key,
            &[first_profile.clone(), second_profile.clone()],
        );
        let legacy = FakeLegacyMigration::new(root_key.clone());
        legacy.insert_credential(first_profile.id, "first-legacy-password");

        let error = initialize_local_storage(directory.path(), &legacy, |_| {
            panic!("a legacy database must reuse its existing root key")
        })
        .unwrap_err();

        assert!(matches!(error.code, AppErrorCode::NotFound));
        assert!(!format!("{error:?}").contains("first-legacy-password"));
        let bootstrap =
            BootstrapStore::open(&directory.path().join(BOOTSTRAP_DATABASE_FILENAME)).unwrap();
        assert!(!bootstrap.load().unwrap().legacy_migration_complete);
        let encoded_key = STANDARD_NO_PAD.encode(&root_key);
        let preserved =
            LocalStore::open(directory.path().join(LOCAL_DATABASE_FILENAME), &encoded_key).unwrap();
        assert_eq!(preserved.list_connections().unwrap().len(), 2);
        assert!(preserved
            .get_connection_credential(first_profile.id)
            .is_err());
        drop(preserved);

        legacy.insert_credential(second_profile.id, "second-legacy-password");
        let migrated = initialize_local_storage(directory.path(), &legacy, |_| {
            panic!("retry must reuse the bootstrap root key")
        })
        .unwrap();
        assert_eq!(
            migrated
                .get_connection_credential(second_profile.id)
                .unwrap()
                .expose_secret(),
            "second-legacy-password"
        );
        assert_eq!(legacy.root_key_reads.get(), 1);
        assert!(
            BootstrapStore::open(&directory.path().join(BOOTSTRAP_DATABASE_FILENAME))
                .unwrap()
                .load()
                .unwrap()
                .legacy_migration_complete
        );
    }

    /// Verifies malformed legacy key material never replaces the existing encrypted main file.
    #[test]
    fn malformed_legacy_root_key_does_not_replace_main_database() {
        let directory = tempfile::tempdir().unwrap();
        let main_path = directory.path().join(LOCAL_DATABASE_FILENAME);
        std::fs::write(&main_path, b"existing-encrypted-main-database").unwrap();
        let legacy = FakeLegacyMigration::new(vec![0x55; 31]);

        let error = initialize_local_storage(directory.path(), &legacy, |_| {
            panic!("legacy installations must not generate a replacement key")
        })
        .unwrap_err();

        assert_eq!(error.message, "Local storage encryption key is invalid");
        assert_eq!(
            std::fs::read(main_path).unwrap(),
            b"existing-encrypted-main-database"
        );
        assert!(!directory.path().join(BOOTSTRAP_DATABASE_FILENAME).exists());
    }
}
