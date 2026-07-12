use crate::storage_error;
use pipa_core::AppError;
use secrecy::{ExposeSecret, SecretString};
use uuid::Uuid;

#[cfg(test)]
use pipa_core::AppErrorCode;
#[cfg(test)]
use std::{collections::HashMap, sync::Mutex};

const DATABASE_CREDENTIAL_SERVICE: &str = "dev.pipa.app.database";

/// Isolated credential persistence keyed by connection identifier.
pub trait SecretStore: Send + Sync {
    /// Saves or replaces the credential for a connection.
    fn set(&self, connection_id: Uuid, secret: &SecretString) -> Result<(), AppError>;

    /// Loads the credential for a connection.
    fn get(&self, connection_id: Uuid) -> Result<SecretString, AppError>;

    /// Deletes the credential for a connection.
    fn delete(&self, connection_id: Uuid) -> Result<(), AppError>;
}

/// Operating-system credential store for database passwords.
#[derive(Clone, Copy, Debug, Default)]
pub struct KeyringSecretStore;

impl KeyringSecretStore {
    /// Creates a keyring entry without including secret material in its identity.
    fn entry(connection_id: Uuid) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(DATABASE_CREDENTIAL_SERVICE, &connection_id.to_string()).map_err(
            |error| {
                storage_error(
                    "Could not access database credentials",
                    "create credential entry",
                    error,
                )
            },
        )
    }
}

impl SecretStore for KeyringSecretStore {
    fn set(&self, connection_id: Uuid, secret: &SecretString) -> Result<(), AppError> {
        Self::entry(connection_id)?
            .set_password(secret.expose_secret())
            .map_err(|error| {
                storage_error(
                    "Could not save database credential",
                    "write credential entry",
                    error,
                )
            })
    }

    fn get(&self, connection_id: Uuid) -> Result<SecretString, AppError> {
        Self::entry(connection_id)?
            .get_password()
            .map(SecretString::from)
            .map_err(|error| {
                storage_error(
                    "Could not read database credential",
                    "read credential entry",
                    error,
                )
            })
    }

    fn delete(&self, connection_id: Uuid) -> Result<(), AppError> {
        Self::entry(connection_id)?
            .delete_credential()
            .map_err(|error| {
                storage_error(
                    "Could not delete database credential",
                    "delete credential entry",
                    error,
                )
            })
    }
}

/// In-memory credential store available only to tests.
#[cfg(test)]
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    secrets: Mutex<HashMap<Uuid, SecretString>>,
}

#[cfg(test)]
impl SecretStore for MemorySecretStore {
    fn set(&self, connection_id: Uuid, secret: &SecretString) -> Result<(), AppError> {
        self.secrets
            .lock()
            .map_err(|_| memory_lock_error())?
            .insert(connection_id, secret.clone());
        Ok(())
    }

    fn get(&self, connection_id: Uuid) -> Result<SecretString, AppError> {
        self.secrets
            .lock()
            .map_err(|_| memory_lock_error())?
            .get(&connection_id)
            .cloned()
            .ok_or_else(|| AppError {
                code: AppErrorCode::NotFound,
                message: "Database credential was not found".into(),
                technical_details: None,
                retryable: false,
            })
    }

    fn delete(&self, connection_id: Uuid) -> Result<(), AppError> {
        self.secrets
            .lock()
            .map_err(|_| memory_lock_error())?
            .remove(&connection_id);
        Ok(())
    }
}

/// Creates the stable error used when the test credential store lock is poisoned.
#[cfg(test)]
fn memory_lock_error() -> AppError {
    AppError {
        code: AppErrorCode::Storage,
        message: "Could not access database credentials".into(),
        technical_details: Some("in-memory credential lock was poisoned".into()),
        retryable: false,
    }
}
