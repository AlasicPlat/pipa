//! MCP tool surface: readonly query helpers and write proposals.

use pipa_binlog::InMemoryAnalysisRepository;
use pipa_core::{classify_sql, AppError, AppErrorCode, ConnectionProfile, Engine, SqlRisk};
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
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    binlog::{
        BinlogCloseArgs, BinlogImportArgs, BinlogResetSqlArgs, BinlogSummaryArgs,
        BinlogTransactionArgs, BinlogTransactionsArgs,
    },
    query_runner::{execute_readonly_mcp, quote_ident},
    queue::McpQueue,
};

/// Runtime MCP connection visibility and authorization boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpConnectionScope {
    /// Whether tools may access only the selected target connections.
    pub restrict_to_connection: bool,
    /// Connections retained as targets even while restriction is disabled.
    pub target_connection_ids: Vec<Uuid>,
}

impl McpConnectionScope {
    /// Builds the runtime scope from persisted MCP settings.
    pub fn from_settings(settings: &McpSettings) -> Self {
        Self {
            restrict_to_connection: settings.restrict_to_connection,
            target_connection_ids: settings.target_connection_ids.clone(),
        }
    }

    /// Returns whether one saved connection is available to MCP tools.
    pub fn allows(&self, connection_id: Uuid) -> bool {
        !self.restrict_to_connection || self.target_connection_ids.contains(&connection_id)
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
    /// Ephemeral Binlog analyses shared by desktop and MCP sessions.
    pub binlog_analyses: Arc<InMemoryAnalysisRepository>,
    /// Cancellation tokens for active desktop or MCP Binlog imports.
    pub binlog_cancellations: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
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

    /// Lists saved non-secret connections visible to the current MCP scope.
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

    /// Lists tables for one authorized MySQL connection.
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

    /// Describes one table on an authorized MySQL connection.
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

    /// Runs a policy-approved readonly query or stages a non-readonly statement.
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

    /// Stages SQL for explicit confirmation without executing it.
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

    /// Starts one connection-independent asynchronous Binlog import.
    #[tool(
        name = "binlog_import",
        description = "Start an asynchronous offline MySQL Binlog analysis from multiple ordered local file_paths or multiple inline Base64 files. Exactly one source mode is required. Inline uploads are limited to 32 files / 64 MiB decoded; use local paths for larger logs. Returns analysisId immediately."
    )]
    async fn binlog_import(
        &self,
        Parameters(args): Parameters<BinlogImportArgs>,
    ) -> Result<CallToolResult, McpError> {
        let source_count = args.file_paths.len().max(args.files.len());
        let result = super::binlog::start_import(&self.deps, args).await;
        self.complete_binlog_tool(
            "binlog_import",
            &format!("requested Binlog import with {source_count} file(s)"),
            result,
        )
        .await
    }

    /// Polls aggregate state for one Binlog analysis.
    #[tool(
        name = "binlog_get_summary",
        description = "Poll one Binlog analysis and return importing/complete/warning/error/partial state, source basenames, counts, table aggregates, and diagnostics."
    )]
    async fn binlog_get_summary(
        &self,
        Parameters(args): Parameters<BinlogSummaryArgs>,
    ) -> Result<CallToolResult, McpError> {
        let summary = format!(
            "read Binlog summary analysis_id={}",
            activity_identifier(&args.analysis_id)
        );
        let result = super::binlog::get_summary(&self.deps, args);
        self.complete_binlog_tool("binlog_get_summary", &summary, result)
            .await
    }

    /// Lists a filtered cursor page of lightweight Binlog transactions.
    #[tool(
        name = "binlog_list_transactions",
        description = "List one cursor-paginated Binlog transaction timeline with optional exact database, table, and insert/update/delete/ddl filters. Row images are loaded separately."
    )]
    async fn binlog_list_transactions(
        &self,
        Parameters(args): Parameters<BinlogTransactionsArgs>,
    ) -> Result<CallToolResult, McpError> {
        let summary = format!(
            "listed Binlog transactions analysis_id={}",
            activity_identifier(&args.analysis_id)
        );
        let result = super::binlog::list_transactions(&self.deps, args);
        self.complete_binlog_tool("binlog_list_transactions", &summary, result)
            .await
    }

    /// Loads decoded row images for one Binlog transaction.
    #[tool(
        name = "binlog_get_transaction",
        description = "Get one Binlog transaction by sequence, including decoded before/after row images and optional exact database, table, and operation projection."
    )]
    async fn binlog_get_transaction(
        &self,
        Parameters(args): Parameters<BinlogTransactionArgs>,
    ) -> Result<CallToolResult, McpError> {
        let summary = format!(
            "read Binlog transaction analysis_id={} sequence={}",
            activity_identifier(&args.analysis_id),
            args.sequence
        );
        let result = super::binlog::get_transaction(&self.deps, args);
        self.complete_binlog_tool("binlog_get_transaction", &summary, result)
            .await
    }

    /// Generates reviewable inverse SQL without executing or proposing it.
    #[tool(
        name = "binlog_get_reset_sql",
        description = "Generate but never execute reviewable MySQL Reset SQL for one committed Binlog transaction. INSERT becomes DELETE, UPDATE restores Before values, DELETE becomes INSERT, and mutations are reversed in transaction order."
    )]
    async fn binlog_get_reset_sql(
        &self,
        Parameters(args): Parameters<BinlogResetSqlArgs>,
    ) -> Result<CallToolResult, McpError> {
        let summary = format!(
            "generated Binlog Reset SQL analysis_id={} sequence={}",
            activity_identifier(&args.analysis_id),
            args.sequence
        );
        let result = super::binlog::get_reset_sql(&self.deps, args);
        self.complete_binlog_tool("binlog_get_reset_sql", &summary, result)
            .await
    }

    /// Cancels and releases one Binlog analysis.
    #[tool(
        name = "binlog_close",
        description = "Idempotently close one Binlog analysis, cancel its parser if still active, and release retained row values."
    )]
    async fn binlog_close(
        &self,
        Parameters(args): Parameters<BinlogCloseArgs>,
    ) -> Result<CallToolResult, McpError> {
        let summary = format!(
            "closed Binlog analysis analysis_id={}",
            activity_identifier(&args.analysis_id)
        );
        let result = super::binlog::close_analysis(&self.deps, args).await;
        self.complete_binlog_tool("binlog_close", &summary, result)
            .await
    }

    /// Logs one Binlog tool outcome without file paths or row values and maps its JSON response.
    async fn complete_binlog_tool(
        &self,
        tool: &str,
        summary: &str,
        result: Result<serde_json::Value, AppError>,
    ) -> Result<CallToolResult, McpError> {
        match result {
            Ok(value) => {
                self.deps
                    .queue
                    .push_activity(tool, None, summary, true, None)
                    .await;
                ok_json(value)
            }
            Err(error) => {
                self.deps
                    .queue
                    .push_activity(tool, None, summary, false, Some(error.message.clone()))
                    .await;
                Err(app_tool_error(error))
            }
        }
    }

    /// Lists profiles visible under the current runtime scope.
    async fn available_connections(&self) -> Result<Vec<ConnectionProfile>, McpError> {
        let profiles = self
            .deps
            .local_store
            .list_connections()
            .map_err(|error| tool_error(error.message))?;
        let scope = self.deps.connection_scope.read().await;
        if !scope.restrict_to_connection {
            return Ok(profiles);
        }
        Ok(profiles
            .into_iter()
            .filter(|profile| scope.allows(profile.id))
            .collect())
    }

    /// Loads one MySQL profile only when it is inside the current MCP scope.
    async fn require_mysql(&self, connection_id: Uuid) -> Result<ConnectionProfile, McpError> {
        let scope = self.deps.connection_scope.read().await;
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
            "Pipa database MCP server. Read-only SQL may run automatically. DML/DDL must use propose_sql and be confirmed manually in the Pipa MCP panel. Offline MySQL Binlog tools accept multiple ordered files, expose transaction timelines, and can generate Reset SQL without executing it.",
        )
    }
}

