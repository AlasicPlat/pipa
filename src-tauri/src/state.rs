use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use pipa_core::{AppError, AppErrorCode};
use pipa_mysql::MySqlAdapter;
use pipa_store::{KeyringSecretStore, LocalStore, SecretStore};
use std::{collections::HashMap, fmt, path::Path, sync::Arc};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

const LOCAL_DATABASE_KEY_SERVICE: &str = "dev.pipa.app.local-store";
const LOCAL_DATABASE_KEY_USERNAME: &str = "encryption-key";
const LOCAL_DATABASE_KEY_LENGTH: usize = 32;
const LOCAL_DATABASE_FILENAME: &str = "pipa.db";

/// Shared application dependencies managed by the Tauri runtime.
pub struct AppState {
    /// Encrypted non-secret local persistence.
    pub local_store: Arc<LocalStore>,
    /// Operating-system-backed database credential storage.
    pub secret_store: Arc<dyn SecretStore>,
    /// Stateless MySQL database adapter.
    pub mysql: Arc<MySqlAdapter>,
    /// Cancellation tokens for currently running queries.
    pub cancellations: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
}

impl AppState {
    /// Initializes secure application dependencies inside the supplied app-data directory.
    ///
    /// # Side effects
    /// Accesses the operating-system keyring and opens or creates the encrypted local database.
    pub fn initialize(app_data_dir: &Path) -> Result<Self, AppError> {
        let key_store = KeyringLocalDatabaseKeyStore::new()?;
        let local_store = open_encrypted_local_store(app_data_dir, &key_store, |key| {
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
            secret_store: Arc::new(KeyringSecretStore),
            mysql: Arc::new(MySqlAdapter::new()),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}

/// Minimal key persistence boundary used to test startup without a real keyring.
trait LocalDatabaseKeyStore {
    /// Loads the raw local-database key or reports that no key has been created yet.
    fn load(&self) -> Result<Option<Vec<u8>>, AppError>;

    /// Stores one newly generated raw local-database key.
    fn save(&self, key: &[u8]) -> Result<(), AppError>;
}

/// Dedicated operating-system keyring entry for the local database encryption key.
struct KeyringLocalDatabaseKeyStore {
    entry: keyring::Entry,
}

impl KeyringLocalDatabaseKeyStore {
    /// Creates the dedicated local-database keyring entry.
    fn new() -> Result<Self, AppError> {
        keyring::Entry::new(LOCAL_DATABASE_KEY_SERVICE, LOCAL_DATABASE_KEY_USERNAME)
            .map(|entry| Self { entry })
            .map_err(|error| {
                startup_storage_error(
                    "Could not access local storage encryption key",
                    "create keyring entry",
                    error,
                )
            })
    }
}

impl LocalDatabaseKeyStore for KeyringLocalDatabaseKeyStore {
    /// Loads raw key bytes while treating only a missing entry as first startup.
    fn load(&self) -> Result<Option<Vec<u8>>, AppError> {
        match self.entry.get_secret() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(startup_storage_error(
                "Could not access local storage encryption key",
                "read keyring entry",
                error,
            )),
        }
    }

    /// Saves raw key bytes to the operating-system credential store.
    fn save(&self, key: &[u8]) -> Result<(), AppError> {
        self.entry.set_secret(key).map_err(|error| {
            startup_storage_error(
                "Could not save local storage encryption key",
                "write keyring entry",
                error,
            )
        })
    }
}

/// Opens encrypted local storage using a loaded or newly generated 32-byte key.
fn open_encrypted_local_store(
    app_data_dir: &Path,
    key_store: &impl LocalDatabaseKeyStore,
    fill_random: impl FnOnce(&mut [u8]) -> Result<(), AppError>,
) -> Result<LocalStore, AppError> {
    let key = match key_store.load()? {
        Some(key) => Zeroizing::new(key),
        None => {
            let mut key = Zeroizing::new(vec![0_u8; LOCAL_DATABASE_KEY_LENGTH]);
            fill_random(&mut key)?;
            key_store.save(&key)?;
            key
        }
    };
    if key.len() != LOCAL_DATABASE_KEY_LENGTH {
        return Err(AppError {
            code: AppErrorCode::Storage,
            message: "Local storage encryption key is invalid".into(),
            technical_details: Some("keyring entry did not contain exactly 32 bytes".into()),
            retryable: false,
        });
    }

    std::fs::create_dir_all(app_data_dir).map_err(|error| {
        startup_storage_error(
            "Could not prepare local storage directory",
            "create app-data directory",
            error,
        )
    })?;
    let encoded_key = Zeroizing::new(STANDARD_NO_PAD.encode(&*key));
    LocalStore::open(app_data_dir.join(LOCAL_DATABASE_FILENAME), &encoded_key)
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
    use super::{open_encrypted_local_store, LocalDatabaseKeyStore};
    use pipa_core::{AppError, AppErrorCode};
    use std::sync::Mutex as StdMutex;

    /// Injectable memory key store used without accessing the operating-system keyring.
    #[derive(Debug, Default)]
    struct MemoryLocalDatabaseKeyStore {
        key: StdMutex<Option<Vec<u8>>>,
        load_error: bool,
    }

    impl LocalDatabaseKeyStore for MemoryLocalDatabaseKeyStore {
        /// Loads the current in-memory encryption key.
        fn load(&self) -> Result<Option<Vec<u8>>, AppError> {
            if self.load_error {
                return Err(keyring_unavailable_error());
            }
            Ok(self.key.lock().unwrap().clone())
        }

        /// Saves the generated encryption key in memory.
        fn save(&self, key: &[u8]) -> Result<(), AppError> {
            *self.key.lock().unwrap() = Some(key.to_vec());
            Ok(())
        }
    }

    /// Creates the stable startup error used by the unavailable-keyring test.
    fn keyring_unavailable_error() -> AppError {
        AppError {
            code: AppErrorCode::Storage,
            message: "Could not access local storage encryption key".into(),
            technical_details: Some("test keyring unavailable".into()),
            retryable: false,
        }
    }

    /// Verifies first startup generates and securely stores exactly 32 key bytes.
    #[test]
    fn missing_key_generates_32_bytes_before_opening_encrypted_store() {
        let directory = tempfile::tempdir().unwrap();
        let key_store = MemoryLocalDatabaseKeyStore::default();

        let store = open_encrypted_local_store(directory.path(), &key_store, |key| {
            key.fill(0xA5);
            Ok(())
        })
        .unwrap();

        assert_eq!(store.path(), directory.path().join("pipa.db"));
        assert_eq!(
            key_store.key.lock().unwrap().as_deref(),
            Some(&[0xA5; 32][..])
        );
    }

    /// Verifies malformed keyring data is rejected rather than used or regenerated.
    #[test]
    fn existing_key_must_be_exactly_32_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let key_store = MemoryLocalDatabaseKeyStore {
            key: StdMutex::new(Some(vec![0xA5; 31])),
            load_error: false,
        };

        let error = open_encrypted_local_store(directory.path(), &key_store, |_| {
            panic!("an existing malformed key must never be replaced")
        })
        .unwrap_err();

        assert!(matches!(error.code, AppErrorCode::Storage));
        assert_eq!(error.message, "Local storage encryption key is invalid");
        assert!(!directory.path().join("pipa.db").exists());
    }

    /// Verifies keyring failure aborts startup without a generated or plaintext fallback.
    #[test]
    fn keyring_failure_does_not_open_local_store() {
        let directory = tempfile::tempdir().unwrap();
        let key_store = MemoryLocalDatabaseKeyStore {
            key: StdMutex::new(None),
            load_error: true,
        };

        let error = open_encrypted_local_store(directory.path(), &key_store, |_| {
            panic!("key generation must not run when keyring access fails")
        })
        .unwrap_err();

        assert_eq!(
            error.message,
            "Could not access local storage encryption key"
        );
        assert!(!directory.path().join("pipa.db").exists());
    }
}
