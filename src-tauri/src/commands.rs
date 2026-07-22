use crate::state::AppState;
use chrono::Utc;
use pipa_core::{
    AppError, AppErrorCode, ConnectionProfile, DatabaseAdapter, QueryEvent, QueryRequest,
    RecordQueryHistoryInput, SaveConnectionInput,
};
use pipa_store::{QueryHistoryEntry, WorkspaceTab as StoredWorkspaceTab};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};
use tauri::{ipc::Channel, State};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const QUERY_EVENT_CHANNEL_CAPACITY: usize = 8;

/// IPC representation of the exact workspace-tab shape owned by `pipa-store`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceTabPayload {
    /// Stable tab identifier.
    id: Uuid,
    /// Immutable connection associated with this tab.
    connection_id: Uuid,
    /// User-visible tab title.
    title: String,
    /// Unsaved SQL editor contents.
    sql_text: String,
    /// Display order within the workspace.
    position: u32,
}

impl From<StoredWorkspaceTab> for WorkspaceTabPayload {
    /// Maps the store-owned tab into its transport representation.
    fn from(tab: StoredWorkspaceTab) -> Self {
        Self {
            id: tab.id,
            connection_id: tab.connection_id,
            title: tab.title,
            sql_text: tab.sql_text,
            position: tab.position,
        }
    }
}

impl From<WorkspaceTabPayload> for StoredWorkspaceTab {
    /// Maps the transport tab into the exact store-owned representation.
    fn from(tab: WorkspaceTabPayload) -> Self {
        Self {
            id: tab.id,
            connection_id: tab.connection_id,
            title: tab.title,
            sql_text: tab.sql_text,
            position: tab.position,
        }
    }
}

/// Returns all saved non-secret connection profiles.
#[tauri::command]
pub(crate) fn list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfile>, AppError> {
    list_connections_inner(&state)
}

/// Saves one MySQL profile and password atomically in encrypted local storage.
#[tauri::command]
pub(crate) fn save_mysql_connection(
    state: State<'_, AppState>,
    input: SaveConnectionInput,
) -> Result<ConnectionProfile, AppError> {
    save_mysql_connection_inner(&state, input)
}

/// Tests a MySQL profile and password without persisting either value.
#[tauri::command]
pub(crate) async fn test_mysql_connection(
    state: State<'_, AppState>,
    input: SaveConnectionInput,
) -> Result<(), AppError> {
    test_mysql_connection_inner(&state, input).await
}

/// Starts a MySQL query and forwards ordered streaming events to the caller.
#[tauri::command]
pub(crate) async fn run_query(
    state: State<'_, AppState>,
    request: QueryRequest,
    on_event: Channel<QueryEvent>,
) -> Result<Uuid, AppError> {
    run_query_inner(&state, request, on_event).await
}

/// Signals cancellation for one running query.
#[tauri::command]
pub(crate) async fn cancel_query(
    state: State<'_, AppState>,
    query_id: Uuid,
) -> Result<(), AppError> {
    cancel_query_inner(&state, query_id).await
}

