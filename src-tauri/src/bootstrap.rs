use pipa_core::{AppError, AppErrorCode};
use rusqlite::{params, Connection, OpenFlags};
use std::{
    ffi::OsString,
    fmt,
    fs::OpenOptions,
    path::{Path, PathBuf},
};
use uuid::Uuid;
use zeroize::Zeroizing;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[cfg(target_os = "macos")]
use std::{ffi::CString, os::unix::ffi::OsStrExt};

const BOOTSTRAP_SCHEMA: &str = "CREATE TABLE bootstrap_state (
       singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
       root_key BLOB NOT NULL CHECK(length(root_key) = 32)
     );";

/// Plaintext bootstrap value required before the encrypted main database can be opened.
pub(crate) struct BootstrapState {
    /// Random 32-byte root key used only to derive the SQLCipher key string.
    pub(crate) root_key: Zeroizing<Vec<u8>>,
}

/// Minimal plaintext SQLite bootstrap store for the SQLCipher root key.
///
/// The root key cannot live inside the database it unlocks. This file is therefore a deliberate
/// local trust boundary protected by restrictive filesystem permissions rather than encryption.
pub(crate) struct BootstrapStore {
    connection: Connection,
}

impl BootstrapStore {
    /// Atomically creates a new bootstrap database without replacing an existing final file.
    ///
    /// # Parameters
    /// `path` is the final bootstrap SQLite path and `root_key` must contain exactly 32 random
    /// bytes.
    ///
    /// # Returns
    /// A ready bootstrap store containing the supplied root key.
    ///
    /// # Side effects
    /// Initializes a unique same-directory `0600` temporary SQLite database using a transaction,
    /// synchronizes it, atomically publishes it without clobbering an existing final file, and
    /// synchronizes the parent directory on Unix.
    pub(crate) fn create(path: &Path, root_key: &[u8]) -> Result<Self, AppError> {
        create_bootstrap(path, root_key, BOOTSTRAP_SCHEMA)
    }

    /// Opens an existing bootstrap database without creating a missing replacement.
    ///
    /// # Parameters
    /// `path` is the expected plaintext bootstrap SQLite path.
    ///
    /// # Returns
    /// A ready bootstrap store whose root key can be loaded.
    ///
    /// # Side effects
    /// Opens the file read/write, reapplies mode `0600` on Unix, and forces DELETE journaling.
    pub(crate) fn open(path: &Path) -> Result<Self, AppError> {
        secure_file_permissions(path)?;
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|error| {
                bootstrap_error(
                    "Could not open local storage bootstrap",
                    "open bootstrap",
                    error,
                )
            })?;
        configure_bootstrap(&connection)?;
        Ok(Self { connection })
    }

    /// Loads and validates the singleton root key.
    ///
    /// # Returns
    /// The validated 32-byte root key.
    ///
    /// # Side effects
    /// Reads one row from the bootstrap database.
    pub(crate) fn load(&self) -> Result<BootstrapState, AppError> {
        let root_key = self
            .connection
            .query_row(
                "SELECT root_key FROM bootstrap_state WHERE singleton = 1",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .map_err(|error| {
                bootstrap_error(
                    "Could not read local storage bootstrap",
                    "read bootstrap state",
                    error,
                )
            })?;
        validate_root_key(&root_key)?;
        Ok(BootstrapState {
            root_key: Zeroizing::new(root_key),
        })
    }
}

/// Probes one local path without treating metadata errors as absence.
///
/// # Parameters
/// `path` is the path to inspect and `operation` is a non-secret diagnostic label.
///
/// # Returns
/// Whether the path exists, or a stable storage error when the probe itself fails.
///
/// # Side effects
/// Reads filesystem metadata only.
pub(crate) fn try_path_exists(path: &Path, operation: &'static str) -> Result<bool, AppError> {
    path.try_exists()
        .map_err(|error| bootstrap_error("Could not inspect local storage path", operation, error))
}

/// Builds and atomically publishes one complete bootstrap using the supplied schema.
fn create_bootstrap(
    path: &Path,
    root_key: &[u8],
    schema: &str,
) -> Result<BootstrapStore, AppError> {
    validate_root_key(root_key)?;
    if try_path_exists(path, "probe bootstrap target before create")? {
        return Err(bootstrap_target_exists_error());
    }
    let temporary_path = unique_temporary_path(path)?;
    let initialization = initialize_temporary_bootstrap(&temporary_path, root_key, schema);
    if let Err(error) = initialization {
        cleanup_temporary_file(&temporary_path);
        return Err(error);
    }

    if let Err(error) = publish_temporary_bootstrap(&temporary_path, path) {
        cleanup_temporary_file(&temporary_path);
        return Err(error);
    }
    sync_parent_directory(path)?;
    BootstrapStore::open(path)
}

