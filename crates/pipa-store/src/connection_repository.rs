use crate::{storage_error, LocalStore};
use chrono::{SecondsFormat, Utc};
use pipa_core::{AppError, ConnectionProfile, Engine, Environment, TlsMode};
use rusqlite::{params, types::Type, Error as SqlError};
use std::io;

impl LocalStore {
    /// Inserts or updates a non-secret connection profile.
    pub fn save_connection(&self, profile: &ConnectionProfile) -> Result<(), AppError> {
        self.connection()?
            .execute(
                "INSERT INTO connections (
                   id, engine, name, environment, host, port, username, database_name, tls_mode,
                   updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                   engine = excluded.engine,
                   name = excluded.name,
                   environment = excluded.environment,
                   host = excluded.host,
                   port = excluded.port,
                   username = excluded.username,
                   database_name = excluded.database_name,
                   tls_mode = excluded.tls_mode,
                   updated_at = excluded.updated_at",
                params![
                    profile.id,
                    engine_name(profile.engine),
                    profile.name,
                    environment_name(profile.environment),
                    profile.host,
                    profile.port,
                    profile.username,
                    profile.database,
                    tls_mode_name(profile.tls_mode),
                    Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true),
                ],
            )
            .map(|_| ())
            .map_err(|error| {
                storage_error(
                    "Could not save database connection",
                    "upsert connection profile",
                    error,
                )
            })
    }

    /// Lists all saved non-secret connection profiles in deterministic name order.
    pub fn list_connections(&self) -> Result<Vec<ConnectionProfile>, AppError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT id, engine, name, environment, host, port, username, database_name,
                        tls_mode
                 FROM connections
                 ORDER BY name COLLATE NOCASE ASC, id ASC",
            )
            .map_err(|error| {
                storage_error(
                    "Could not list database connections",
                    "prepare connection query",
                    error,
                )
            })?;
        let profiles = statement
            .query_map([], |row| {
                Ok(ConnectionProfile {
                    id: row.get(0)?,
                    engine: parse_engine(row.get::<_, String>(1)?)
                        .map_err(|value| invalid_value_error(1, "engine", value))?,
                    name: row.get(2)?,
                    environment: parse_environment(row.get::<_, String>(3)?)
                        .map_err(|value| invalid_value_error(3, "environment", value))?,
                    host: row.get(4)?,
                    port: row.get(5)?,
                    username: row.get(6)?,
                    database: row.get(7)?,
                    tls_mode: parse_tls_mode(row.get::<_, String>(8)?)
                        .map_err(|value| invalid_value_error(8, "TLS mode", value))?,
                })
            })
            .and_then(Iterator::collect)
            .map_err(|error| {
                storage_error(
                    "Could not list database connections",
                    "read connection profiles",
                    error,
                )
            })?;

        Ok(profiles)
    }
}

/// Returns the stable persistence value for an engine.
fn engine_name(engine: Engine) -> &'static str {
    match engine {
        Engine::MySql => "my_sql",
        Engine::PostgreSql => "postgre_sql",
        Engine::MongoDb => "mongo_db",
        Engine::Redis => "redis",
    }
}

/// Parses an engine persistence value while preserving the invalid input for diagnostics.
fn parse_engine(value: String) -> Result<Engine, String> {
    match value.as_str() {
        "my_sql" => Ok(Engine::MySql),
        "postgre_sql" => Ok(Engine::PostgreSql),
        "mongo_db" => Ok(Engine::MongoDb),
        "redis" => Ok(Engine::Redis),
        _ => Err(value),
    }
}

/// Returns the stable persistence value for an environment.
fn environment_name(environment: Environment) -> &'static str {
    match environment {
        Environment::Production => "production",
        Environment::Development => "development",
        Environment::Unspecified => "unspecified",
    }
}

/// Parses an environment persistence value while preserving invalid input for diagnostics.
fn parse_environment(value: String) -> Result<Environment, String> {
    match value.as_str() {
        "production" => Ok(Environment::Production),
        "development" => Ok(Environment::Development),
        "unspecified" => Ok(Environment::Unspecified),
        _ => Err(value),
    }
}

/// Returns the stable persistence value for a TLS policy.
fn tls_mode_name(tls_mode: TlsMode) -> &'static str {
    match tls_mode {
        TlsMode::Disabled => "disabled",
        TlsMode::Preferred => "preferred",
        TlsMode::Required => "required",
    }
}

/// Parses a TLS persistence value while preserving invalid input for diagnostics.
fn parse_tls_mode(value: String) -> Result<TlsMode, String> {
    match value.as_str() {
        "disabled" => Ok(TlsMode::Disabled),
        "preferred" => Ok(TlsMode::Preferred),
        "required" => Ok(TlsMode::Required),
        _ => Err(value),
    }
}

/// Builds a SQLite conversion error for an invalid persisted enum value.
fn invalid_value_error(column: usize, name: &'static str, value: String) -> SqlError {
    SqlError::FromSqlConversionFailure(
        column,
        Type::Text,
        Box::new(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid {name} value: {value}"),
        )),
    )
}
