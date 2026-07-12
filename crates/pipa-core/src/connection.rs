use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use std::fmt;
use ts_rs::TS;
use uuid::Uuid;

/// Database engines represented in the Pipa workspace.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Engine {
    /// MySQL-compatible databases.
    MySql,
    /// PostgreSQL-compatible databases.
    PostgreSql,
    /// MongoDB databases.
    MongoDb,
    /// Redis databases.
    Redis,
}

/// Operational environment assigned to a connection.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Environment {
    /// A production environment.
    Production,
    /// A development environment.
    Development,
    /// An environment that has not been classified.
    Unspecified,
}

/// TLS policy used when opening a database connection.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TlsMode {
    /// Do not negotiate TLS.
    Disabled,
    /// Prefer TLS but permit an unencrypted connection.
    Preferred,
    /// Require TLS.
    Required,
}

/// Non-secret configuration for a saved database connection.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConnectionProfile {
    /// Stable connection identifier.
    #[ts(type = "string")]
    pub id: Uuid,
    /// User-visible connection name.
    pub name: String,
    /// Database engine.
    pub engine: Engine,
    /// Operational environment.
    pub environment: Environment,
    /// Database server hostname or address.
    pub host: String,
    /// Database server port.
    pub port: u16,
    /// Database account username.
    pub username: String,
    /// Optional default database.
    pub database: Option<String>,
    /// TLS policy.
    pub tls_mode: TlsMode,
}

/// IPC input used to save a profile and its password.
///
/// This type is deliberately deserialize-only so credentials cannot be sent back to the
/// frontend or serialized into persistence by accident.
#[derive(Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SaveConnectionInput {
    /// Non-secret connection profile.
    pub profile: ConnectionProfile,
    /// Password that must be transferred directly to secure storage.
    #[ts(type = "string")]
    pub password: SecretString,
}

impl fmt::Debug for SaveConnectionInput {
    /// Formats save input while always redacting the password.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SaveConnectionInput")
            .field("profile", &self.profile)
            .field("password", &"***")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::{ConnectionProfile, Engine, Environment, SaveConnectionInput, TlsMode};
    use serde_json::json;
    use ts_rs::{Config, TS};
    use uuid::Uuid;

    /// Verifies stable snake_case engine JSON and TypeScript values.
    #[test]
    fn engine_uses_snake_case_contracts() {
        assert_eq!(
            serde_json::to_value(Engine::MySql).unwrap(),
            json!("my_sql")
        );
        assert!(Engine::decl(&Config::default()).contains("\"my_sql\""));
    }

    /// Verifies that profile fields serialize in camelCase.
    #[test]
    fn connection_profile_uses_camel_case_json() {
        let profile = ConnectionProfile {
            id: Uuid::nil(),
            name: "Local".into(),
            engine: Engine::MySql,
            environment: Environment::Development,
            host: "127.0.0.1".into(),
            port: 3306,
            username: "developer".into(),
            database: Some("pipa".into()),
            tls_mode: TlsMode::Preferred,
        };

        assert_eq!(
            serde_json::to_value(profile).unwrap(),
            json!({
                "id": "00000000-0000-0000-0000-000000000000",
                "name": "Local",
                "engine": "my_sql",
                "environment": "development",
                "host": "127.0.0.1",
                "port": 3306,
                "username": "developer",
                "database": "pipa",
                "tlsMode": "preferred"
            })
        );
    }

    /// Verifies that secret-bearing input accepts IPC JSON and redacts Debug output.
    #[test]
    fn save_connection_input_redacts_password_in_debug() {
        let input: SaveConnectionInput = serde_json::from_value(json!({
            "profile": {
                "id": "00000000-0000-0000-0000-000000000000",
                "name": "Local",
                "engine": "my_sql",
                "environment": "unspecified",
                "host": "localhost",
                "port": 3306,
                "username": "root",
                "database": null,
                "tlsMode": "disabled"
            },
            "password": "do-not-log"
        }))
        .unwrap();

        let debug = format!("{input:?}");
        assert!(debug.contains("password: \"***\""));
        assert!(!debug.contains("do-not-log"));
    }
}
