import { invoke, type Channel } from "@tauri-apps/api/core";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import type { ApplyTableMutationsInput } from "../bindings/ApplyTableMutationsInput";
import type { ApplyTableMutationsResult } from "../bindings/ApplyTableMutationsResult";
import type { RecordQueryHistoryInput } from "../bindings/RecordQueryHistoryInput";
import type { SaveConnectionInput } from "../bindings/SaveConnectionInput";
import type {
  BinlogImportEvent,
  BinlogOperation,
  BinlogResetSql,
  BinlogSummary,
  BinlogTransaction,
  BinlogTransactionFilter,
  BinlogTransactionPage,
} from "../features/binlog/types";
import type { McpPanelSnapshot } from "../features/mcp/types";
import type {
  CommonSql,
  SaveCommonSqlInput,
  SaveSqlFolderInput,
  SqlFolder,
  SqlLibrary,
} from "../features/sql-library/types";

/** Exact non-secret workspace-tab payload shared with the Rust persistence command. */
export interface WorkspaceTabPayload {
  id: string;
  connectionId: string;
  title: string;
  sqlText: string;
  position: number;
}

/**
 * Keeps the native desktop execute-query menu aligned with the configured web shortcut.
 * @param accelerator - Valid Tauri menu accelerator such as `CmdOrCtrl+R`.
 * @returns A promise that resolves after the operating-system menu is updated.
 * Side effects: invokes the Tauri `set_execute_query_accelerator` command.
 */
export function setExecuteQueryAccelerator(accelerator: string): Promise<void> {
  return invoke<void>("set_execute_query_accelerator", { accelerator });
}

/**
 * Commits one typed MySQL table change set as a parameterized backend transaction.
 * @param input - Connection, target, and ordered typed row mutations.
 * @returns The committed mutation and affected-row counts.
 * Side effects: mutates the selected MySQL table atomically.
 */
export function applyTableMutations(
  input: ApplyTableMutationsInput,
): Promise<ApplyTableMutationsResult> {
  return invoke<ApplyTableMutationsResult>("apply_table_mutations", { input });
}

/**
 * Loads every saved non-secret connection profile from the local desktop backend.
 * Parameters: none.
 * @returns A promise containing the saved connection profiles.
 * Side effects: invokes the Tauri `list_connections` command.
 */
export function listConnections(): Promise<ConnectionProfile[]> {
  return invoke<ConnectionProfile[]>("list_connections");
}

/**
 * Permanently deletes one connection and its related encrypted local data.
 * @param connectionId - Stable identifier of the connection to remove.
 * @returns A promise that resolves after the idempotent delete transaction commits.
 * Side effects: invokes the Tauri `delete_connection` command.
 */
export function deleteConnection(connectionId: string): Promise<void> {
  return invoke<void>("delete_connection", { connectionId });
}

/**
 * Renames one saved connection while leaving its encrypted credential untouched.
 * @param connectionId - Stable identifier of the connection to rename.
 * @param name - User-visible name; the backend trims and validates it.
 * @returns A promise containing the renamed non-secret profile.
 * Side effects: invokes the Tauri `rename_connection` command.
 */
export function renameConnection(
  connectionId: string,
  name: string,
): Promise<ConnectionProfile> {
  return invoke<ConnectionProfile>("rename_connection", { connectionId, name });
}

/**
 * Re-tests one saved connection with its credential read only by the desktop backend.
 * @param connectionId - Stable identifier of the connection to test again.
 * @returns A promise that resolves when the existing profile is reachable.
 * Side effects: invokes the Tauri `reconnect_connection` command without receiving a password.
 */
export function reconnectConnection(connectionId: string): Promise<void> {
  return invoke<void>("reconnect_connection", { connectionId });
}

/**
 * Tests a MySQL profile and its ephemeral password without persisting either value.
 * @param input - The non-secret profile and password to test.
 * @returns A promise that resolves when the backend confirms connectivity.
 * Side effects: invokes the Tauri `test_mysql_connection` command.
 */
