//! MCP tool surface: readonly query helpers and write proposals.

use pipa_core::{classify_sql, ConnectionProfile, Engine, SqlRisk};
use pipa_mysql::MySqlAdapter;
use pipa_store::{LocalStore, McpSettings};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use super::{
    query_runner::{execute_readonly_mcp, quote_ident},
    queue::McpQueue,
};

/// Runtime MCP connection visibility and authorization boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct McpConnectionScope {
    /// Whether tools may access only the selected target connection.
    pub restrict_to_connection: bool,
    /// Connection retained as the target even while restriction is disabled.
    pub target_connection_id: Option<Uuid>,
}

impl McpConnectionScope {
    /// Builds the runtime scope from persisted MCP settings.
    pub fn from_settings(settings: &McpSettings) -> Self {
        Self {
            restrict_to_connection: settings.restrict_to_connection,
            target_connection_id: settings.target_connection_id,
        }
    }

    /// Returns whether one saved connection is available to MCP tools.
    pub fn allows(self, connection_id: Uuid) -> bool {
        !self.restrict_to_connection || self.target_connection_id == Some(connection_id)
    }
}

/// Shared scope read by every live MCP session.
pub type SharedMcpConnectionScope = Arc<RwLock<McpConnectionScope>>;

/// Creates shared runtime scope seeded from persisted settings.
pub fn shared_connection_scope(settings: &McpSettings) -> SharedMcpConnectionScope {
    Arc::new(RwLock::new(McpConnectionScope::from_settings(settings)))
}

/// Shared dependencies cloned into each MCP session service.
#[derive(Clone)]
pub struct McpDeps {
    /// Encrypted local store.
    pub local_store: Arc<LocalStore>,
    /// MySQL adapter.
    pub mysql: Arc<MySqlAdapter>,
    /// Proposal / activity queue.
    pub queue: McpQueue,
    /// Live connection visibility and authorization boundary.
    pub connection_scope: SharedMcpConnectionScope,
}

/// Per-session MCP server handler.
#[derive(Clone)]
pub struct PipaMcpService {
    deps: McpDeps,
    tool_router: ToolRouter<Self>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ListTablesArgs {
    /// Saved Pipa connection id (UUID string).
    #[schemars(description = "Saved Pipa connection UUID")]
    connection_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DescribeTableArgs {
    /// Saved Pipa connection id (UUID string).
    #[schemars(description = "Saved Pipa connection UUID")]
    connection_id: String,
    /// Table name to describe.
    #[schemars(description = "MySQL table name")]
    table_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RunReadonlyQueryArgs {
    /// Saved Pipa connection id (UUID string).
    #[schemars(description = "Saved Pipa connection UUID")]
    connection_id: String,
    /// Read-only SQL (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH…SELECT).
    #[schemars(description = "Read-only SQL statement")]
    sql: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ProposeSqlArgs {
    /// Saved Pipa connection id (UUID string).
    #[schemars(description = "Saved Pipa connection UUID")]
    connection_id: String,
    /// SQL to stage for user confirmation (typically DML/DDL).
    #[schemars(description = "SQL to propose for manual confirmation in Pipa")]
    sql: String,
}

#[tool_router(router = tool_router)]
impl PipaMcpService {
    /// Creates a session service bound to shared application dependencies.
    pub fn new(deps: McpDeps) -> Self {
        Self {
            deps,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        name = "list_connections",
        description = "List saved non-secret database connections available in Pipa (id, name, engine, host, database, environment)."
    )]
    async fn list_connections(&self) -> Result<CallToolResult, McpError> {
        let profiles = self.available_connections().await?;
        let payload: Vec<_> = profiles
            .into_iter()
            .filter_map(|profile| serde_json::to_value(profile).ok())
            .collect();
        let summary = format!("listed {} connection(s)", payload.len());
        self.deps
            .queue
            .push_activity("list_connections", None, &summary, true, None)
            .await;
        ok_json(json!({ "connections": payload }))
    }

    #[tool(
        name = "list_tables",
        description = "List tables for a MySQL connection using SHOW FULL TABLES (read-only)."
    )]
    async fn list_tables(
        &self,
        Parameters(args): Parameters<ListTablesArgs>,
    ) -> Result<CallToolResult, McpError> {
        let connection_id = parse_uuid(&args.connection_id)?;
        self.require_mysql(connection_id).await?;
        let result = execute_readonly_mcp(
            self.deps.local_store.clone(),
            self.deps.mysql.clone(),
            connection_id,
            "SHOW FULL TABLES",
        )
        .await
        .map_err(|error| tool_error(error.message))?;
        let ok = result.error.is_none();
        self.deps
            .queue
            .push_activity(
                "list_tables",
                Some(connection_id),
                "SHOW FULL TABLES",
                ok,
                Some(result.short_detail()),
            )
            .await; // summary is &str
        if let Some(error) = result.error {
            return Err(tool_error(error));
        }
        ok_json(result.to_summary_json())
    }

    #[tool(
        name = "describe_table",
        description = "Describe a MySQL table structure with DESCRIBE (read-only)."
    )]
    async fn describe_table(
        &self,
        Parameters(args): Parameters<DescribeTableArgs>,
    ) -> Result<CallToolResult, McpError> {
        let connection_id = parse_uuid(&args.connection_id)?;
        self.require_mysql(connection_id).await?;
        let table = args.table_name.trim();
        if table.is_empty() {
            return Err(tool_error("table_name must not be empty"));
        }
        let sql = format!("DESCRIBE {}", quote_ident(table));
        let result = execute_readonly_mcp(
            self.deps.local_store.clone(),
            self.deps.mysql.clone(),
            connection_id,
            &sql,
        )
        .await
        .map_err(|error| tool_error(error.message))?;
        let ok = result.error.is_none();
        self.deps
            .queue
            .push_activity(
                "describe_table",
                Some(connection_id),
                &sql,
                ok,
                Some(result.short_detail()),
            )
            .await;
        if let Some(error) = result.error {
            return Err(tool_error(error));
        }
        ok_json(result.to_summary_json())
    }

