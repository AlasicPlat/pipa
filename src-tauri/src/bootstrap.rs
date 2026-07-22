use pipa_core::{AppError, AppErrorCode};
use rusqlite::{params, Connection, OpenFlags};
use std::{fmt, fs::OpenOptions, path::Path};
use zeroize::Zeroizing;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const BOOTSTRAP_SCHEMA: &str = "CREATE TABLE bootstrap_state (
       singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
       root_key BLOB NOT NULL CHECK(length(root_key) = 32),
       legacy_migration_complete INTEGER NOT NULL CHECK(legacy_migration_complete IN (0, 1))
     );";

/// Plaintext bootstrap values required before the encrypted main database can be opened.
pub(crate) struct BootstrapState {
    /// Random 32-byte root key used only to derive the SQLCipher key string.
    pub(crate) root_key: Zeroizing<Vec<u8>>,
    /// Whether all credentials from the legacy keyring layout were imported successfully.
    pub(crate) legacy_migration_complete: bool,
}

/// Minimal plaintext SQLite bootstrap store for the SQLCipher root key and migration marker.
///
/// The root key cannot live inside the database it unlocks. This file is therefore a deliberate
/// local trust boundary protected by restrictive filesystem permissions rather than encryption.
pub(crate) struct BootstrapStore {
    connection: Connection,
}

impl BootstrapStore {
    /// Creates a new bootstrap database without replacing an existing file.
    ///
    /// # Parameters
    /// `path` is the bootstrap SQLite path, `root_key` must contain exactly 32 random bytes, and
    /// `legacy_migration_complete` records whether a legacy keyring import is still required.
    ///
    /// # Returns
    /// A ready bootstrap store containing the supplied state.
    ///
    /// # Side effects
    /// Creates a plaintext SQLite file with mode `0600` on Unix and forces DELETE journaling.
    pub(crate) fn create(
        path: &Path,
        root_key: &[u8],
        legacy_migration_complete: bool,
    ) -> Result<Self, AppError> {
        validate_root_key(root_key)?;
        create_private_file(path)?;
        let connection = Connection::open(path).map_err(|error| {
            bootstrap_error(
                "Could not create local storage bootstrap",
                "open bootstrap",
                error,
            )
        })?;
        configure_bootstrap(&connection)?;
        connection
            .execute_batch(BOOTSTRAP_SCHEMA)
            .and_then(|_| {
                connection.execute(
                    "INSERT INTO bootstrap_state (
                       singleton, root_key, legacy_migration_complete
                     ) VALUES (1, ?1, ?2)",
                    params![root_key, legacy_migration_complete],
                )
            })
            .map_err(|error| {
                bootstrap_error(
                    "Could not create local storage bootstrap",
                    "initialize bootstrap state",
                    error,
                )
            })?;
        Ok(Self { connection })
    }

    /// Opens an existing bootstrap database without creating a missing replacement.
    ///
    /// # Parameters
    /// `path` is the expected plaintext bootstrap SQLite path.
    ///
    /// # Returns
    /// A ready bootstrap store whose state can be loaded.
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

    /// Loads and validates the singleton root-key and migration state.
    ///
    /// # Returns
    /// The validated 32-byte root key and legacy migration marker.
    ///
    /// # Side effects
    /// Reads one row from the bootstrap database.
    pub(crate) fn load(&self) -> Result<BootstrapState, AppError> {
        let (root_key, migration_complete) = self
            .connection
            .query_row(
                "SELECT root_key, legacy_migration_complete
                 FROM bootstrap_state
                 WHERE singleton = 1",
                [],
                |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(|error| {
                bootstrap_error(
                    "Could not read local storage bootstrap",
                    "read bootstrap state",
                    error,
                )
            })?;
        validate_root_key(&root_key)?;
        let legacy_migration_complete = match migration_complete {
            0 => false,
            1 => true,
            _ => return Err(invalid_bootstrap_error("migration marker was not boolean")),
        };
        Ok(BootstrapState {
            root_key: Zeroizing::new(root_key),
            legacy_migration_complete,
        })
    }

    /// Permanently marks the one-time legacy keyring migration as complete.
    ///
    /// # Returns
    /// `Ok(())` after the singleton marker is updated.
    ///
    /// # Side effects
    /// Commits one small update to the plaintext bootstrap database.
    pub(crate) fn mark_legacy_migration_complete(&self) -> Result<(), AppError> {
        let updated = self
            .connection
            .execute(
                "UPDATE bootstrap_state
                 SET legacy_migration_complete = 1
                 WHERE singleton = 1",
                [],
            )
            .map_err(|error| {
                bootstrap_error(
                    "Could not update local storage bootstrap",
                    "mark legacy migration complete",
                    error,
                )
            })?;
        if updated == 1 {
            Ok(())
        } else {
            Err(invalid_bootstrap_error("bootstrap singleton was missing"))
        }
    }
}

/// Creates the bootstrap file with restrictive permissions before SQLite opens it.
fn create_private_file(path: &Path) -> Result<(), AppError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).map(|_| ()).map_err(|error| {
        bootstrap_error(
            "Could not create local storage bootstrap",
            "create private bootstrap file",
            error,
        )
    })
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

/// Applies the no-WAL durability policy used by the tiny plaintext bootstrap.
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
    use super::BootstrapStore;

    /// Verifies the plaintext bootstrap preserves the 32-byte root key and completion marker.
    #[test]
    fn bootstrap_root_key_is_stable_across_reload() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pipa-bootstrap.db");
        let expected_key = [0xA5; 32];

        let bootstrap = BootstrapStore::create(&path, &expected_key, true).unwrap();
        drop(bootstrap);
        let reloaded = BootstrapStore::open(&path).unwrap().load().unwrap();

        assert_eq!(reloaded.root_key.as_slice(), expected_key);
        assert!(reloaded.legacy_migration_complete);
        let connection = rusqlite::Connection::open(&path).unwrap();
        let journal_mode = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap();
        assert_eq!(journal_mode, "delete");
        assert!(!path.with_extension("db-wal").exists());
    }
}
