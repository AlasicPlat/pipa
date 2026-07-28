//! Loopback Streamable HTTP MCP server lifecycle.

use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::{from_fn, Next},
    Router,
};
use pipa_core::{AppError, AppErrorCode};
use pipa_store::McpSettings;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use std::{net::SocketAddr, sync::Arc};
use tokio::{sync::Mutex, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use tower_http::limit::RequestBodyLimitLayer;
use uuid::Uuid;

use super::{
    binlog::MCP_MAX_REQUEST_BYTES,
    service::{McpDeps, PipaMcpService},
};

/// Default MCP listen port when unset.
pub const DEFAULT_MCP_PORT: u16 = 3847;

/// Runtime handle for the in-process MCP HTTP server.
#[derive(Default)]
pub struct McpServerHandle {
    /// Cancellation token for the active listener (if any).
    cancellation: Option<CancellationToken>,
    /// Task owning the active listener.
    task: Option<JoinHandle<()>>,
    /// Current bearer token (memory only).
    token: Option<String>,
    /// Bound port when running.
    port: Option<u16>,
    /// Last error from start/stop.
    last_error: Option<String>,
    /// Persisted preference mirror.
    settings: McpSettings,
}

impl McpServerHandle {
    /// Creates a handle seeded from persisted settings.
    pub fn from_settings(settings: McpSettings) -> Self {
        Self {
            settings,
            ..Self::default()
        }
    }

    /// Whether the HTTP listener is active.
    pub fn running(&self) -> bool {
        self.cancellation.is_some()
    }

    /// Current settings mirror.
    pub fn settings(&self) -> &McpSettings {
        &self.settings
    }

    /// Updates the persisted MCP connection-selection preferences.
    pub fn set_connection_scope(
        &mut self,
        restrict_to_connection: bool,
        target_connection_id: Option<Uuid>,
    ) {
        self.settings.restrict_to_connection = restrict_to_connection;
        self.settings.target_connection_id = target_connection_id;
    }

    /// Active bearer token.
    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    /// Bound port when running, else configured port.
    pub fn port(&self) -> u16 {
        self.port.unwrap_or(self.settings.port)
    }

    /// Last error message.
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    /// Endpoint URL when running.
    pub fn url(&self) -> Option<String> {
        self.port.map(|port| format!("http://127.0.0.1:{port}/mcp"))
    }
}

/// Shared mutable server handle.
pub type SharedMcpServer = Arc<Mutex<McpServerHandle>>;

/// Starts the loopback MCP HTTP server. Regenerates the bearer token on each start.
pub async fn start_mcp_server(
    handle: SharedMcpServer,
    deps: McpDeps,
    port: u16,
) -> Result<(), AppError> {
    let mut guard = handle.lock().await;
    if guard.running() {
        return Ok(());
    }

    let token = match generate_token() {
        Ok(token) => token,
        Err(error) => {
            guard.last_error = Some(error.message.clone());
            return Err(error);
        }
    };
    let cancellation = CancellationToken::new();
    let child = cancellation.child_token();
    let expected_token = Arc::new(token.clone());
    let deps_for_factory = deps;

    let service = StreamableHttpService::new(
        move || Ok(PipaMcpService::new(deps_for_factory.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_cancellation_token(child.clone()),
    );

    let auth_token = expected_token.clone();
    let router = limit_request_body(
        Router::new().nest_service("/mcp", service),
        MCP_MAX_REQUEST_BYTES,
    )
    .layer(from_fn(move |request: Request, next: Next| {
        let auth_token = auth_token.clone();
        async move {
            if !authorized(&request, auth_token.as_str()) {
                return Err(StatusCode::UNAUTHORIZED);
            }
            Ok(next.run(request).await)
        }
    }));

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(source) => {
            let error = AppError {
                code: AppErrorCode::Internal,
                message: format!("Could not bind MCP server on 127.0.0.1:{port}"),
                technical_details: Some(source.to_string()),
                retryable: true,
            };
            guard.last_error = Some(error.message.clone());
            return Err(error);
        }
    };
    let bound_port = listener
        .local_addr()
        .map(|addr| addr.port())
        .unwrap_or(port);

    let handle_for_task = handle.clone();
    let task = tokio::spawn(async move {
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                child.cancelled().await;
            })
            .await;
        let mut guard = handle_for_task.lock().await;
        guard.cancellation = None;
        guard.task = None;
        guard.token = None;
        guard.port = None;
        if let Err(error) = result {
            guard.last_error = Some(format!("MCP server stopped: {error}"));
        }
    });

    guard.cancellation = Some(cancellation);
    guard.task = Some(task);
    guard.token = Some(token);
    guard.port = Some(bound_port);
    guard.last_error = None;
    guard.settings.port = bound_port;
    guard.settings.enabled = true;
    Ok(())
}

