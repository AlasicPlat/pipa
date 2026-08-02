use crate::{storage_error, LocalStore};
use chrono::{SecondsFormat, Utc};
use pipa_core::{AppError, AppErrorCode, Engine};
use rusqlite::{params, types::Type, Error as SqlError, OptionalExtension, Row};
use std::io;
use uuid::Uuid;

/// One user-managed directory scoped to a database engine.
#[derive(Clone, Debug)]
pub struct SqlFolder {
    /// Stable directory identifier.
    pub id: Uuid,
    /// Database engine whose statements can use this directory.
    pub engine: Engine,
    /// User-visible directory name.
    pub name: String,
    /// UTC timestamp of the latest persisted change.
    pub updated_at: String,
}

/// One reusable query or native database command.
#[derive(Clone, Debug)]
pub struct CommonSql {
    /// Stable statement identifier.
    pub id: Uuid,
    /// Database engine required by the statement.
    pub engine: Engine,
    /// Optional containing directory; `None` represents the uncategorized collection.
    pub folder_id: Option<Uuid>,
    /// User-visible statement name.
    pub name: String,
    /// Exact reusable SQL or native command text.
    pub sql_text: String,
    /// UTC timestamp of the latest persisted change.
    pub updated_at: String,
}

/// Complete reusable SQL collection for one database engine.
#[derive(Clone, Debug)]
pub struct SqlLibrary {
    /// Directories ordered by their user-visible names.
    pub folders: Vec<SqlFolder>,
    /// Statements ordered by newest update first.
    pub entries: Vec<CommonSql>,
}

impl LocalStore {
    /// Loads directories and reusable statements for exactly one database engine.
    pub fn load_sql_library(&self, engine: Engine) -> Result<SqlLibrary, AppError> {
        let connection = self.connection()?;
        let persisted_engine = engine_name(engine);
        let mut folder_statement = connection
            .prepare(
                "SELECT id, engine, name, updated_at
                 FROM sql_folders
                 WHERE engine = ?1
                 ORDER BY name COLLATE NOCASE ASC, id ASC",
            )
            .map_err(|error| {
                storage_error(
                    "Could not load common SQL directories",
                    "prepare common SQL directory query",
                    error,
                )
            })?;
        let folders = folder_statement
            .query_map([persisted_engine], sql_folder_from_row)
            .and_then(Iterator::collect)
            .map_err(|error| {
                storage_error(
                    "Could not load common SQL directories",
                    "read common SQL directories",
                    error,
                )
            })?;
        let mut entry_statement = connection
            .prepare(
                "SELECT id, engine, folder_id, name, sql_text, updated_at
                 FROM common_sql
                 WHERE engine = ?1
                 ORDER BY updated_at DESC, name COLLATE NOCASE ASC, id ASC",
            )
            .map_err(|error| {
                storage_error(
                    "Could not load common SQL",
                    "prepare common SQL query",
                    error,
                )
            })?;
        let entries = entry_statement
            .query_map([persisted_engine], common_sql_from_row)
            .and_then(Iterator::collect)
            .map_err(|error| {
                storage_error(
                    "Could not load common SQL",
                    "read common SQL entries",
                    error,
                )
            })?;

        Ok(SqlLibrary { folders, entries })
    }

    /// Idempotently creates or renames one engine-scoped directory.
    pub fn save_sql_folder(
        &self,
        id: Uuid,
        engine: Engine,
        name: &str,
    ) -> Result<SqlFolder, AppError> {
        let connection = self.connection()?;
        let persisted_engine = engine_name(engine);
        let existing_engine = connection
            .query_row(
                "SELECT engine FROM sql_folders WHERE id = ?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| {
                storage_error(
                    "Could not save common SQL directory",
                    "read existing common SQL directory",
                    error,
                )
            })?;
        if existing_engine
            .as_deref()
            .is_some_and(|value| value != persisted_engine)
        {
            return Err(validation_error(
                "A common SQL directory cannot change database type",
            ));
        }
        let duplicate_id = connection
            .query_row(
                "SELECT id
                 FROM sql_folders
                 WHERE engine = ?1 AND name = ?2 COLLATE NOCASE AND id <> ?3",
                params![persisted_engine, name, id],
                |row| row.get::<_, Uuid>(0),
            )
            .optional()
            .map_err(|error| {
                storage_error(
                    "Could not save common SQL directory",
                    "check common SQL directory name",
                    error,
                )
            })?;
        if duplicate_id.is_some() {
            return Err(validation_error(
                "A common SQL directory with this name already exists",
            ));
        }