fn parse_uuid(value: &str) -> Result<Uuid, McpError> {
    Uuid::parse_str(value.trim()).map_err(|_| tool_error("connection_id must be a valid UUID"))
}

fn tool_error(message: impl Into<String>) -> McpError {
    McpError::invalid_params(message.into(), None)
}

/// Maps safe application categories to caller or server MCP errors without technical details.
fn app_tool_error(error: AppError) -> McpError {
    match error.code {
        AppErrorCode::Validation | AppErrorCode::NotFound => {
            McpError::invalid_params(error.message, None)
        }
        _ => McpError::internal_error(error.message, None),
    }
}

/// Bounds and strips control characters from caller-supplied identifiers before activity logging.
fn activity_identifier(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(64)
        .collect()
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
    use pipa_binlog::InMemoryAnalysisRepository;
    use pipa_core::{ConnectionProfile, Engine, Environment, TlsMode};
    use pipa_mysql::MySqlAdapter;
    use pipa_store::{LocalStore, McpSettings};
    use secrecy::SecretString;
    use std::{collections::HashMap, sync::Arc};
    use tokio::sync::Mutex;
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
            binlog_analyses: Arc::new(InMemoryAnalysisRepository::new()),
            binlog_cancellations: Arc::new(Mutex::new(HashMap::new())),
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

    /// Verifies restricted mode lists and authorizes every selected target.
    #[tokio::test]
    async fn restricted_scope_hides_and_rejects_other_connections() {
        let selected = profile("Selected A", Engine::MySql);
        let also_selected = profile("Selected B", Engine::MySql);
        let other = profile("Other", Engine::MySql);
        let settings = McpSettings {
            restrict_to_connection: true,
            target_connection_ids: vec![selected.id, also_selected.id],
            ..McpSettings::default()
        };
        let (_directory, service) = test_service(
            &[selected.clone(), also_selected.clone(), other.clone()],
            &settings,
        );

        let profiles = service.available_connections().await.unwrap();

        assert_eq!(profiles.len(), 2);
        assert!(profiles.iter().any(|profile| profile.id == selected.id));
        assert!(profiles
            .iter()
            .any(|profile| profile.id == also_selected.id));
        assert_eq!(
            service.require_mysql(selected.id).await.unwrap().id,
            selected.id
        );
        assert_eq!(
            service.require_mysql(also_selected.id).await.unwrap().id,
            also_selected.id
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
                target_connection_ids: vec![other.id],
            };
        }

        let profiles = service.available_connections().await.unwrap();

        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, other.id);
    }

    /// Verifies every Binlog lifecycle tool and both multi-file source modes reach tools/list.
    #[test]
    fn binlog_tool_surface_exposes_upload_and_analysis_lifecycle() {
        let (_directory, service) = test_service(&[], &McpSettings::default());
        let tools = service.tool_router.list_all();
        let binlog_tools = tools
            .iter()
            .filter(|tool| tool.name.starts_with("binlog_"))
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>();

        assert_eq!(
            binlog_tools,
            vec![
                "binlog_close",
                "binlog_get_reset_sql",
                "binlog_get_summary",
                "binlog_get_transaction",
                "binlog_import",
                "binlog_list_transactions",
            ]
        );
        let import = tools
            .iter()
            .find(|tool| tool.name == "binlog_import")
            .unwrap();
        let schema = serde_json::to_string(&import.input_schema).unwrap();
        assert!(schema.contains("\"file_paths\""));
        assert!(schema.contains("\"files\""));
        assert!(schema.contains("\"content_base64\""));
    }
}