export function testMySqlConnection(input: SaveConnectionInput): Promise<void> {
  return invoke<void>("test_mysql_connection", { input });
}

/**
 * Persists a MySQL profile and transfers its password directly to OS credential storage.
 * @param input - The non-secret profile and ephemeral password to save.
 * @returns A promise containing the backend-confirmed saved profile.
 * Side effects: invokes the Tauri `save_mysql_connection` command.
 */
export function saveMySqlConnection(input: SaveConnectionInput): Promise<ConnectionProfile> {
  return invoke<ConnectionProfile>("save_mysql_connection", { input });
}

/** Tests a Redis profile and ephemeral password without persisting either value. */
export function testRedisConnection(input: SaveConnectionInput): Promise<void> {
  return invoke<void>("test_redis_connection", { input });
}

/** Saves one backend-confirmed Redis profile and its encrypted local credential. */
export function saveRedisConnection(input: SaveConnectionInput): Promise<ConnectionProfile> {
  return invoke<ConnectionProfile>("save_redis_connection", { input });
}

/**
 * Loads ordered unsaved query tabs for one desktop window from encrypted local storage.
 * @param windowLabel - Stable Tauri window label that owns the tabs.
 * @returns A promise containing only safe workspace fields in display order.
 * Side effects: invokes the Tauri `load_workspace` command.
 */
export function loadWorkspace(windowLabel: string): Promise<WorkspaceTabPayload[]> {
  return invoke<WorkspaceTabPayload[]>("load_workspace", { windowLabel });
}

/**
 * Transactionally replaces one desktop window's ordered local workspace snapshot.
 * @param windowLabel - Stable Tauri window label that owns the tabs.
 * @param tabs - Safe tab identity, immutable connection context, title, SQL, and position.
 * @returns A promise that resolves when encrypted local persistence completes.
 * Side effects: invokes the Tauri `save_workspace` command.
 */
export function saveWorkspace(windowLabel: string, tabs: WorkspaceTabPayload[]): Promise<void> {
  return invoke<void>("save_workspace", { windowLabel, tabs });
}

/** Atomically transfers one persisted query tab between desktop windows. */
export function transferWorkspaceTab(
  tab: WorkspaceTabPayload,
  sourceWindowLabel: string,
  targetWindowLabel: string,
): Promise<void> {
  return invoke<void>("transfer_workspace_tab", {
    tab,
    sourceWindowLabel,
    targetWindowLabel,
  });
}

/** Lists detached window labels that still own persisted query workspaces. */
export function listWorkspaceWindowLabels(): Promise<string[]> {
  return invoke<string[]>("list_workspace_window_labels");
}

/**
 * Records a matching started query once using its stable query identifier.
 * @param input - Immutable connection, exact executed SQL, and stable query identifier.
 * @returns A promise that resolves after the backend stamps UTC time and stores the row.
 * Side effects: invokes the idempotent Tauri `record_query_history` command.
 */
export function recordQueryHistory(input: RecordQueryHistoryInput): Promise<void> {
  return invoke<void>("record_query_history", { input });
}

/**
 * Loads directories and reusable statements for exactly one database engine.
 * @param engine - Database type whose isolated collection should be returned.
 * @returns The consistent directory and statement snapshot for that engine.
 * Side effects: reads encrypted local persistence through Tauri.
 */
export function loadSqlLibrary(engine: ConnectionProfile["engine"]): Promise<SqlLibrary> {
  return invoke<SqlLibrary>("load_sql_library", { engine });
}

/**
 * Idempotently creates or renames one engine-scoped common SQL directory.
 * @param input - Stable directory identity, immutable engine, and requested name.
 * @returns The backend-confirmed persisted directory.
 * Side effects: mutates encrypted local persistence through Tauri.
 */