/// Creates and commits one complete temporary bootstrap database.
fn initialize_temporary_bootstrap(
    temporary_path: &Path,
    root_key: &[u8],
    schema: &str,
) -> Result<(), AppError> {
    create_private_file(temporary_path)?;
    let mut connection = Connection::open(temporary_path).map_err(|error| {
        bootstrap_error(
            "Could not create local storage bootstrap",
            "open temporary bootstrap",
            error,
        )
    })?;
    configure_bootstrap(&connection)?;
    let transaction = connection.transaction().map_err(|error| {
        bootstrap_error(
            "Could not create local storage bootstrap",
            "begin bootstrap transaction",
            error,
        )
    })?;
    transaction
        .execute_batch(schema)
        .and_then(|_| {
            transaction.execute(
                "INSERT INTO bootstrap_state (singleton, root_key) VALUES (1, ?1)",
                params![root_key],
            )
        })
        .and_then(|_| transaction.commit())
        .map_err(|error| {
            bootstrap_error(
                "Could not create local storage bootstrap",
                "commit bootstrap state",
                error,
            )
        })?;
    drop(connection);
    OpenOptions::new()
        .read(true)
        .open(temporary_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| {
            bootstrap_error(
                "Could not synchronize local storage bootstrap",
                "sync temporary bootstrap",
                error,
            )
        })
}

/// Creates a unique same-directory temporary path ignored by normal startup probes.
fn unique_temporary_path(final_path: &Path) -> Result<PathBuf, AppError> {
    let parent = final_path
        .parent()
        .ok_or_else(|| invalid_bootstrap_error("bootstrap path did not have a parent directory"))?;
    let file_name = final_path
        .file_name()
        .ok_or_else(|| invalid_bootstrap_error("bootstrap path did not have a final file name"))?;
    let mut temporary_name = OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(format!(".tmp-{}-{}", std::process::id(), Uuid::new_v4()));
    Ok(parent.join(temporary_name))
}

/// Creates a private file before SQLite opens it, avoiding a permissive creation window.
fn create_private_file(path: &Path) -> Result<(), AppError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).map(|_| ()).map_err(|error| {
        bootstrap_error(
            "Could not create local storage bootstrap",
            "create private temporary bootstrap",
            error,
        )
    })
}

/// Atomically publishes a completed temporary bootstrap without overwriting the final path.
fn publish_temporary_bootstrap(temporary_path: &Path, final_path: &Path) -> Result<(), AppError> {
    if try_path_exists(final_path, "probe bootstrap target before publish")? {
        return Err(bootstrap_target_exists_error());
    }

    atomic_publish_without_clobber(temporary_path, final_path).map_err(|error| {
        bootstrap_error(
            "Could not publish local storage bootstrap",
            "atomically publish bootstrap without clobbering",
            error,
        )
    })?;
    Ok(())
}

/// Atomically renames a complete bootstrap into place without replacing an existing macOS file.
#[cfg(target_os = "macos")]
fn atomic_publish_without_clobber(temporary_path: &Path, final_path: &Path) -> std::io::Result<()> {
    let source = CString::new(temporary_path.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "temporary bootstrap path contained a NUL byte",
        )
    })?;
    let destination = CString::new(final_path.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "final bootstrap path contained a NUL byte",
        )
    })?;
    // SAFETY: both C strings are NUL-terminated, live through the call, and RENAME_EXCL asks the
    // kernel for the required atomic same-filesystem no-clobber rename.
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Atomically publishes without clobbering on platforms lacking macOS `RENAME_EXCL`.
#[cfg(not(target_os = "macos"))]
fn atomic_publish_without_clobber(temporary_path: &Path, final_path: &Path) -> std::io::Result<()> {
    // A same-filesystem hard link atomically creates the final name and fails if it exists. A
    // crash before cleanup can only retain the uniquely named temporary link.
    std::fs::hard_link(temporary_path, final_path)?;
    std::fs::remove_file(temporary_path)
}

/// Removes a failed temporary bootstrap and any transient DELETE-journal sidecar.
fn cleanup_temporary_file(temporary_path: &Path) {
    let _ = std::fs::remove_file(temporary_path);
    let mut journal_name = temporary_path.as_os_str().to_os_string();
    journal_name.push("-journal");
    let _ = std::fs::remove_file(PathBuf::from(journal_name));
}