        let updated_at = current_timestamp();
        connection
            .execute(
                "INSERT INTO sql_folders (id, engine, name, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   updated_at = excluded.updated_at",
                params![id, persisted_engine, name, updated_at],
            )
            .map_err(|error| {
                storage_error(
                    "Could not save common SQL directory",
                    "upsert common SQL directory",
                    error,
                )
            })?;

        Ok(SqlFolder {
            id,
            engine,
            name: name.into(),
            updated_at,
        })
    }

    /// Idempotently deletes one directory while retaining its statements as uncategorized.
    pub fn delete_sql_folder(&self, id: Uuid) -> Result<(), AppError> {
        self.connection()?
            .execute("DELETE FROM sql_folders WHERE id = ?1", [id])
            .map(|_| ())
            .map_err(|error| {
                storage_error(
                    "Could not delete common SQL directory",
                    "delete common SQL directory",
                    error,
                )
            })
    }

    /// Idempotently creates or updates one reusable statement without changing its engine.
    pub fn save_common_sql(
        &self,
        id: Uuid,
        engine: Engine,
        folder_id: Option<Uuid>,
        name: &str,
        sql_text: &str,
    ) -> Result<CommonSql, AppError> {
        let connection = self.connection()?;
        let persisted_engine = engine_name(engine);
        let existing_engine = connection
            .query_row("SELECT engine FROM common_sql WHERE id = ?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(|error| {
                storage_error(
                    "Could not save common SQL",
                    "read existing common SQL entry",
                    error,
                )
            })?;
        if existing_engine
            .as_deref()
            .is_some_and(|value| value != persisted_engine)
        {
            return Err(validation_error(
                "A common SQL entry cannot change database type",
            ));
        }
        if let Some(folder_id) = folder_id {
            let folder_engine = connection
                .query_row(
                    "SELECT engine FROM sql_folders WHERE id = ?1",
                    [folder_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| {
                    storage_error(
                        "Could not save common SQL",
                        "read target common SQL directory",
                        error,
                    )
                })?;
            match folder_engine.as_deref() {
                None => return Err(not_found_error("Common SQL directory was not found")),
                Some(value) if value != persisted_engine => {
                    return Err(validation_error(
                        "Common SQL and its directory must use the same database type",
                    ));
                }
                Some(_) => {}
            }
        }

        let updated_at = current_timestamp();
        connection
            .execute(
                "INSERT INTO common_sql (id, engine, folder_id, name, sql_text, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                   folder_id = excluded.folder_id,
                   name = excluded.name,
                   sql_text = excluded.sql_text,
                   updated_at = excluded.updated_at",
                params![id, persisted_engine, folder_id, name, sql_text, updated_at],
            )
            .map_err(|error| {
                storage_error(
                    "Could not save common SQL",
                    "upsert common SQL entry",
                    error,
                )
            })?;

        Ok(CommonSql {
            id,
            engine,
            folder_id,
            name: name.into(),
            sql_text: sql_text.into(),
            updated_at,
        })
    }

    /// Idempotently deletes one reusable statement.
    pub fn delete_common_sql(&self, id: Uuid) -> Result<(), AppError> {
        self.connection()?
            .execute("DELETE FROM common_sql WHERE id = ?1", [id])
            .map(|_| ())
            .map_err(|error| {
                storage_error(
                    "Could not delete common SQL",
                    "delete common SQL entry",
                    error,
                )
            })
    }
}