export function saveSqlFolder(input: SaveSqlFolderInput): Promise<SqlFolder> {
  return invoke<SqlFolder>("save_sql_folder", { input });
}

/**
 * Deletes one directory while retaining its statements in the uncategorized collection.
 * @param folderId - Stable directory identifier to remove.
 * @returns A promise resolved after the idempotent deletion commits.
 * Side effects: mutates encrypted local persistence through Tauri.
 */
export function deleteSqlFolder(folderId: string): Promise<void> {
  return invoke<void>("delete_sql_folder", { folderId });
}

/**
 * Idempotently creates or edits one reusable SQL statement or native command.
 * @param input - Stable identity, engine, optional directory, name, and exact text.
 * @returns The backend-confirmed persisted reusable statement.
 * Side effects: mutates encrypted local persistence through Tauri.
 */
export function saveCommonSql(input: SaveCommonSqlInput): Promise<CommonSql> {
  return invoke<CommonSql>("save_common_sql", { input });
}

/**
 * Idempotently deletes one reusable SQL statement or native command.
 * @param sqlId - Stable reusable statement identifier to remove.
 * @returns A promise resolved after the deletion commits.
 * Side effects: mutates encrypted local persistence through Tauri.
 */
export function deleteCommonSql(sqlId: string): Promise<void> {
  return invoke<void>("delete_common_sql", { sqlId });
}

/** Loads the current MCP server status, proposals, and activity log. */
export function mcpGetSnapshot(): Promise<McpPanelSnapshot> {
  return invoke<McpPanelSnapshot>("mcp_get_snapshot");
}

/** Starts the loopback Streamable HTTP MCP server. */
export function mcpStart(): Promise<McpPanelSnapshot> {
  return invoke<McpPanelSnapshot>("mcp_start");
}

/** Stops the MCP HTTP server. */
export function mcpStop(): Promise<McpPanelSnapshot> {
  return invoke<McpPanelSnapshot>("mcp_stop");
}

/** Updates the preferred MCP port (restarts when already running). */
export function mcpSetPort(port: number): Promise<McpPanelSnapshot> {
  return invoke<McpPanelSnapshot>("mcp_set_port", { port });
}

/**
 * Updates the optional multi-connection MCP access boundary.
 * @param restrictToConnection - Whether MCP tools may use only the selected targets.
 * @param targetConnectionIds - Saved connections retained as targets, or an empty list when unset.
 * @returns The refreshed MCP panel snapshot.
 * Side effects: persists encrypted local MCP settings and updates live MCP sessions.
 */
export function mcpSetConnectionScope(
  restrictToConnection: boolean,
  targetConnectionIds: string[],
): Promise<McpPanelSnapshot> {
  return invoke<McpPanelSnapshot>("mcp_set_connection_scope", {
    restrictToConnection,
    targetConnectionIds,
  });
}

/** Regenerates the bearer token by restarting MCP. */
export function mcpRegenerateToken(): Promise<McpPanelSnapshot> {
  return invoke<McpPanelSnapshot>("mcp_regenerate_token");
}

/** Executes a pending MCP SQL proposal after user confirmation. */
export function mcpExecuteProposal(proposalId: string): Promise<McpPanelSnapshot> {
  return invoke<McpPanelSnapshot>("mcp_execute_proposal", { proposalId });
}

/** Dismisses a pending MCP SQL proposal without executing it. */
export function mcpDismissProposal(proposalId: string): Promise<McpPanelSnapshot> {
  return invoke<McpPanelSnapshot>("mcp_dismiss_proposal", { proposalId });
}

/** Runs arbitrary SQL from the MCP panel (UI privileges; not MCP-gated). */
export function mcpRunManualSql(connectionId: string, sql: string): Promise<McpPanelSnapshot> {
  return invoke<McpPanelSnapshot>("mcp_run_manual_sql", { connectionId, sql });
}