/// Wraps every MCP route body so raw-body consumers cannot bypass the upload ceiling.
fn limit_request_body(router: Router, max_bytes: usize) -> Router {
    router.layer(RequestBodyLimitLayer::new(max_bytes))
}

/// Stops the MCP HTTP server and waits until its listener releases the port.
pub async fn stop_mcp_server(handle: SharedMcpServer) -> Result<(), AppError> {
    let (cancellation, task) = {
        let mut guard = handle.lock().await;
        let cancellation = guard.cancellation.take();
        let task = guard.task.take();
        guard.token = None;
        guard.port = None;
        guard.settings.enabled = false;
        guard.last_error = None;
        (cancellation, task)
    };

    if let Some(cancellation) = cancellation {
        cancellation.cancel();
    }
    if let Some(task) = task {
        if let Err(source) = task.await {
            let error = AppError {
                code: AppErrorCode::Internal,
                message: "MCP server task stopped unexpectedly".into(),
                technical_details: Some(source.to_string()),
                retryable: true,
            };
            handle.lock().await.last_error = Some(error.message.clone());
            return Err(error);
        }
    }

    Ok(())
}

/// Changes the configured port and restores the previous running server if binding fails.
pub async fn set_mcp_server_port(
    handle: SharedMcpServer,
    deps: McpDeps,
    port: u16,
) -> Result<(), AppError> {
    let (was_running, old_port, old_settings) = {
        let guard = handle.lock().await;
        (guard.running(), guard.port(), guard.settings.clone())
    };
    if !was_running {
        let mut guard = handle.lock().await;
        let mut settings = guard.settings.clone();
        settings.port = port;
        guard.settings = settings;
        guard.last_error = None;
        return Ok(());
    }

    stop_mcp_server(handle.clone()).await?;
    {
        let mut guard = handle.lock().await;
        let mut settings = old_settings.clone();
        settings.port = port;
        settings.enabled = true;
        guard.settings = settings;
    }
    if let Err(change_error) = start_mcp_server(handle.clone(), deps.clone(), port).await {
        {
            let mut guard = handle.lock().await;
            guard.settings = old_settings;
        }
        if let Err(restore_error) = start_mcp_server(handle.clone(), deps, old_port).await {
            let error = AppError {
                code: AppErrorCode::Internal,
                message: "Could not change MCP port or restore the previous server".into(),
                technical_details: Some(format!(
                    "change_error={}; restore_error={}",
                    change_error.message, restore_error.message
                )),
                retryable: true,
            };
            handle.lock().await.last_error = Some(error.message.clone());
            return Err(error);
        }
        return Err(change_error);
    }

    Ok(())
}

/// Regenerates the token by restarting the server when it is already running.
pub async fn regenerate_token_and_restart(
    handle: SharedMcpServer,
    deps: McpDeps,
) -> Result<(), AppError> {
    let port = {
        let guard = handle.lock().await;
        guard.port()
    };
    stop_mcp_server(handle.clone()).await?;
    // Keep enabled preference true after regenerate.
    {
        let mut guard = handle.lock().await;
        guard.settings.enabled = true;
    }
    start_mcp_server(handle, deps, port).await
}

/// Checks one HTTP bearer token without data-dependent byte comparisons.
fn authorized(request: &Request, expected: &str) -> bool {
    let Some(header) = request.headers().get(AUTHORIZATION) else {
        return false;
    };
    let Ok(value) = header.to_str() else {
        return false;
    };
    let Some(token) = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
    else {
        return false;
    };
    constant_time_eq(token.as_bytes(), expected.as_bytes())
}