/// Maps one directory row and rejects unknown persisted engine values.
fn sql_folder_from_row(row: &Row<'_>) -> rusqlite::Result<SqlFolder> {
    Ok(SqlFolder {
        id: row.get(0)?,
        engine: parse_engine(row.get::<_, String>(1)?)
            .map_err(|value| invalid_engine_error(1, value))?,
        name: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

/// Maps one reusable statement row and rejects unknown persisted engine values.
fn common_sql_from_row(row: &Row<'_>) -> rusqlite::Result<CommonSql> {
    Ok(CommonSql {
        id: row.get(0)?,
        engine: parse_engine(row.get::<_, String>(1)?)
            .map_err(|value| invalid_engine_error(1, value))?,
        folder_id: row.get(2)?,
        name: row.get(3)?,
        sql_text: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

/// Returns the stable persistence value for a database engine.
fn engine_name(engine: Engine) -> &'static str {
    match engine {
        Engine::MySql => "my_sql",
        Engine::PostgreSql => "postgre_sql",
        Engine::MongoDb => "mongo_db",
        Engine::Redis => "redis",
    }
}

/// Parses one persisted engine value without silently accepting schema drift.
fn parse_engine(value: String) -> Result<Engine, String> {
    match value.as_str() {
        "my_sql" => Ok(Engine::MySql),
        "postgre_sql" => Ok(Engine::PostgreSql),
        "mongo_db" => Ok(Engine::MongoDb),
        "redis" => Ok(Engine::Redis),
        _ => Err(value),
    }
}

/// Converts an invalid persisted engine into a typed rusqlite conversion error.
fn invalid_engine_error(index: usize, value: String) -> SqlError {
    SqlError::FromSqlConversionFailure(
        index,
        Type::Text,
        Box::new(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid database engine: {value}"),
        )),
    )
}

/// Produces one sortable RFC 3339 UTC timestamp for every mutation.
fn current_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true)
}

/// Builds a safe validation failure without including user SQL text.
fn validation_error(message: &'static str) -> AppError {
    AppError {
        code: AppErrorCode::Validation,
        message: message.into(),
        technical_details: None,
        retryable: false,
    }
}

/// Builds a safe not-found failure for a referenced library object.
fn not_found_error(message: &'static str) -> AppError {
    AppError {
        code: AppErrorCode::NotFound,
        message: message.into(),
        technical_details: None,
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Opens a temporary encrypted store retained for one repository test.
    fn test_store() -> (TempDir, LocalStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalStore::open(directory.path().join("pipa.db"), "sql-library-key").unwrap();
        (directory, store)
    }

    /// Verifies engine isolation, idempotent updates, and safe directory deletion.
    #[test]
    fn sql_library_is_isolated_by_engine_and_retains_uncategorized_entries() {
        let (_directory, store) = test_store();
        let mysql_folder_id = Uuid::new_v4();
        let redis_folder_id = Uuid::new_v4();
        let mysql_entry_id = Uuid::new_v4();
        store
            .save_sql_folder(mysql_folder_id, Engine::MySql, "Reporting")
            .unwrap();
        store
            .save_sql_folder(redis_folder_id, Engine::Redis, "Cache checks")
            .unwrap();
        store
            .save_common_sql(
                mysql_entry_id,
                Engine::MySql,
                Some(mysql_folder_id),
                "Daily orders",
                "SELECT * FROM orders;",
            )
            .unwrap();
        store
            .save_common_sql(
                mysql_entry_id,
                Engine::MySql,
                Some(mysql_folder_id),
                "Daily paid orders",
                "SELECT * FROM orders WHERE paid = 1;",
            )
            .unwrap();
        store
            .save_common_sql(
                Uuid::new_v4(),
                Engine::Redis,
                Some(redis_folder_id),
                "Server info",
                "INFO",
            )
            .unwrap();

        let mysql_library = store.load_sql_library(Engine::MySql).unwrap();
        assert_eq!(mysql_library.folders.len(), 1);
        assert_eq!(mysql_library.entries.len(), 1);
        assert_eq!(mysql_library.entries[0].name, "Daily paid orders");
        assert!(matches!(mysql_library.entries[0].engine, Engine::MySql));
        assert_eq!(
            store.load_sql_library(Engine::Redis).unwrap().entries.len(),
            1
        );

        store.delete_sql_folder(mysql_folder_id).unwrap();
        store.delete_sql_folder(mysql_folder_id).unwrap();
        let retained = store.load_sql_library(Engine::MySql).unwrap();
        assert!(retained.folders.is_empty());
        assert_eq!(retained.entries[0].folder_id, None);
    }

    /// Verifies a statement cannot cross the engine boundary of its target directory.
    #[test]
    fn common_sql_rejects_a_directory_from_another_engine() {
        let (_directory, store) = test_store();
        let folder_id = Uuid::new_v4();
        store
            .save_sql_folder(folder_id, Engine::Redis, "Redis only")
            .unwrap();

        let error = store
            .save_common_sql(
                Uuid::new_v4(),
                Engine::MySql,
                Some(folder_id),
                "Invalid",
                "SELECT 1;",
            )
            .unwrap_err();

        assert!(matches!(error.code, AppErrorCode::Validation));
        assert!(store
            .load_sql_library(Engine::MySql)
            .unwrap()
            .entries
            .is_empty());
    }
}