/// Restricts an existing bootstrap file to its current Unix user.
fn secure_file_permissions(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                bootstrap_error(
                    "Could not secure local storage bootstrap",
                    "set bootstrap file permissions",
                    error,
                )
            },
        )?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Applies the no-WAL, full-synchronization policy used by the tiny plaintext bootstrap.
fn configure_bootstrap(connection: &Connection) -> Result<(), AppError> {
    connection
        .query_row("PRAGMA journal_mode = DELETE", [], |row| {
            row.get::<_, String>(0)
        })
        .and_then(|_| connection.pragma_update(None, "synchronous", "FULL"))
        .map_err(|error| {
            bootstrap_error(
                "Could not configure local storage bootstrap",
                "configure bootstrap journaling",
                error,
            )
        })
}

/// Synchronizes the parent directory so a published name survives a power loss on Unix.
fn sync_parent_directory(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        let parent = path.parent().ok_or_else(|| {
            invalid_bootstrap_error("bootstrap path did not have a parent directory")
        })?;
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                bootstrap_error(
                    "Could not synchronize local storage bootstrap",
                    "sync bootstrap parent directory",
                    error,
                )
            })?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Rejects malformed root-key material without including it in diagnostics.
fn validate_root_key(root_key: &[u8]) -> Result<(), AppError> {
    if root_key.len() == 32 {
        Ok(())
    } else {
        Err(invalid_bootstrap_error(
            "root key did not contain exactly 32 bytes",
        ))
    }
}

/// Builds a stable error when a bootstrap target already exists.
fn bootstrap_target_exists_error() -> AppError {
    AppError {
        code: AppErrorCode::Storage,
        message: "Local storage bootstrap already exists".into(),
        technical_details: Some("bootstrap creation refused to replace the final path".into()),
        retryable: false,
    }
}

/// Builds a stable bootstrap corruption error without secret values.
fn invalid_bootstrap_error(reason: &'static str) -> AppError {
    AppError {
        code: AppErrorCode::Storage,
        message: "Local storage bootstrap is invalid".into(),
        technical_details: Some(reason.into()),
        retryable: false,
    }
}

/// Converts a bootstrap implementation error into a stable redacted application error.
fn bootstrap_error(
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
    use super::{create_bootstrap, BootstrapStore};

    /// Verifies the plaintext bootstrap preserves its 32-byte root key across reloads.
    #[test]
    fn bootstrap_root_key_is_stable_across_reload() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pipa-bootstrap.db");
        let expected_key = [0xA5; 32];

        let bootstrap = BootstrapStore::create(&path, &expected_key).unwrap();
        drop(bootstrap);
        let reloaded = BootstrapStore::open(&path).unwrap().load().unwrap();

        assert_eq!(reloaded.root_key.as_slice(), expected_key);
        let connection = rusqlite::Connection::open(&path).unwrap();
        let journal_mode = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap();
        assert_eq!(journal_mode, "delete");
        assert!(!path.with_extension("db-wal").try_exists().unwrap());
    }

    /// Verifies schema initialization failures and malformed keys never publish the final path.
    #[test]
    fn bootstrap_creation_failure_does_not_publish_final_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pipa-bootstrap.db");

        assert!(BootstrapStore::create(&path, &[0xA5; 31]).is_err());
        assert!(!path.try_exists().unwrap());
        assert!(create_bootstrap(&path, &[0xA5; 32], "INVALID SQL").is_err());
        assert!(!path.try_exists().unwrap());
    }

    /// Verifies a crashed process's unique stale temp file does not block a later valid create.
    #[test]
    fn stale_bootstrap_temp_does_not_block_atomic_create() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pipa-bootstrap.db");
        let stale_temp = directory.path().join(".pipa-bootstrap.db.tmp-stale");
        std::fs::write(&stale_temp, b"stale").unwrap();

        let bootstrap = BootstrapStore::create(&path, &[0x5A; 32]).unwrap();

        assert_eq!(bootstrap.load().unwrap().root_key.as_slice(), &[0x5A; 32]);
        assert_eq!(std::fs::read(stale_temp).unwrap(), b"stale");
    }

    /// Verifies atomic publication never replaces an existing valid bootstrap.
    #[test]
    fn bootstrap_atomic_publish_never_clobbers_existing_final() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pipa-bootstrap.db");
        let first = BootstrapStore::create(&path, &[0x11; 32]).unwrap();
        drop(first);

        assert!(BootstrapStore::create(&path, &[0x22; 32]).is_err());

        assert_eq!(
            BootstrapStore::open(&path)
                .unwrap()
                .load()
                .unwrap()
                .root_key
                .as_slice(),
            &[0x11; 32]
        );
    }
}