/// Compares equal-length byte strings in constant time.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0_u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Generates a random 256-bit hexadecimal bearer token.
fn generate_token() -> Result<String, AppError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| AppError {
        code: AppErrorCode::Internal,
        message: "Could not generate MCP bearer token".into(),
        technical_details: Some(error.to_string()),
        retryable: true,
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::{
        limit_request_body, regenerate_token_and_restart, set_mcp_server_port, start_mcp_server,
        stop_mcp_server, McpServerHandle, SharedMcpServer,
    };
    use crate::mcp::{McpDeps, McpQueue};
    use axum::{
        body::{to_bytes, Body},
        http::{header::CONTENT_LENGTH, Request, StatusCode},
        routing::post,
        Router,
    };
    use pipa_mysql::MySqlAdapter;
    use pipa_store::LocalStore;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::Mutex;
    use tower::ServiceExt;

    /// Builds isolated dependencies sufficient to start the loopback MCP listener.
    fn test_deps() -> (TempDir, McpDeps) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalStore::open(directory.path().join("pipa.db"), "test-key").unwrap();
        (
            directory,
            McpDeps {
                local_store: Arc::new(store),
                mysql: Arc::new(MySqlAdapter::new()),
                queue: McpQueue::new(),
                connection_scope: crate::mcp::shared_connection_scope(
                    &pipa_store::McpSettings::default(),
                ),
                binlog_analyses: Arc::new(pipa_binlog::InMemoryAnalysisRepository::new()),
                binlog_cancellations: Arc::new(Mutex::new(std::collections::HashMap::new())),
            },
        )
    }

    /// Creates an empty shared lifecycle handle.
    fn test_handle() -> SharedMcpServer {
        Arc::new(Mutex::new(McpServerHandle::default()))
    }

    /// Verifies raw collection is bounded even when the request omits `Content-Length`.
    #[tokio::test]
    async fn oversized_request_body_is_rejected() {
        let router = limit_request_body(
            Router::new().route(
                "/mcp",
                post(|request: axum::extract::Request| async move {
                    match to_bytes(request.into_body(), usize::MAX).await {
                        Ok(_body) => StatusCode::OK,
                        Err(_error) => StatusCode::PAYLOAD_TOO_LARGE,
                    }
                }),
            ),
            4,
        );
        let request = Request::builder()
            .method("POST")
            .uri("/mcp")
            .body(Body::from("12345"))
            .unwrap();

        let response = router.clone().oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let request = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header(CONTENT_LENGTH, "5")
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// Verifies token regeneration releases and rebinds the same listener port.
    #[tokio::test]
    async fn token_regeneration_waits_for_listener_shutdown() {
        let (_directory, deps) = test_deps();
        let handle = test_handle();
        start_mcp_server(handle.clone(), deps.clone(), 0)
            .await
            .unwrap();
        let (port, first_token) = {
            let guard = handle.lock().await;
            (guard.port(), guard.token().unwrap().to_owned())
        };

        regenerate_token_and_restart(handle.clone(), deps)
            .await
            .unwrap();

        {
            let guard = handle.lock().await;
            assert!(guard.running());
            assert_eq!(guard.port(), port);
            assert_ne!(guard.token(), Some(first_token.as_str()));
        }
        stop_mcp_server(handle).await.unwrap();
    }

    /// Verifies a failed port change restores the previous live server.
    #[tokio::test]
    async fn failed_port_change_restores_previous_server() {
        let (_directory, deps) = test_deps();
        let handle = test_handle();
        start_mcp_server(handle.clone(), deps.clone(), 0)
            .await
            .unwrap();
        let old_port = handle.lock().await.port();
        let occupied = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let occupied_port = occupied.local_addr().unwrap().port();

        let error = set_mcp_server_port(handle.clone(), deps, occupied_port)
            .await
            .unwrap_err();

        assert!(error.retryable);
        {
            let guard = handle.lock().await;
            assert!(guard.running());
            assert_eq!(guard.port(), old_port);
            assert_eq!(guard.settings().port, old_port);
        }
        stop_mcp_server(handle).await.unwrap();
    }

    /// Verifies startup failures are retained for the status panel.
    #[tokio::test]
    async fn bind_failure_updates_last_error() {
        let (_directory, deps) = test_deps();
        let handle = test_handle();
        let occupied = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = occupied.local_addr().unwrap().port();

        start_mcp_server(handle.clone(), deps, port)
            .await
            .unwrap_err();

        let guard = handle.lock().await;
        assert!(!guard.running());
        assert!(guard
            .last_error()
            .is_some_and(|message| message.contains("Could not bind MCP server")));
    }
}
