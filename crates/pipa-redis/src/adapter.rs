use pipa_core::{
    AppError, AppErrorCode, ConnectionProfile, DatabaseAdapter, Engine, QueryEvent, QueryRequest,
    TlsMode,
};
use secrecy::{ExposeSecret, SecretString};
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::mpsc,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_LINE_BYTES: usize = 4096;

/// Minimal RESP adapter used for Redis connection validation.
pub struct RedisAdapter;

impl RedisAdapter {
    /// Creates a stateless Redis adapter.
    pub const fn new() -> Self {
        Self
    }
}

impl Default for RedisAdapter {
    /// Creates the default stateless Redis adapter.
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl DatabaseAdapter for RedisAdapter {
    /// Returns the Redis engine identifier.
    fn engine(&self) -> Engine {
        Engine::Redis
    }

    /// Opens a Redis socket, authenticates, selects the configured database, and sends PING.
    async fn test_connection(
        &self,
        profile: &ConnectionProfile,
        password: &SecretString,
    ) -> Result<(), AppError> {
        if !matches!(profile.engine, Engine::Redis) {
            return Err(validation_error("Connection profile is not Redis"));
        }
        if !matches!(profile.tls_mode, TlsMode::Disabled) {
            return Err(validation_error(
                "Redis TLS is not supported in this version",
            ));
        }

        timeout(CONNECTION_TIMEOUT, test_redis_connection(profile, password))
            .await
            .map_err(|_| AppError {
                code: AppErrorCode::Timeout,
                message: "Redis connection timed out".into(),
                technical_details: None,
                retryable: true,
            })?
    }

    /// Rejects Redis commands until the dedicated command workbench is implemented.
    async fn query(
        &self,
        _profile: &ConnectionProfile,
        _password: SecretString,
        _request: QueryRequest,
        _events: mpsc::Sender<QueryEvent>,
        _cancellation: CancellationToken,
    ) -> Result<(), AppError> {
        Err(validation_error(
            "Redis command execution is not supported in this version",
        ))
    }
}

/// Performs the ordered AUTH, SELECT, and PING handshake on one Redis connection.
async fn test_redis_connection(
    profile: &ConnectionProfile,
    password: &SecretString,
) -> Result<(), AppError> {
    let stream = TcpStream::connect((profile.host.as_str(), profile.port))
        .await
        .map_err(connection_error)?;
    let mut stream = BufReader::new(stream);

    if !password.expose_secret().is_empty() {
        let mut arguments = vec!["AUTH"];
        if !profile.username.is_empty() {
            arguments.push(&profile.username);
        }
        arguments.push(password.expose_secret());
        send_command(&mut stream, &arguments, AppErrorCode::Authentication).await?;
    }

    if let Some(database) = profile.database.as_deref() {
        let database_number = database
            .parse::<u32>()
            .map_err(|_| validation_error("Redis database must be a non-negative number"))?;
        let database_number = database_number.to_string();
        send_command(
            &mut stream,
            &["SELECT", &database_number],
            AppErrorCode::Connection,
        )
        .await?;
    }

    let response = send_command(&mut stream, &["PING"], AppErrorCode::Connection).await?;
    if response != "+PONG" {
        return Err(AppError {
            code: AppErrorCode::Connection,
            message: "Redis did not return PONG".into(),
            technical_details: None,
            retryable: false,
        });
    }
    Ok(())
}

/// Writes one RESP array and reads its bounded single-line response.
async fn send_command(
    stream: &mut BufReader<TcpStream>,
    arguments: &[&str],
    error_code: AppErrorCode,
) -> Result<String, AppError> {
    let request = encode_command(arguments);
    stream
        .get_mut()
        .write_all(&request)
        .await
        .map_err(connection_error)?;

    let mut response = Vec::new();
    stream
        .read_until(b'\n', &mut response)
        .await
        .map_err(connection_error)?;
    if response.len() < 3
        || response.len() > MAX_RESPONSE_LINE_BYTES
        || !response.ends_with(b"\r\n")
    {
        return Err(AppError {
            code: AppErrorCode::Connection,
            message: "Redis returned an invalid response".into(),
            technical_details: None,
            retryable: false,
        });
    }
    response.truncate(response.len() - 2);
    let response = String::from_utf8(response).map_err(|_| AppError {
        code: AppErrorCode::Connection,
        message: "Redis returned a non-text response".into(),
        technical_details: None,
        retryable: false,
    })?;
    if response.starts_with('-') {
        return Err(AppError {
            code: error_code,
            message: if matches!(error_code, AppErrorCode::Authentication) {
                "Redis authentication failed"
            } else {
                "Redis rejected the connection setup"
            }
            .into(),
            technical_details: None,
            retryable: false,
        });
    }
    Ok(response)
}

/// Encodes one command as an exact RESP array without retaining secret-bearing strings.
fn encode_command(arguments: &[&str]) -> Vec<u8> {
    let mut request = format!("*{}\r\n", arguments.len()).into_bytes();
    for argument in arguments {
        request.extend_from_slice(format!("${}\r\n", argument.len()).as_bytes());
        request.extend_from_slice(argument.as_bytes());
        request.extend_from_slice(b"\r\n");
    }
    request
}

/// Maps socket errors into a stable retryable connection error.
fn connection_error(error: std::io::Error) -> AppError {
    AppError {
        code: AppErrorCode::Connection,
        message: "Could not connect to Redis".into(),
        technical_details: Some(error.to_string()),
        retryable: true,
    }
}

/// Creates a non-retryable validation error without secret-bearing details.
fn validation_error(message: &'static str) -> AppError {
    AppError {
        code: AppErrorCode::Validation,
        message: message.into(),
        technical_details: None,
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pipa_core::Environment;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        task::JoinHandle,
    };
    use uuid::Uuid;

    /// Verifies passwordless Redis performs SELECT followed by PING using exact RESP frames.
    #[tokio::test]
    async fn passwordless_connection_selects_and_pings() {
        let exchanges = vec![
            (encode_command(&["SELECT", "2"]), b"+OK\r\n".to_vec()),
            (encode_command(&["PING"]), b"+PONG\r\n".to_vec()),
        ];
        let (port, server) = spawn_redis_server(exchanges).await;
        let profile = test_profile(port, "", Some("2"));

        test_redis_connection(&profile, &SecretString::from(""))
            .await
            .expect("passwordless Redis handshake should succeed");
        server.await.expect("mock Redis server should finish");
    }

    /// Verifies ACL authentication errors stay stable and never expose the supplied password.
    #[tokio::test]
    async fn authentication_failure_is_redacted() {
        let password = "secret-that-must-not-leak";
        let exchanges = vec![(
            encode_command(&["AUTH", "pipa", password]),
            b"-WRONGPASS invalid username-password pair\r\n".to_vec(),
        )];
        let (port, server) = spawn_redis_server(exchanges).await;
        let profile = test_profile(port, "pipa", Some("0"));

        let error = test_redis_connection(&profile, &SecretString::from(password))
            .await
            .expect_err("invalid Redis password should fail");

        assert!(matches!(error.code, AppErrorCode::Authentication));
        assert_eq!(error.message, "Redis authentication failed");
        assert!(!format!("{error:?}").contains(password));
        server.await.expect("mock Redis server should finish");
    }

    /// Starts a single-client Redis protocol stub and returns its ephemeral port and task.
    async fn spawn_redis_server(exchanges: Vec<(Vec<u8>, Vec<u8>)>) -> (u16, JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("test listener should bind");
        let port = listener
            .local_addr()
            .expect("listener should have an address")
            .port();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("client should connect");
            for (expected_request, response) in exchanges {
                let mut request = vec![0; expected_request.len()];
                socket
                    .read_exact(&mut request)
                    .await
                    .expect("client should send a complete command");
                assert_eq!(request, expected_request);
                socket
                    .write_all(&response)
                    .await
                    .expect("server should send its response");
            }
        });
        (port, task)
    }

    /// Builds one Redis profile targeting the test protocol stub.
    fn test_profile(port: u16, username: &str, database: Option<&str>) -> ConnectionProfile {
        ConnectionProfile {
            id: Uuid::new_v4(),
            name: "Redis integration".into(),
            engine: Engine::Redis,
            environment: Environment::Development,
            host: "127.0.0.1".into(),
            port,
            username: username.into(),
            database: database.map(str::to_owned),
            tls_mode: TlsMode::Disabled,
        }
    }
}