/// Loads workspace tabs in their persisted display order.
#[tauri::command]
pub(crate) fn load_workspace(
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceTabPayload>, AppError> {
    load_workspace_inner(&state)
}

/// Transactionally replaces all persisted workspace tabs.
#[tauri::command]
pub(crate) fn save_workspace(
    state: State<'_, AppState>,
    tabs: Vec<WorkspaceTabPayload>,
) -> Result<(), AppError> {
    save_workspace_inner(&state, tabs)
}

/// Records one query after its matching streamed execution emits `Started`.
#[tauri::command]
pub(crate) fn record_query_history(
    state: State<'_, AppState>,
    input: RecordQueryHistoryInput,
) -> Result<(), AppError> {
    record_query_history_inner(&state, input)
}

/// Reads all non-secret connection profiles from encrypted local storage.
fn list_connections_inner(state: &AppState) -> Result<Vec<ConnectionProfile>, AppError> {
    state.local_store.list_connections()
}

/// Persists a profile and credential in one SQLCipher transaction.
fn save_mysql_connection_inner(
    state: &AppState,
    input: SaveConnectionInput,
) -> Result<ConnectionProfile, AppError> {
    let SaveConnectionInput { profile, password } = input;
    state
        .local_store
        .save_connection_with_credential(&profile, &password)?;
    Ok(profile)
}

/// Tests one supplied profile and password without persisting either value.
async fn test_mysql_connection_inner(
    state: &AppState,
    input: SaveConnectionInput,
) -> Result<(), AppError> {
    state
        .mysql
        .test_connection(&input.profile, &input.password)
        .await
}

/// Registers and starts one MySQL query with an eight-event backpressure bridge.
async fn run_query_inner(
    state: &AppState,
    request: QueryRequest,
    on_event: Channel<QueryEvent>,
) -> Result<Uuid, AppError> {
    let profile = state
        .local_store
        .list_connections()?
        .into_iter()
        .find(|profile| profile.id == request.connection_id)
        .ok_or_else(|| AppError {
            code: AppErrorCode::NotFound,
            message: "Database connection was not found".into(),
            technical_details: None,
            retryable: false,
        })?;
    let password = state
        .local_store
        .get_connection_credential(request.connection_id)?;
    let query_id = request.query_id;
    let cancellation = CancellationToken::new();
    {
        let mut cancellations = state.cancellations.lock().await;
        if cancellations.contains_key(&query_id) {
            return Err(AppError {
                code: AppErrorCode::Validation,
                message: "Query is already running".into(),
                technical_details: None,
                retryable: false,
            });
        }
        cancellations.insert(query_id, cancellation.clone());
    }

    let (event_sender, event_receiver) = mpsc::channel(QUERY_EVENT_CHANNEL_CAPACITY);
    tokio::spawn(forward_query_events(
        query_id,
        cancellation.clone(),
        state.cancellations.clone(),
        event_receiver,
        on_event,
    ));

    let mysql = state.mysql.clone();
    tokio::spawn(async move {
        if let Err(error) = mysql
            .query(
                &profile,
                password,
                request,
                event_sender.clone(),
                cancellation,
            )
            .await
        {
            let _send_result = event_sender
                .send(QueryEvent::Failed { query_id, error })
                .await;
        }
    });

    Ok(query_id)
}

/// Signals a running query without removing its terminal-path registration.
async fn cancel_query_inner(state: &AppState, query_id: Uuid) -> Result<(), AppError> {
    let cancellations = state.cancellations.lock().await;
    let cancellation = cancellations.get(&query_id).ok_or_else(|| AppError {
        code: AppErrorCode::NotFound,
        message: "Running query was not found".into(),
        technical_details: None,
        retryable: false,
    })?;
    cancellation.cancel();
    Ok(())
}

/// Loads ordered workspace tabs and maps only their existing store-owned fields.
fn load_workspace_inner(state: &AppState) -> Result<Vec<WorkspaceTabPayload>, AppError> {
    state
        .local_store
        .load_workspace()
        .map(|tabs| tabs.into_iter().map(WorkspaceTabPayload::from).collect())
}

/// Replaces workspace tabs after mapping their transport representation to store types.
fn save_workspace_inner(state: &AppState, tabs: Vec<WorkspaceTabPayload>) -> Result<(), AppError> {
    let tabs = tabs
        .into_iter()
        .map(StoredWorkspaceTab::from)
        .collect::<Vec<_>>();
    state.local_store.save_workspace(&tabs)
}

/// Stores a started query with server-owned UTC time and query-id idempotency.
fn record_query_history_inner(
    state: &AppState,
    input: RecordQueryHistoryInput,
) -> Result<(), AppError> {
    state.local_store.record_query_history(&QueryHistoryEntry {
        id: input.query_id,
        connection_id: input.connection_id,
        sql_text: input.sql,
        executed_at: Utc::now(),
    })
}

/// Forwards ordered query events and removes cancellation state on every exit path.
async fn forward_query_events(
    query_id: Uuid,
    cancellation: CancellationToken,
    cancellations: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
    mut events: mpsc::Receiver<QueryEvent>,
    on_event: Channel<QueryEvent>,
) {
    let mut terminal_event_forwarded = false;
    while let Some(event) = events.recv().await {
        let is_terminal = matches!(
            event,
            QueryEvent::Completed { .. } | QueryEvent::Canceled { .. } | QueryEvent::Failed { .. }
        );
        if on_event.send(event).is_err() {
            break;
        }
        if is_terminal {
            terminal_event_forwarded = true;
            break;
        }
    }

    if !terminal_event_forwarded {
        cancellation.cancel();
    }
    cancellations.lock().await.remove(&query_id);
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_query_inner, forward_query_events, list_connections_inner, load_workspace_inner,
        record_query_history_inner, run_query_inner, save_mysql_connection_inner,
        save_workspace_inner, test_mysql_connection_inner, WorkspaceTabPayload,
        QUERY_EVENT_CHANNEL_CAPACITY,
    };
    use crate::state::AppState;
    use pipa_core::{
        AppErrorCode, ConnectionProfile, Engine, Environment, QueryEvent, QueryRequest,
        RecordQueryHistoryInput, SaveConnectionInput, TlsMode,
    };
    use pipa_mysql::MySqlAdapter;
    use pipa_store::LocalStore;
    use secrecy::{ExposeSecret, SecretString};
    use std::{collections::HashMap, sync::Arc};
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tempfile::TempDir;
    use tokio::{sync::Mutex, time::timeout};
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    /// Creates isolated command state and keeps its temporary directory alive.
    fn test_state() -> (TempDir, AppState) {
        let directory = tempfile::tempdir().unwrap();
        let local_store = Arc::new(
            LocalStore::open(directory.path().join("pipa.db"), "test-encryption-key").unwrap(),
        );
        let state = AppState {
            local_store,
            mysql: Arc::new(MySqlAdapter::new()),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
        };

        (directory, state)
    }

    /// Creates a representative secret-bearing connection input.
    fn mysql_input(password: &str) -> SaveConnectionInput {
        SaveConnectionInput {
            profile: ConnectionProfile {
                id: Uuid::new_v4(),
                name: "Local MySQL".into(),
                engine: Engine::MySql,
                environment: Environment::Development,
                host: "127.0.0.1".into(),
                port: 3306,
                username: "developer".into(),
                database: Some("pipa".into()),
                tls_mode: TlsMode::Preferred,
            },
            password: SecretString::from(password),
        }
    }

    /// Verifies the command persists a profile and credential only in encrypted local storage.
    #[test]
    fn saving_connection_keeps_password_out_of_profile_and_raw_database() {
        let (directory, state) = test_state();
        let input = mysql_input("command-only-password");
        let connection_id = input.profile.id;

        let returned = save_mysql_connection_inner(&state, input).unwrap();

        let saved = state.local_store.list_connections().unwrap();
        assert_eq!(
            serde_json::to_value(&saved).unwrap(),
            serde_json::to_value([&returned]).unwrap()
        );
        assert_eq!(
            state
                .local_store
                .get_connection_credential(connection_id)
                .unwrap()
                .expose_secret(),
            "command-only-password"
        );
        let returned_json = serde_json::to_string(&returned).unwrap();
        assert!(!returned_json.contains("password"));
        assert!(!returned_json.contains("command-only-password"));
        drop(state);
        let database_bytes = std::fs::read(directory.path().join("pipa.db")).unwrap();
        assert!(!String::from_utf8_lossy(&database_bytes).contains("command-only-password"));
    }

    /// Verifies an injected credential failure leaves neither profile nor credential visible.
    #[test]
    fn saving_connection_failure_is_atomic_and_redacted() {
        let (directory, state) = test_state();
        let input = mysql_input("set-failure-password");
        let connection_id = input.profile.id;
        let connection = rusqlite::Connection::open(directory.path().join("pipa.db")).unwrap();
        connection
            .pragma_update(None, "key", "test-encryption-key")
            .unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_command_credential
                 BEFORE INSERT ON connection_credentials
                 BEGIN
                   SELECT RAISE(ABORT, 'injected credential failure');
                 END;",
            )
            .unwrap();

        let error = save_mysql_connection_inner(&state, input).unwrap_err();

        assert!(matches!(error.code, AppErrorCode::Storage));
        assert!(state.local_store.list_connections().unwrap().is_empty());
        assert!(state
            .local_store
            .get_connection_credential(connection_id)
            .is_err());
        assert!(!format!("{error:?}").contains("set-failure-password"));
    }

    /// Verifies the list command returns the profiles persisted by the local store.
    #[test]
    fn listing_connections_reads_local_store_profiles() {
        let (_directory, state) = test_state();
        let first = save_mysql_connection_inner(&state, mysql_input("first-password")).unwrap();

        let listed = list_connections_inner(&state).unwrap();

        assert_eq!(
            serde_json::to_value(listed).unwrap(),
            serde_json::to_value([first]).unwrap()
        );
    }

    /// Verifies unknown query cancellation returns the stable not-found category.
    #[tokio::test]
    async fn canceling_unknown_query_returns_not_found() {
        let (_directory, state) = test_state();

        let error = cancel_query_inner(&state, Uuid::new_v4())
            .await
            .unwrap_err();

        assert!(matches!(error.code, AppErrorCode::NotFound));
        assert_eq!(error.message, "Running query was not found");
    }

    /// Verifies cancellation signals but retains registration for terminal cleanup.
    #[tokio::test]
    async fn canceling_known_query_only_signals_its_token() {
        let (_directory, state) = test_state();
        let query_id = Uuid::new_v4();
        let cancellation = CancellationToken::new();
        state
            .cancellations
            .lock()
            .await
            .insert(query_id, cancellation.clone());

        cancel_query_inner(&state, query_id).await.unwrap();

        assert!(cancellation.is_cancelled());
        assert!(state.cancellations.lock().await.contains_key(&query_id));
    }

    /// Verifies workspace payloads map store-owned fields without redesigning their shape.
    #[test]
    fn workspace_commands_round_trip_store_owned_tab_shape() {
        let (_directory, state) = test_state();
        let tab = WorkspaceTabPayload {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            title: "Pinned query".into(),
            sql_text: "SELECT 1".into(),
            position: 4,
        };

        save_workspace_inner(&state, vec![tab.clone()]).unwrap();
        let loaded = load_workspace_inner(&state).unwrap();

        assert_eq!(loaded, vec![tab]);
        assert_eq!(
            serde_json::to_value(&loaded[0]).unwrap(),
            serde_json::json!({
                "id": loaded[0].id,
                "connectionId": loaded[0].connection_id,
                "title": "Pinned query",
                "sqlText": "SELECT 1",
                "position": 4
            })
        );
    }

    /// Verifies replaying a Started event records one history row with backend UTC time.
    #[test]
    fn record_history_command_is_idempotent_and_uses_safe_fields() {
        let (_directory, state) = test_state();
        let query_id = Uuid::new_v4();
        let connection_id = Uuid::new_v4();
        let input = RecordQueryHistoryInput {
            query_id,
            connection_id,
            sql: "SELECT actual_scope".into(),
        };

        record_query_history_inner(&state, input.clone()).unwrap();
        record_query_history_inner(&state, input).unwrap();

        let history = state.local_store.list_query_history(10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, query_id);
        assert_eq!(history[0].connection_id, connection_id);
        assert_eq!(history[0].sql_text, "SELECT actual_scope");
        assert!(history[0].executed_at.to_rfc3339().ends_with("+00:00"));
    }

    /// Verifies the adapter connection test returns safe errors without persisting credentials.
    #[tokio::test]
    async fn testing_connection_does_not_persist_or_expose_password() {
        let (_directory, state) = test_state();
        let mut input = mysql_input("test-only-password");
        input.profile.port = 1;
        let connection_id = input.profile.id;

        let error = test_mysql_connection_inner(&state, input)
            .await
            .unwrap_err();

        assert!(state.local_store.list_connections().unwrap().is_empty());
        assert!(state
            .local_store
            .get_connection_credential(connection_id)
            .is_err());
        assert!(!format!("{error:?}").contains("test-only-password"));
    }

    /// Verifies terminal events are forwarded before their registration is removed.
    #[tokio::test]
    async fn terminal_event_removes_query_registration() {
        let query_id = Uuid::new_v4();
        let cancellation = CancellationToken::new();
        let cancellations = Arc::new(Mutex::new(HashMap::from([(
            query_id,
            cancellation.clone(),
        )])));
        let (events_tx, events_rx) = tokio::sync::mpsc::channel(QUERY_EVENT_CHANNEL_CAPACITY);
        let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel();
        let on_event = json_channel(seen_tx);
        let forwarder = tokio::spawn(forward_query_events(
            query_id,
            cancellation,
            cancellations.clone(),
            events_rx,
            on_event,
        ));

        events_tx
            .send(QueryEvent::Completed {
                query_id,
                affected_rows: 2,
            })
            .await
            .unwrap();
        drop(events_tx);

        let event = timeout(std::time::Duration::from_secs(1), seen_rx.recv())
            .await
            .unwrap()
            .unwrap();
        forwarder.await.unwrap();
        assert_eq!(event["type"], "completed");
        assert!(cancellations.lock().await.is_empty());
    }

    /// Verifies a broken frontend channel cancels work and removes its registration.
    #[tokio::test]
    async fn channel_failure_cancels_and_removes_query_registration() {
        let query_id = Uuid::new_v4();
        let cancellation = CancellationToken::new();
        let cancellations = Arc::new(Mutex::new(HashMap::from([(
            query_id,
            cancellation.clone(),
        )])));
        let (events_tx, events_rx) = tokio::sync::mpsc::channel(QUERY_EVENT_CHANNEL_CAPACITY);
        let on_event = Channel::new(|_| {
            Err(tauri::Error::Io(std::io::Error::other(
                "test channel is closed",
            )))
        });
        let forwarder = tokio::spawn(forward_query_events(
            query_id,
            cancellation.clone(),
            cancellations.clone(),
            events_rx,
            on_event,
        ));

        events_tx
            .send(QueryEvent::Started { query_id })
            .await
            .unwrap();
        forwarder.await.unwrap();

        assert!(cancellation.is_cancelled());
        assert!(cancellations.lock().await.is_empty());
    }

    /// Verifies source shutdown without a terminal event still cancels and cleans up.
    #[tokio::test]
    async fn closed_adapter_channel_cancels_and_removes_query_registration() {
        let query_id = Uuid::new_v4();
        let cancellation = CancellationToken::new();
        let cancellations = Arc::new(Mutex::new(HashMap::from([(
            query_id,
            cancellation.clone(),
        )])));
        let (events_tx, events_rx) = tokio::sync::mpsc::channel(QUERY_EVENT_CHANNEL_CAPACITY);
        drop(events_tx);

        forward_query_events(
            query_id,
            cancellation.clone(),
            cancellations.clone(),
            events_rx,
            Channel::new(|_| Ok(())),
        )
        .await;

        assert!(cancellation.is_cancelled());
        assert!(cancellations.lock().await.is_empty());
    }

    /// Verifies adapter startup failure emits a terminal event and cleans registration.
    #[tokio::test]
    async fn run_query_emits_failed_event_and_cleans_up_adapter_failure() {
        let (_directory, state) = test_state();
        let mut input = mysql_input("query-only-password");
        input.profile.port = 1;
        let connection_id = input.profile.id;
        save_mysql_connection_inner(&state, input).unwrap();
        let query_id = Uuid::new_v4();
        let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel();

        let returned_id = run_query_inner(
            &state,
            QueryRequest {
                query_id,
                connection_id,
                sql: "SELECT 1".into(),
            },
            json_channel(seen_tx),
        )
        .await
        .unwrap();

        assert_eq!(returned_id, query_id);
        let event = timeout(std::time::Duration::from_secs(12), seen_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["type"], "failed");
        assert!(!event.to_string().contains("query-only-password"));
        timeout(std::time::Duration::from_secs(1), async {
            loop {
                if state.cancellations.lock().await.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    /// Verifies a duplicate query identifier cannot replace a live cancellation token.
    #[tokio::test]
    async fn run_query_rejects_duplicate_query_id_without_replacing_registration() {
        let (_directory, state) = test_state();
        let input = mysql_input("duplicate-query-password");
        let connection_id = input.profile.id;
        save_mysql_connection_inner(&state, input).unwrap();
        let query_id = Uuid::new_v4();
        let existing_cancellation = CancellationToken::new();
        state
            .cancellations
            .lock()
            .await
            .insert(query_id, existing_cancellation.clone());

        let error = run_query_inner(
            &state,
            QueryRequest {
                query_id,
                connection_id,
                sql: "SELECT 1".into(),
            },
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap_err();

        assert!(matches!(error.code, AppErrorCode::Validation));
        assert_eq!(error.message, "Query is already running");
        let registrations = state.cancellations.lock().await;
        assert!(registrations.contains_key(&query_id));
        assert!(!existing_cancellation.is_cancelled());
    }

    /// Creates a Tauri channel that decodes JSON events into the test receiver.
    fn json_channel(
        sender: tokio::sync::mpsc::UnboundedSender<serde_json::Value>,
    ) -> Channel<QueryEvent> {
        Channel::new(move |body| {
            let InvokeResponseBody::Json(json) = body else {
                return Err(tauri::Error::Io(std::io::Error::other(
                    "expected JSON channel event",
                )));
            };
            let event = serde_json::from_str(&json)?;
            sender.send(event).map_err(|_| {
                tauri::Error::Io(std::io::Error::other("test event receiver is closed"))
            })
        })
    }
}