    #[tool(
        name = "run_readonly_query",
        description = "Execute a strictly read-only SQL statement (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH…SELECT). Write/DDL SQL is rejected; use propose_sql instead."
    )]
    async fn run_readonly_query(
        &self,
        Parameters(args): Parameters<RunReadonlyQueryArgs>,
    ) -> Result<CallToolResult, McpError> {
        let connection_id = parse_uuid(&args.connection_id)?;
        self.require_mysql(connection_id).await?;
        let sql = args.sql.trim();
        if sql.is_empty() {
            return Err(tool_error("sql must not be empty"));
        }
        let risk = classify_sql(sql);
        if risk != SqlRisk::Read {
            let proposal = self
                .deps
                .queue
                .propose(connection_id, sql.to_owned(), risk, "run_readonly_query")
                .await
                .map_err(|error| tool_error(error.message))?;
            return ok_json(json!({
                "ok": false,
                "queuedForConfirmation": true,
                "proposalId": proposal.id,
                "risk": format!("{risk:?}").to_ascii_lowercase(),
                "message": "SQL is not read-only. It was queued in the Pipa MCP panel for manual confirmation; nothing was executed.",
            }));
        }

        let result = execute_readonly_mcp(
            self.deps.local_store.clone(),
            self.deps.mysql.clone(),
            connection_id,
            sql,
        )
        .await
        .map_err(|error| tool_error(error.message))?;
        let ok = result.error.is_none();
        self.deps
            .queue
            .push_activity(
                "run_readonly_query",
                Some(connection_id),
                sql,
                ok,
                Some(result.short_detail()),
            )
            .await;
        if let Some(error) = result.error {
            return Err(tool_error(error));
        }
        ok_json(result.to_summary_json())
    }

    #[tool(
        name = "propose_sql",
        description = "Stage SQL (especially DML/DDL) for user confirmation in the Pipa MCP panel. Never executes the statement."
    )]
    async fn propose_sql(
        &self,
        Parameters(args): Parameters<ProposeSqlArgs>,
    ) -> Result<CallToolResult, McpError> {
        let connection_id = parse_uuid(&args.connection_id)?;
        self.require_mysql(connection_id).await?;
        let sql = args.sql.trim();
        if sql.is_empty() {
            return Err(tool_error("sql must not be empty"));
        }
        let risk = classify_sql(sql);
        let proposal = self
            .deps
            .queue
            .propose(connection_id, sql.to_owned(), risk, "propose_sql")
            .await
            .map_err(|error| tool_error(error.message))?;
        ok_json(json!({
            "ok": true,
            "executed": false,
            "proposalId": proposal.id,
            "risk": format!("{risk:?}").to_ascii_lowercase(),
            "message": "SQL was queued in the Pipa MCP panel. Ask the user to open MCP and confirm before execution.",
        }))
    }

    /// Lists profiles visible under the current runtime scope.
    async fn available_connections(&self) -> Result<Vec<ConnectionProfile>, McpError> {
        let profiles = self
            .deps
            .local_store
            .list_connections()
            .map_err(|error| tool_error(error.message))?;
        let scope = *self.deps.connection_scope.read().await;
        if !scope.restrict_to_connection {
            return Ok(profiles);
        }
        Ok(profiles
            .into_iter()
            .filter(|profile| scope.target_connection_id == Some(profile.id))
            .collect())
    }

    /// Loads one MySQL profile only when it is inside the current MCP scope.
    async fn require_mysql(&self, connection_id: Uuid) -> Result<ConnectionProfile, McpError> {
        let scope = *self.deps.connection_scope.read().await;
        if !scope.allows(connection_id) {
            return Err(tool_error(
                "Database connection is outside the configured MCP scope",
            ));
        }
        let profile = self
            .deps
            .local_store
            .get_connection(connection_id)
            .map_err(|error| tool_error(error.message))?;
        if !matches!(profile.engine, Engine::MySql) {
            return Err(tool_error(
                "Only MySQL connections are supported by MCP tools in this version",
            ));
        }
        Ok(profile)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for PipaMcpService {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder().enable_tools().build(),
        )
        .with_instructions(
            "Pipa database MCP server. Read-only SQL may run automatically. DML/DDL must use propose_sql and be confirmed manually in the Pipa MCP panel.",
        )
    }
}

