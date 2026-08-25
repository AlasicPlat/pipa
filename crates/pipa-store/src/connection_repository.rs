use crate::{storage_error, LocalStore};
use chrono::{SecondsFormat, Utc};
use pipa_core::{AppError, AppErrorCode, ConnectionProfile, Engine, Environment, TlsMode};
use rusqlite::{params, types::Type, Connection, Error as SqlError, Row};
use secrecy::{ExposeSecret, SecretString};
use std::io;
use uuid::Uuid;

impl LocalStore {
    /// Atomically inserts or updates a connection profile and its SQLCipher-encrypted credential.
    pub fn save_connection_with_credential(
        &self,
        profile: &ConnectionProfile,
        password: &SecretString,
    ) -> Result<(), AppError> {
        let mut connection = self.connection()?;
        let result = (|| -> rusqlite::Result<()> {
            let transaction = connection.transaction()?;
            upsert_connection(&transaction, profile)?;
            transaction.execute(
                "INSERT INTO connection_credentials (connection_id, password)
                 VALUES (?1, ?2)
                 ON CONFLICT(connection_id) DO UPDATE SET password = excluded.password",
                params![profile.id, password.expose_secret()],
            )?;
            transaction.commit()
        })();

        result.map_err(|error| {
            storage_error(
                "Could not save database connection",
                "upsert connection profile and credential transaction",
                error,
            )
        })
    }

    /// Atomically removes a connection, its credential, workspace tabs, and query history.
    pub fn delete_connection(&self, connection_id: Uuid) -> Result<(), AppError> {
        let mut connection = self.connection()?;
        let result = (|| -> rusqlite::Result<()> {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM workspace_tabs WHERE connection_id = ?1",
                [connection_id],
            )?;
            transaction.execute(
                "DELETE FROM query_history WHERE connection_id = ?1",
                [connection_id],
            )?;
            transaction.execute("DELETE FROM connections WHERE id = ?1", [connection_id])?;
            transaction.commit()
        })();

        result.map_err(|error| {
            storage_error(
                "Could not delete database connection",
                "delete connection and related local data transaction",
                error,
            )
        })
    }

    /// Renames one saved connection without reading or replacing its encrypted credential.
    pub fn rename_connection(
        &self,
        connection_id: Uuid,
        name: &str,
    ) -> Result<ConnectionProfile, AppError> {
        let mut connection = self.connection()?;
        let result = (|| -> rusqlite::Result<Option<ConnectionProfile>> {
            let transaction = connection.transaction()?;
            let changed = transaction.execute(
                "UPDATE connections SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![
                    name,
                    Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true),
                    connection_id
                ],
            )?;
            let profile = if changed == 0 {
                None
            } else {
                Some(transaction.query_row(
                    "SELECT id, engine, name, environment, host, port, username, database_name,
                            tls_mode
                     FROM connections
                     WHERE id = ?1",
                    [connection_id],
                    connection_profile_from_row,
                )?)
            };
            transaction.commit()?;
            Ok(profile)
        })()
        .map_err(|error| {
            storage_error(
                "Could not rename database connection",
                "rename connection profile transaction",
                error,
            )
        })?;

        result.ok_or_else(connection_not_found_error)
    }

    /// Updates one saved connection's non-secret fields without touching its credential.
    ///
    /// The engine is deliberately immutable: a saved credential and every open workspace are
    /// bound to it, so switching engines in place would silently reinterpret both. Callers that
    /// need a different engine create a new connection instead.
    pub fn update_connection_profile(
        &self,
        profile: &ConnectionProfile,
    ) -> Result<ConnectionProfile, AppError> {
        let mut connection = self.connection()?;
        let result = (|| -> rusqlite::Result<Option<ConnectionProfile>> {
            let transaction = connection.transaction()?;
            // Matching the engine in the WHERE clause keeps an engine change from being applied
            // silently; it surfaces as a not-found result instead.
            let changed = transaction.execute(
                "UPDATE connections
                 SET name = ?1,
                     environment = ?2,
                     host = ?3,
                     port = ?4,
                     username = ?5,
                     database_name = ?6,
                     tls_mode = ?7,
                     updated_at = ?8
                 WHERE id = ?9 AND engine = ?10",
                params![
                    profile.name,
                    environment_name(profile.environment),
                    profile.host,
                    profile.port,
                    profile.username,
                    profile.database,
                    tls_mode_name(profile.tls_mode),
                    Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true),
                    profile.id,
                    engine_name(profile.engine),
                ],
            )?;
            let updated = if changed == 0 {
                None
            } else {
                Some(transaction.query_row(
                    "SELECT id, engine, name, environment, host, port, username, database_name,
                            tls_mode
                     FROM connections
                     WHERE id = ?1",
                    [profile.id],
                    connection_profile_from_row,
                )?)
            };
            transaction.commit()?;
            Ok(updated)
        })()
        .map_err(|error| {
            storage_error(
                "Could not update database connection",
                "update connection profile transaction",
                error,
            )
        })?;

        result.ok_or_else(connection_not_found_error)
    }

    /// Loads one saved non-secret connection profile by its stable identifier.
    pub fn get_connection(&self, connection_id: Uuid) -> Result<ConnectionProfile, AppError> {
        match self.connection()?.query_row(
            "SELECT id, engine, name, environment, host, port, username, database_name, tls_mode
             FROM connections
             WHERE id = ?1",
            [connection_id],
            connection_profile_from_row,
        ) {
            Ok(profile) => Ok(profile),
            Err(SqlError::QueryReturnedNoRows) => Err(connection_not_found_error()),
            Err(error) => Err(storage_error(
                "Could not read database connection",
                "read connection profile",
                error,
            )),
        }
    }

    /// Loads one database credential from the SQLCipher-encrypted main database.
    pub fn get_connection_credential(&self, connection_id: Uuid) -> Result<SecretString, AppError> {
        match self.connection()?.query_row(
            "SELECT password FROM connection_credentials WHERE connection_id = ?1",
            [connection_id],
            |row| row.get::<_, String>(0),
        ) {
            Ok(password) => Ok(SecretString::from(password)),
            Err(SqlError::QueryReturnedNoRows) => Err(AppError {
                code: AppErrorCode::NotFound,
                message: "Database credential was not found".into(),
                technical_details: None,
                retryable: false,
            }),
            Err(error) => Err(storage_error(
                "Could not read database credential",
                "read encrypted connection credential",
                error,
            )),
        }
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
            .query_map([], connection_profile_from_row)
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

/// Maps one persisted profile row while preserving stable enum validation errors.
fn connection_profile_from_row(row: &Row<'_>) -> rusqlite::Result<ConnectionProfile> {
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
}

/// Builds the stable error returned when a saved connection identifier does not exist.
fn connection_not_found_error() -> AppError {
    AppError {
        code: AppErrorCode::NotFound,
        message: "Database connection was not found".into(),
        technical_details: None,
        retryable: false,
    }
}

/// Inserts or updates one non-secret connection profile on the supplied transaction boundary.
fn upsert_connection(
    connection: &Connection,
    profile: &ConnectionProfile,
) -> rusqlite::Result<usize> {
    connection.execute(
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
