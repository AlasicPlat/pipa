//! Lightweight key/value application settings persisted in SQLCipher.

use crate::{storage_error, LocalStore};
use pipa_core::AppError;
use uuid::Uuid;

const MCP_ENABLED_KEY: &str = "mcp_enabled";
const MCP_PORT_KEY: &str = "mcp_port";
const MCP_RESTRICT_TO_CONNECTION_KEY: &str = "mcp_restrict_to_connection";
const MCP_TARGET_CONNECTION_ID_KEY: &str = "mcp_target_connection_id";
const DEFAULT_MCP_PORT: u16 = 3847;

/// Persisted MCP-related preferences (token is never stored).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpSettings {
    /// Whether MCP should auto-start on application launch.
    pub enabled: bool,
    /// Preferred loopback TCP port for the Streamable HTTP server.
    pub port: u16,
    /// Whether MCP tools are restricted to one saved connection.
    pub restrict_to_connection: bool,
    /// Saved connection selected as the MCP target, including while restriction is disabled.
    pub target_connection_id: Option<Uuid>,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_MCP_PORT,
            restrict_to_connection: false,
            target_connection_id: None,
        }
    }
}

impl LocalStore {
    /// Ensures the `app_settings` table exists.
    pub(crate) fn ensure_app_settings_table(&self) -> Result<(), AppError> {
        let connection = self.connection()?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS app_settings (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
                 );",
            )
            .map_err(|error| {
                storage_error(
                    "Could not initialize application settings",
                    "create app_settings",
                    error,
                )
            })?;
        Ok(())
    }

    /// Loads MCP preferences, applying defaults for missing keys.
    pub fn load_mcp_settings(&self) -> Result<McpSettings, AppError> {
        self.ensure_app_settings_table()?;
        let enabled = self
            .get_setting(MCP_ENABLED_KEY)?
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let port = self
            .get_setting(MCP_PORT_KEY)?
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port > 0)
            .unwrap_or(DEFAULT_MCP_PORT);
        let restrict_to_connection = self
            .get_setting(MCP_RESTRICT_TO_CONNECTION_KEY)?
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let target_connection_id = self
            .get_setting(MCP_TARGET_CONNECTION_ID_KEY)?
            .and_then(|value| Uuid::parse_str(value.trim()).ok());
        Ok(McpSettings {
            enabled,
            port,
            restrict_to_connection,
            target_connection_id,
        })
    }

    /// Persists MCP preferences (never stores the bearer token).
    pub fn save_mcp_settings(&self, settings: &McpSettings) -> Result<(), AppError> {
        self.ensure_app_settings_table()?;
        self.set_setting(MCP_ENABLED_KEY, if settings.enabled { "1" } else { "0" })?;
        self.set_setting(MCP_PORT_KEY, &settings.port.to_string())?;
        self.set_setting(
            MCP_RESTRICT_TO_CONNECTION_KEY,
            if settings.restrict_to_connection {
                "1"
            } else {
                "0"
            },
        )?;
        self.set_setting(
            MCP_TARGET_CONNECTION_ID_KEY,
            &settings
                .target_connection_id
                .map(|connection_id| connection_id.to_string())
                .unwrap_or_default(),
        )?;
        Ok(())
    }

    fn get_setting(&self, key: &str) -> Result<Option<String>, AppError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT value FROM app_settings WHERE key = ?1")
            .map_err(|error| {
                storage_error(
                    "Could not read application settings",
                    "prepare select",
                    error,
                )
            })?;
        let mut rows = statement.query(rusqlite::params![key]).map_err(|error| {
            storage_error("Could not read application settings", "query select", error)
        })?;
        match rows.next() {
            Ok(Some(row)) => row.get(0).map(Some).map_err(|error| {
                storage_error("Could not read application settings", "read value", error)
            }),
            Ok(None) => Ok(None),
            Err(error) => Err(storage_error(
                "Could not read application settings",
                "iterate rows",
                error,
            )),
        }
    }

    fn set_setting(&self, key: &str, value: &str) -> Result<(), AppError> {
        let connection = self.connection()?;
        connection
            .execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![key, value],
            )
            .map_err(|error| {
                storage_error(
                    "Could not save application settings",
                    "upsert setting",
                    error,
                )
            })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::McpSettings;
    use crate::LocalStore;
    use tempfile::TempDir;
    use uuid::Uuid;

    fn test_store() -> (TempDir, LocalStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalStore::open(directory.path().join("pipa.db"), "test-key").unwrap();
        (directory, store)
    }

    #[test]
    fn mcp_settings_default_and_round_trip() {
        let (_dir, store) = test_store();
        assert_eq!(store.load_mcp_settings().unwrap(), McpSettings::default());
        let target_connection_id = Uuid::new_v4();
        let settings = McpSettings {
            enabled: true,
            port: 4099,
            restrict_to_connection: true,
            target_connection_id: Some(target_connection_id),
        };
        store.save_mcp_settings(&settings).unwrap();
        assert_eq!(store.load_mcp_settings().unwrap(), settings);
    }
}