fn parse_uuid(value: &str) -> Result<Uuid, McpError> {
    Uuid::parse_str(value.trim()).map_err(|_| tool_error("connection_id must be a valid UUID"))
}

fn tool_error(message: impl Into<String>) -> McpError {
    McpError::invalid_params(message.into(), None)
}

fn ok_json(value: serde_json::Value) -> Result<CallToolResult, McpError> {
    let text = serde_json::to_string_pretty(&value)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

#[cfg(test)]
mod tests {
    use super::{shared_connection_scope, McpConnectionScope, McpDeps, PipaMcpService};
    use crate::mcp::McpQueue;
    use pipa_core::{ConnectionProfile, Engine, Environment, TlsMode};
    use pipa_mysql::MySqlAdapter;
    use pipa_store::{LocalStore, McpSettings};
    use secrecy::SecretString;
    use std::sync::Arc;
    use uuid::Uuid;

    /// Creates one saved profile with a stable engine-specific port.
    fn profile(name: &str, engine: Engine) -> ConnectionProfile {
        ConnectionProfile {
            id: Uuid::new_v4(),
            name: name.into(),
            engine,
            environment: Environment::Development,
            host: "127.0.0.1".into(),
            port: if matches!(engine, Engine::Redis) {
                6379
            } else {
                3306
            },
            username: "developer".into(),
            database: Some("pipa".into()),
            tls_mode: TlsMode::Preferred,
        }
    }

    /// Builds an isolated service and retains its temporary encrypted store.
    fn test_service(
        profiles: &[ConnectionProfile],
        settings: &McpSettings,
    ) -> (tempfile::TempDir, PipaMcpService) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalStore::open(directory.path().join("pipa.db"), "test-key").unwrap();
        for profile in profiles {
            store
                .save_connection_with_credential(profile, &SecretString::from("password"))
                .unwrap();
        }
        let service = PipaMcpService::new(McpDeps {
            local_store: Arc::new(store),
            mysql: Arc::new(MySqlAdapter::new()),
            queue: McpQueue::new(),
            connection_scope: shared_connection_scope(settings),
        });
        (directory, service)
    }

    /// Verifies unrestricted mode preserves all profiles and their engine markers.
    #[tokio::test]
    async fn unrestricted_scope_lists_every_connection_with_engine_metadata() {
        let mysql = profile("Shared name", Engine::MySql);
        let redis = profile("Shared name", Engine::Redis);
        let (_directory, service) =
            test_service(&[mysql.clone(), redis.clone()], &McpSettings::default());

        let profiles = service.available_connections().await.unwrap();

        assert_eq!(profiles.len(), 2);
        assert!(profiles
            .iter()
            .any(|profile| matches!(profile.engine, Engine::MySql)));
        assert!(profiles
            .iter()
            .any(|profile| matches!(profile.engine, Engine::Redis)));
        assert!(serde_json::to_value(&profiles[0]).unwrap()["engine"]
            .as_str()
            .is_some());
    }

    /// Verifies restricted mode lists and authorizes only the selected target.
    #[tokio::test]
    async fn restricted_scope_hides_and_rejects_other_connections() {
        let selected = profile("Selected", Engine::MySql);
        let other = profile("Other", Engine::MySql);
        let settings = McpSettings {
            restrict_to_connection: true,
            target_connection_id: Some(selected.id),
            ..McpSettings::default()
        };
        let (_directory, service) = test_service(&[selected.clone(), other.clone()], &settings);

        let profiles = service.available_connections().await.unwrap();

        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, selected.id);
        assert_eq!(
            service.require_mysql(selected.id).await.unwrap().id,
            selected.id
        );
        let error = service.require_mysql(other.id).await.unwrap_err();
        assert!(error.message.contains("outside the configured MCP scope"));
    }

    /// Verifies live scope updates affect existing service sessions without restart.
    #[tokio::test]
    async fn live_scope_update_applies_without_recreating_service() {
        let selected = profile("Selected", Engine::MySql);
        let other = profile("Other", Engine::MySql);
        let (_directory, service) =
            test_service(&[selected.clone(), other.clone()], &McpSettings::default());
        {
            let mut scope = service.deps.connection_scope.write().await;
            *scope = McpConnectionScope {
                restrict_to_connection: true,
                target_connection_id: Some(other.id),
            };
        }

        let profiles = service.available_connections().await.unwrap();

        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, other.id);
    }
}