/**
 * Starts a streaming, offline binlog analysis for one ordered file selection.
 * @param paths - Absolute native paths chosen by the user; files are inspected by content.
 * @param onEvent - Tauri channel subscribed before invocation for ordered lifecycle progress.
 * @returns The backend-owned analysis identifier used by subsequent commands.
 * Side effects: creates an ephemeral backend analysis and begins reading local files.
 */
export function startBinlogImport(
  paths: string[],
  onEvent: Channel<BinlogImportEvent>,
): Promise<string> {
  return invoke<string>("binlog_start_import", { paths, onEvent });
}

/**
 * Requests cancellation of a running binlog import.
 * @param analysisId - Identifier returned by `startBinlogImport`.
 * @returns A promise that resolves when the cancellation request is accepted.
 * Side effects: signals the backend parser; the terminal state still arrives on the channel.
 */
export function cancelBinlogImport(analysisId: string): Promise<void> {
  return invoke<void>("binlog_cancel_import", { analysisId });
}

/**
 * Loads aggregate counts, source metadata, table choices, and diagnostics.
 * @param analysisId - Completed analysis identifier.
 * @returns The immutable summary for the imported file set.
 * Side effects: reads the backend's ephemeral analysis index.
 */
export function getBinlogSummary(analysisId: string): Promise<BinlogSummary> {
  return invoke<BinlogSummary>("binlog_get_summary", { analysisId });
}

/**
 * Loads one filtered cursor page for the transaction timeline.
 * @param analysisId - Completed analysis identifier.
 * @param filter - Exact database, table, operation, cursor, and page-size constraints.
 * @returns Ordered transaction items and the optional next cursor.
 * Side effects: reads the backend's ephemeral analysis index.
 */
export function listBinlogTransactions(
  analysisId: string,
  filter: BinlogTransactionFilter,
): Promise<BinlogTransactionPage> {
  return invoke<BinlogTransactionPage>("binlog_list_transactions", {
    analysisId,
    filter,
  });
}

/**
 * Loads row images for one expanded transaction using the active timeline filter.
 * @param analysisId - Completed analysis identifier.
 * @param sequence - Stable transaction sequence returned by the summary page.
 * @param database - Exact database filter or `null`.
 * @param table - Exact table filter or `null`.
 * @param operation - Exact operation filter or `null`.
 * @returns The projected transaction including row and statement changes.
 * Side effects: reads one transaction from the backend's ephemeral analysis index.
 */
export function getBinlogTransaction(
  analysisId: string,
  sequence: number,
  database: string | null,
  table: string | null,
  operation: BinlogOperation | null,
): Promise<BinlogTransaction> {
  return invoke<BinlogTransaction>("binlog_get_transaction", {
    analysisId,
    sequence,
    database,
    table,
    operation,
  });
}

/**
 * Generates Reset SQL for one transaction using the active timeline projection.
 * @param analysisId - Completed analysis identifier.
 * @param sequence - Stable transaction sequence returned by the summary page.
 * @param database - Exact database filter or `null`.
 * @param table - Exact table filter or `null`.
 * @param operation - Exact operation filter or `null`.
 * @returns Reviewable SQL plus statement count, completeness, and safety warnings.
 * Side effects: reads decoded row images; no SQL is executed.
 */
export function getBinlogResetSql(
  analysisId: string,
  sequence: number,
  database: string | null,
  table: string | null,
  operation: BinlogOperation | null,
): Promise<BinlogResetSql> {
  return invoke<BinlogResetSql>("binlog_get_reset_sql", {
    analysisId,
    sequence,
    database,
    table,
    operation,
  });
}

/**
 * Releases all temporary files and database state for one local analysis.
 * @param analysisId - Analysis identifier to close; repeated closes are safe.
 * @returns A promise that resolves after ephemeral state is released.
 * Side effects: removes the backend-owned analysis session and its temporary index.
 */
export function closeBinlogAnalysis(analysisId: string): Promise<void> {
  return invoke<void>("binlog_close_analysis", { analysisId });
}
