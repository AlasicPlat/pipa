use pipa_core::{AppError, AppErrorCode};
use secrecy::SecretString;
use std::fmt;
use uuid::Uuid;
use zeroize::Zeroizing;

const LEGACY_DATABASE_KEY_SERVICE: &str = "dev.pipa.app.local-store";
const LEGACY_DATABASE_KEY_USERNAME: &str = "encryption-key";
const LEGACY_CREDENTIAL_SERVICE: &str = "dev.pipa.app.database";

/// Isolated read-only boundary for the one-time migration from the legacy keyring layout.
pub(crate) trait LegacySecretMigration {
    /// Loads the legacy raw SQLCipher root key without deleting or rewriting its keyring item.
    fn load_root_key(&self) -> Result<Zeroizing<Vec<u8>>, AppError>;

    /// Loads one legacy connection password without deleting or rewriting its keyring item.
    fn load_connection_credential(&self, connection_id: Uuid) -> Result<SecretString, AppError>;
}

/// Read-only operating-system keyring adapter used only while upgrading a legacy installation.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct KeyringLegacyMigration;

impl LegacySecretMigration for KeyringLegacyMigration {
    fn load_root_key(&self) -> Result<Zeroizing<Vec<u8>>, AppError> {
        let entry = keyring::Entry::new(LEGACY_DATABASE_KEY_SERVICE, LEGACY_DATABASE_KEY_USERNAME)
            .map_err(|error| {
                legacy_error(
                    "Could not access legacy local storage key",
                    "create legacy root-key entry",
                    error,
                )
            })?;
        match entry.get_secret() {
            Ok(key) => Ok(Zeroizing::new(key)),
            Err(keyring::Error::NoEntry) => Err(legacy_missing_error(
                "Legacy local storage key was not found",
                "legacy root-key entry is missing",
            )),
            Err(error) => Err(legacy_error(
                "Could not read legacy local storage key",
                "read legacy root-key entry",
                error,
            )),
        }
    }

    fn load_connection_credential(&self, connection_id: Uuid) -> Result<SecretString, AppError> {
        let entry = keyring::Entry::new(LEGACY_CREDENTIAL_SERVICE, &connection_id.to_string())
            .map_err(|error| {
                legacy_error(
                    "Could not access legacy database credential",
                    "create legacy credential entry",
                    error,
                )
            })?;
        match entry.get_password() {
            Ok(password) => Ok(SecretString::from(password)),
            Err(keyring::Error::NoEntry) => Err(legacy_missing_error(
                "Legacy database credential was not found",
                "legacy credential entry is missing",
            )),
            Err(error) => Err(legacy_error(
                "Could not read legacy database credential",
                "read legacy credential entry",
                error,
            )),
        }
    }
}

/// Creates a stable not-found error for an absent legacy keyring item.
fn legacy_missing_error(message: &'static str, detail: &'static str) -> AppError {
    AppError {
        code: AppErrorCode::NotFound,
        message: message.into(),
        technical_details: Some(detail.into()),
        retryable: false,
    }
}

/// Converts an operating-system keyring failure into a redacted migration error.
fn legacy_error(
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
