use base64::{engine::general_purpose::STANDARD, Engine as _};
use pipa_core::{
    AppError, AppErrorCode, CellValue, ConnectionProfile, DatabaseAdapter, Engine, QueryColumn,
    QueryEvent, QueryRequest, TlsMode,
};
use secrecy::{ExposeSecret, SecretString};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::{future::Future, pin::Pin, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::mpsc,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_COMMAND_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_RESPONSE_DEPTH: usize = 64;
const MAX_RESPONSE_LINE_BYTES: usize = 1024 * 1024;
const MAX_COLLECTION_ELEMENTS: usize = 1_000_000;
const MAX_PREALLOCATED_COLLECTION_ELEMENTS: usize = 256;

/// Stateless RESP adapter for standalone Redis connections and native command execution.
pub struct RedisAdapter;

/// Redis protocol values supported by RESP2 and the common RESP3 response types.
#[derive(Clone, Debug, PartialEq)]
enum RespValue {
    Simple(String),
    Error(String),
    Integer(String),
    Bulk(Option<Vec<u8>>),
    Array(Option<Vec<RespValue>>),
    Boolean(bool),
    Double(String),
    BigNumber(String),
    Verbatim(Vec<u8>),
    Map(Vec<(RespValue, RespValue)>),
    Set(Vec<RespValue>),
    Null,
}

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
        validate_profile(profile)?;
        timeout(CONNECTION_TIMEOUT, test_redis_connection(profile, password))
            .await
            .map_err(|_| timeout_error("Redis connection timed out"))?
    }

    /// Executes one native Redis command and emits its response through the shared result stream.
    async fn query(
        &self,
        profile: &ConnectionProfile,
        password: SecretString,
        request: QueryRequest,
        events: mpsc::Sender<QueryEvent>,
        cancellation: CancellationToken,
    ) -> Result<(), AppError> {
        validate_profile(profile)?;
        let arguments = parse_command(&request.sql)?;
        let command_name = String::from_utf8_lossy(&arguments[0]).to_ascii_uppercase();
        let query_id = request.query_id;

        let mut stream = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                send_event(&events, QueryEvent::Canceled { query_id }).await?;
                return Ok(());
            }
            result = timeout(CONNECTION_TIMEOUT, connect_and_prepare(profile, &password)) => {
                result.map_err(|_| timeout_error("Redis connection timed out"))??
            }
        };

        send_event(&events, QueryEvent::Started { query_id }).await?;
        let argument_refs = arguments.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                send_event(&events, QueryEvent::Canceled { query_id }).await?;
                return Ok(());
            }
            result = send_command(&mut stream, &argument_refs) => result?,
        };
        if let RespValue::Error(details) = response {
            return Err(query_error(details));
        }

        let (columns, rows) = response_table(&command_name, response);
        send_event(&events, QueryEvent::Schema { query_id, columns }).await?;
        if !rows.is_empty() {
            send_event(&events, QueryEvent::Batch { query_id, rows }).await?;
        }
        send_event(
            &events,
            QueryEvent::Completed {
                query_id,
                affected_rows: 0,
            },
        )
        .await
    }
}

/// Validates the connection fields supported by the current Redis transport.
fn validate_profile(profile: &ConnectionProfile) -> Result<(), AppError> {
    if !matches!(profile.engine, Engine::Redis) {
        return Err(validation_error("Connection profile is not Redis"));
    }
    if !matches!(profile.tls_mode, TlsMode::Disabled) {
        return Err(validation_error(
            "Redis TLS is not supported in this version",
        ));
    }
    if let Some(database) = profile.database.as_deref() {
        database
            .parse::<u32>()
            .map_err(|_| validation_error("Redis database must be a non-negative number"))?;
    }
    Ok(())
}

/// Performs the ordered AUTH, SELECT, and PING handshake on one Redis connection.
async fn test_redis_connection(
    profile: &ConnectionProfile,
    password: &SecretString,
) -> Result<(), AppError> {
    let mut stream = connect_and_prepare(profile, password).await?;
    match send_text_command(&mut stream, &["PING"]).await? {
        RespValue::Simple(response) if response == "PONG" => Ok(()),
        RespValue::Error(_) => Err(AppError {
            code: AppErrorCode::Connection,
            message: "Redis rejected PING".into(),
            technical_details: None,
            retryable: false,
        }),
        _ => Err(AppError {
            code: AppErrorCode::Connection,
            message: "Redis did not return PONG".into(),
            technical_details: None,
            retryable: false,
        }),
    }
}

/// Opens and initializes one connection without retaining the supplied credential.
async fn connect_and_prepare(
    profile: &ConnectionProfile,
    password: &SecretString,
) -> Result<BufReader<TcpStream>, AppError> {
    let stream = TcpStream::connect((profile.host.as_str(), profile.port))
        .await
        .map_err(connection_error)?;
    let mut stream = BufReader::new(stream);

    if !password.expose_secret().is_empty() {
        let mut arguments = vec![b"AUTH".as_slice()];
        if !profile.username.is_empty() {
            arguments.push(profile.username.as_bytes());
        }
        arguments.push(password.expose_secret().as_bytes());
        if matches!(
            send_command(&mut stream, &arguments).await?,
            RespValue::Error(_)
        ) {
            return Err(AppError {
                code: AppErrorCode::Authentication,
                message: "Redis authentication failed".into(),
                technical_details: None,
                retryable: false,
            });
        }
    }

    if let Some(database) = profile.database.as_deref() {
        if matches!(
            send_text_command(&mut stream, &["SELECT", database]).await?,
            RespValue::Error(_)
        ) {
            return Err(AppError {
                code: AppErrorCode::Connection,
                message: "Redis rejected the selected database".into(),
                technical_details: None,
                retryable: false,
            });
        }
    }
    Ok(stream)
}

/// Writes one UTF-8 command and reads exactly one protocol response.
async fn send_text_command(
    stream: &mut BufReader<TcpStream>,
    arguments: &[&str],
) -> Result<RespValue, AppError> {
    let arguments = arguments
        .iter()
        .map(|argument| argument.as_bytes())
        .collect::<Vec<_>>();
    send_command(stream, &arguments).await
}

/// Writes one binary-safe RESP command and reads exactly one bounded response.
async fn send_command(
    stream: &mut BufReader<TcpStream>,
    arguments: &[&[u8]],
) -> Result<RespValue, AppError> {
    let request = encode_command(arguments);
    stream
        .get_mut()
        .write_all(&request)
        .await
        .map_err(connection_error)?;
    let mut remaining = MAX_RESPONSE_BYTES;
    read_response(stream, &mut remaining, 0).await
}

/// Encodes one command as a binary-safe RESP array.
fn encode_command(arguments: &[&[u8]]) -> Vec<u8> {
    let mut request = format!("*{}\r\n", arguments.len()).into_bytes();
    for argument in arguments {
        request.extend_from_slice(format!("${}\r\n", argument.len()).as_bytes());
        request.extend_from_slice(argument);
        request.extend_from_slice(b"\r\n");
    }
    request
}

/// Reads one RESP2/RESP3 value recursively while enforcing response size and depth limits.
fn read_response<'a>(
    stream: &'a mut BufReader<TcpStream>,
    remaining: &'a mut usize,
    depth: usize,
) -> Pin<Box<dyn Future<Output = Result<RespValue, AppError>> + Send + 'a>> {
    Box::pin(async move {
        if depth > MAX_RESPONSE_DEPTH {
            return Err(protocol_error("Redis response nesting is too deep"));
        }
        let line = read_protocol_line(stream, remaining).await?;
        let (&prefix, payload) = line
            .split_first()
            .ok_or_else(|| protocol_error("Redis returned an empty response"))?;
        let payload_text = || {
            std::str::from_utf8(payload)
                .map(str::to_owned)
                .map_err(|_| protocol_error("Redis returned invalid response text"))
        };

        match prefix {
            b'+' => Ok(RespValue::Simple(payload_text()?)),
            b'-' => Ok(RespValue::Error(payload_text()?)),
            b':' => Ok(RespValue::Integer(parse_integer_text(payload)?)),
            b',' => Ok(RespValue::Double(payload_text()?)),
            b'(' => Ok(RespValue::BigNumber(parse_integer_text(payload)?)),
            b'#' => match payload {
                b"t" => Ok(RespValue::Boolean(true)),
                b"f" => Ok(RespValue::Boolean(false)),
                _ => Err(protocol_error("Redis returned an invalid boolean")),
            },
            b'_' if payload.is_empty() => Ok(RespValue::Null),
            b'$' | b'!' | b'=' => {
                let length = parse_length(payload)?;
                if length == -1 {
                    return Ok(RespValue::Bulk(None));
                }
                let bytes = read_protocol_bytes(stream, remaining, length as usize).await?;
                if prefix == b'!' {
                    Ok(RespValue::Error(
                        String::from_utf8_lossy(&bytes).into_owned(),
                    ))
                } else if prefix == b'=' {
                    Ok(RespValue::Verbatim(bytes))
                } else {
                    Ok(RespValue::Bulk(Some(bytes)))
                }
            }
            b'*' | b'~' | b'>' => {
                let length = parse_length(payload)?;
                if length == -1 {
                    return Ok(RespValue::Array(None));
                }
                let values = read_collection(stream, remaining, depth + 1, length as usize).await?;
                if prefix == b'~' {
                    Ok(RespValue::Set(values))
                } else {
                    Ok(RespValue::Array(Some(values)))
                }
            }
            b'%' | b'|' => {
                let length = parse_length(payload)?;
                if length < 0 {
                    return Err(protocol_error("Redis returned an invalid map length"));
                }
                let pair_count = length as usize;
                if pair_count > MAX_COLLECTION_ELEMENTS {
                    return Err(protocol_error("Redis response contains too many elements"));
                }
                // The server controls `pair_count`; cap eager allocation so nested collection
                // headers cannot force large allocations before consuming response bytes.
                let mut entries = Vec::with_capacity(bounded_collection_capacity(pair_count));
                for _ in 0..pair_count {
                    let key = read_response(stream, remaining, depth + 1).await?;
                    let value = read_response(stream, remaining, depth + 1).await?;
                    entries.push((key, value));
                }
                if prefix == b'|' {
                    read_response(stream, remaining, depth + 1).await
                } else {
                    Ok(RespValue::Map(entries))
                }
            }
            _ => Err(protocol_error(
                "Redis returned an unsupported response type",
            )),
        }
    })
}

/// Reads a fixed-size RESP collection using the shared response budget.
async fn read_collection(
    stream: &mut BufReader<TcpStream>,
    remaining: &mut usize,
    depth: usize,
    length: usize,
) -> Result<Vec<RespValue>, AppError> {
    if length > MAX_COLLECTION_ELEMENTS {
        return Err(protocol_error("Redis response contains too many elements"));
    }
    // Keep eager allocation bounded until the response budget is consumed by actual values.
    let mut values = Vec::with_capacity(bounded_collection_capacity(length));
    for _ in 0..length {
        values.push(read_response(stream, remaining, depth).await?);
    }
    Ok(values)
}

/// Caps eager allocation independently from the server-declared collection length.
fn bounded_collection_capacity(length: usize) -> usize {
    length.min(MAX_PREALLOCATED_COLLECTION_ELEMENTS)
}

/// Reads one CRLF-terminated protocol line and removes its delimiter.
async fn read_protocol_line(
    stream: &mut BufReader<TcpStream>,
    remaining: &mut usize,
) -> Result<Vec<u8>, AppError> {
    let mut line = Vec::new();
    stream
        .read_until(b'\n', &mut line)
        .await
        .map_err(connection_error)?;
    if line.len() < 3
        || line.len() > MAX_RESPONSE_LINE_BYTES
        || line.len() > *remaining
        || !line.ends_with(b"\r\n")
    {
        return Err(protocol_error("Redis returned an invalid response line"));
    }
    *remaining -= line.len();
    line.truncate(line.len() - 2);
    Ok(line)
}

/// Reads one bulk payload plus its required trailing CRLF.
async fn read_protocol_bytes(
    stream: &mut BufReader<TcpStream>,
    remaining: &mut usize,
    length: usize,
) -> Result<Vec<u8>, AppError> {
    let framed_length = length
        .checked_add(2)
        .ok_or_else(|| protocol_error("Redis response length overflowed"))?;
    if framed_length > *remaining {
        return Err(protocol_error("Redis response exceeded the size limit"));
    }
    let mut framed = vec![0; framed_length];
    stream
        .read_exact(&mut framed)
        .await
        .map_err(connection_error)?;
    if !framed.ends_with(b"\r\n") {
        return Err(protocol_error("Redis returned an invalid bulk response"));
    }
    *remaining -= framed_length;
    framed.truncate(length);
    Ok(framed)
}

/// Parses a protocol collection or bulk length with Redis null semantics.
fn parse_length(payload: &[u8]) -> Result<i64, AppError> {
    let value = std::str::from_utf8(payload)
        .map_err(|_| protocol_error("Redis returned an invalid response length"))?
        .parse::<i64>()
        .map_err(|_| protocol_error("Redis returned an invalid response length"))?;
    if value < -1 {
        return Err(protocol_error("Redis returned an invalid negative length"));
    }
    Ok(value)
}

/// Validates and preserves an arbitrary-precision protocol integer as text.
fn parse_integer_text(payload: &[u8]) -> Result<String, AppError> {
    let value = std::str::from_utf8(payload)
        .map_err(|_| protocol_error("Redis returned an invalid integer"))?;
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(protocol_error("Redis returned an invalid integer"));
    }
    Ok(value.to_owned())
}

/// Tokenizes one redis-cli-style command with quoted and escaped arguments.
fn parse_command(command: &str) -> Result<Vec<Vec<u8>>, AppError> {
    if command.len() > MAX_COMMAND_BYTES {
        return Err(validation_error("Redis command is too large"));
    }
    let mut arguments = Vec::new();
    let mut argument = Vec::new();
    let mut quote = None;
    let mut started = false;
    let mut characters = command.chars().peekable();

    while let Some(character) = characters.next() {
        if quote.is_none() && character.is_whitespace() {
            if started {
                arguments.push(std::mem::take(&mut argument));
                started = false;
            }
            continue;
        }
        if character == '\'' || character == '"' {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
                started = true;
            } else {
                push_character(&mut argument, character);
            }
            continue;
        }
        if character == '\\' {
            started = true;
            let escaped = characters
                .next()
                .ok_or_else(|| validation_error("Redis command ends with an incomplete escape"))?;
            if escaped == 'x' {
                let high = characters.next().ok_or_else(|| {
                    validation_error("Redis command contains an invalid hex escape")
                })?;
                let low = characters.next().ok_or_else(|| {
                    validation_error("Redis command contains an invalid hex escape")
                })?;
                let hex = [high, low].iter().collect::<String>();
                argument.push(u8::from_str_radix(&hex, 16).map_err(|_| {
                    validation_error("Redis command contains an invalid hex escape")
                })?);
            } else {
                push_character(
                    &mut argument,
                    match escaped {
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        other => other,
                    },
                );
            }
            continue;
        }
        started = true;
        push_character(&mut argument, character);
    }

    if quote.is_some() {
        return Err(validation_error(
            "Redis command contains an unterminated quote",
        ));
    }
    if started {
        arguments.push(argument);
    }
    if arguments.is_empty() {
        return Err(validation_error("Redis command cannot be empty"));
    }
    Ok(arguments)
}

/// Appends one Unicode scalar using its UTF-8 representation.
fn push_character(target: &mut Vec<u8>, character: char) {
    let mut bytes = [0; 4];
    target.extend_from_slice(character.encode_utf8(&mut bytes).as_bytes());
}

/// Converts a Redis response into columns and rows understood by the shared result grid.
fn response_table(
    command_name: &str,
    response: RespValue,
) -> (Vec<QueryColumn>, Vec<Vec<CellValue>>) {
    if matches!(command_name, "SCAN" | "SSCAN" | "HSCAN" | "ZSCAN") {
        if let Some(table) = scan_response_table(command_name, response.clone()) {
            return table;
        }
    }
    if command_name == "HGETALL" {
        if let RespValue::Array(Some(values)) = response {
            return paired_response_table("field", "value", values);
        }
    }

    match response {
        RespValue::Array(Some(values)) | RespValue::Set(values) => {
            let columns = vec![
                result_column("index", "REDIS INDEX"),
                result_column("value", "REDIS VALUE"),
            ];
            let rows = values
                .into_iter()
                .enumerate()
                .map(|(index, value)| {
                    vec![CellValue::Integer(index.to_string()), response_cell(value)]
                })
                .collect();
            (columns, rows)
        }
        value => (
            vec![result_column("value", "REDIS VALUE")],
            vec![vec![response_cell(value)]],
        ),
    }
}

/// Formats cursor-based SCAN replies into stable key/member/field rows.
fn scan_response_table(
    command_name: &str,
    response: RespValue,
) -> Option<(Vec<QueryColumn>, Vec<Vec<CellValue>>)> {
    let RespValue::Array(Some(mut outer)) = response else {
        return None;
    };
    if outer.len() != 2 {
        return None;
    }
    let values = match outer.pop()? {
        RespValue::Array(Some(values)) => values,
        _ => return None,
    };
    let cursor = response_cell(outer.pop()?);
    match command_name {
        "SCAN" => Some(single_scan_table("key", cursor, values)),
        "SSCAN" => Some(single_scan_table("member", cursor, values)),
        "HSCAN" => Some(paired_scan_table("field", "value", cursor, values)),
        "ZSCAN" => Some(paired_scan_table("member", "score", cursor, values)),
        _ => None,
    }
}

/// Builds one cursor plus item table for SCAN or SSCAN.
fn single_scan_table(
    item_name: &str,
    cursor: CellValue,
    values: Vec<RespValue>,
) -> (Vec<QueryColumn>, Vec<Vec<CellValue>>) {
    let columns = vec![
        result_column("cursor", "REDIS CURSOR"),
        result_column(item_name, "REDIS VALUE"),
    ];
    let rows = if values.is_empty() {
        vec![vec![cursor, CellValue::Null]]
    } else {
        values
            .into_iter()
            .map(|value| vec![cursor.clone(), response_cell(value)])
            .collect()
    };
    (columns, rows)
}

/// Builds one cursor plus pair table for HSCAN or ZSCAN.
fn paired_scan_table(
    first_name: &str,
    second_name: &str,
    cursor: CellValue,
    values: Vec<RespValue>,
) -> (Vec<QueryColumn>, Vec<Vec<CellValue>>) {
    let columns = vec![
        result_column("cursor", "REDIS CURSOR"),
        result_column(first_name, "REDIS VALUE"),
        result_column(second_name, "REDIS VALUE"),
    ];
    let mut rows = Vec::new();
    let mut values = values.into_iter();
    while let Some(first) = values.next() {
        rows.push(vec![
            cursor.clone(),
            response_cell(first),
            values.next().map(response_cell).unwrap_or(CellValue::Null),
        ]);
    }
    if rows.is_empty() {
        rows.push(vec![cursor, CellValue::Null, CellValue::Null]);
    }
    (columns, rows)
}

/// Builds a two-column table from alternating field/value response entries.
fn paired_response_table(
    first_name: &str,
    second_name: &str,
    values: Vec<RespValue>,
) -> (Vec<QueryColumn>, Vec<Vec<CellValue>>) {
    let columns = vec![
        result_column(first_name, "REDIS VALUE"),
        result_column(second_name, "REDIS VALUE"),
    ];
    let mut rows = Vec::new();
    let mut values = values.into_iter();
    while let Some(first) = values.next() {
        rows.push(vec![
            response_cell(first),
            values.next().map(response_cell).unwrap_or(CellValue::Null),
        ]);
    }
    (columns, rows)
}

/// Creates one shared result column for a Redis-native value.
fn result_column(name: &str, database_type: &str) -> QueryColumn {
    QueryColumn {
        name: name.to_owned(),
        database_type: database_type.to_owned(),
        nullable: None,
    }
}

/// Converts a protocol value into one lossless transport-safe result cell.
fn response_cell(value: RespValue) -> CellValue {
    match value {
        RespValue::Simple(value) => CellValue::Text(value),
        RespValue::Error(value) => CellValue::Text(value),
        RespValue::Integer(value) | RespValue::BigNumber(value) => CellValue::Integer(value),
        RespValue::Bulk(None) | RespValue::Array(None) | RespValue::Null => CellValue::Null,
        RespValue::Bulk(Some(value)) | RespValue::Verbatim(value) => bytes_cell(value),
        RespValue::Array(Some(values)) | RespValue::Set(values) => CellValue::Json(
            JsonValue::Array(values.into_iter().map(response_json).collect()),
        ),
        RespValue::Boolean(value) => CellValue::Boolean(value),
        RespValue::Double(value) => value
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(CellValue::Float)
            .unwrap_or(CellValue::Text(value)),
        RespValue::Map(entries) => CellValue::Json(map_json(entries)),
    }
}

/// Converts one byte payload to UTF-8 text or explicit base64 binary.
fn bytes_cell(value: Vec<u8>) -> CellValue {
    match String::from_utf8(value) {
        Ok(text) => CellValue::Text(text),
        Err(error) => CellValue::Binary(STANDARD.encode(error.into_bytes())),
    }
}

/// Converts nested protocol values into JSON for grid display and export.
fn response_json(value: RespValue) -> JsonValue {
    match value {
        RespValue::Simple(value)
        | RespValue::Error(value)
        | RespValue::Integer(value)
        | RespValue::BigNumber(value)
        | RespValue::Double(value) => JsonValue::String(value),
        RespValue::Bulk(None) | RespValue::Array(None) | RespValue::Null => JsonValue::Null,
        RespValue::Bulk(Some(value)) | RespValue::Verbatim(value) => match String::from_utf8(value)
        {
            Ok(text) => JsonValue::String(text),
            Err(error) => {
                JsonValue::String(format!("base64:{}", STANDARD.encode(error.into_bytes())))
            }
        },
        RespValue::Array(Some(values)) | RespValue::Set(values) => {
            JsonValue::Array(values.into_iter().map(response_json).collect())
        }
        RespValue::Boolean(value) => JsonValue::Bool(value),
        RespValue::Map(entries) => map_json(entries),
    }
}

/// Converts a protocol map into a JSON object when keys are textual, or entry pairs otherwise.
fn map_json(entries: Vec<(RespValue, RespValue)>) -> JsonValue {
    let mut object = JsonMap::new();
    let mut pairs = Vec::new();
    let mut all_text_keys = true;
    for (key, value) in entries {
        let key = response_json(key);
        let value = response_json(value);
        if let JsonValue::String(key) = &key {
            object.insert(key.clone(), value.clone());
        } else {
            all_text_keys = false;
        }
        pairs.push(JsonValue::Array(vec![key, value]));
    }
    if all_text_keys {
        JsonValue::Object(object)
    } else {
        JsonValue::Array(pairs)
    }
}

/// Sends one event and maps a closed frontend channel to cancellation.
async fn send_event(events: &mpsc::Sender<QueryEvent>, event: QueryEvent) -> Result<(), AppError> {
    events.send(event).await.map_err(|_| AppError {
        code: AppErrorCode::Canceled,
        message: "Redis command result receiver was closed".into(),
        technical_details: None,
        retryable: false,
    })
}

/// Maps socket errors into a stable retryable connection error.
fn connection_error(error: std::io::Error) -> AppError {
    AppError {
        code: AppErrorCode::Connection,
        message: "Could not communicate with Redis".into(),
        technical_details: Some(error.to_string()),
        retryable: true,
    }
}

/// Creates a non-retryable protocol error without including response content.
fn protocol_error(message: &'static str) -> AppError {
    AppError {
        code: AppErrorCode::Connection,
        message: message.into(),
        technical_details: None,
        retryable: false,
    }
}

/// Creates a non-retryable validation error.
fn validation_error(message: &'static str) -> AppError {
    AppError {
        code: AppErrorCode::Validation,
        message: message.into(),
        technical_details: None,
        retryable: false,
    }
}

/// Creates a retryable timeout error.
fn timeout_error(message: &'static str) -> AppError {
    AppError {
        code: AppErrorCode::Timeout,
        message: message.into(),
        technical_details: None,
        retryable: true,
    }
}

/// Maps a server command error while preserving only server-provided diagnostics.
fn query_error(details: String) -> AppError {
    AppError {
        code: AppErrorCode::Query,
        message: "Redis command failed".into(),
        technical_details: Some(details),
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
            (command(&["SELECT", "2"]), b"+OK\r\n".to_vec()),
            (command(&["PING"]), b"+PONG\r\n".to_vec()),
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
            command(&["AUTH", "pipa", password]),
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

    /// Verifies quoted arguments, empty strings, Unicode, and hex escapes use redis-cli semantics.
    #[test]
    fn command_parser_preserves_quoted_arguments() {
        assert_eq!(
            parse_command(r#"SET "用户 key" 'hello world' NX"#).unwrap(),
            vec![
                b"SET".to_vec(),
                "用户 key".as_bytes().to_vec(),
                b"hello world".to_vec(),
                b"NX".to_vec(),
            ]
        );
        assert_eq!(
            parse_command(r#"SET empty "" \x41"#).unwrap(),
            vec![
                b"SET".to_vec(),
                b"empty".to_vec(),
                Vec::new(),
                b"A".to_vec()
            ]
        );
        assert!(parse_command("GET 'unfinished").is_err());
    }

    /// Verifies native commands emit a stable scalar result through the shared query contract.
    #[tokio::test]
    async fn query_emits_scalar_response_events() {
        let exchanges = vec![
            (command(&["SELECT", "0"]), b"+OK\r\n".to_vec()),
            (command(&["GET", "greeting"]), b"$5\r\nhello\r\n".to_vec()),
        ];
        let (port, server) = spawn_redis_server(exchanges).await;
        let profile = test_profile(port, "", Some("0"));
        let request = QueryRequest {
            query_id: Uuid::new_v4(),
            connection_id: profile.id,
            sql: "GET greeting".into(),
            database: None,
        };
        let query_id = request.query_id;
        let (events, mut receiver) = mpsc::channel(8);

        RedisAdapter::new()
            .query(
                &profile,
                SecretString::from(""),
                request,
                events,
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert!(matches!(
            receiver.recv().await,
            Some(QueryEvent::Started { query_id: id }) if id == query_id
        ));
        assert!(matches!(
            receiver.recv().await,
            Some(QueryEvent::Schema { columns, .. }) if columns[0].name == "value"
        ));
        assert!(matches!(
            receiver.recv().await,
            Some(QueryEvent::Batch { rows, .. })
                if matches!(rows.as_slice(), [row]
                    if matches!(row.as_slice(), [CellValue::Text(value)] if value == "hello"))
        ));
        assert!(matches!(
            receiver.recv().await,
            Some(QueryEvent::Completed { query_id: id, .. }) if id == query_id
        ));
        server.await.expect("mock Redis server should finish");
    }

    /// Verifies SCAN replies expose cursor and key columns for key browsing and export.
    #[test]
    fn scan_response_is_formatted_as_key_rows() {
        let response = RespValue::Array(Some(vec![
            RespValue::Bulk(Some(b"17".to_vec())),
            RespValue::Array(Some(vec![
                RespValue::Bulk(Some(b"user:1".to_vec())),
                RespValue::Bulk(Some(b"user:2".to_vec())),
            ])),
        ]));

        let (columns, rows) = response_table("SCAN", response);

        assert_eq!(
            columns
                .iter()
                .map(|column| column.name.as_str())
                .collect::<Vec<_>>(),
            vec!["cursor", "key"]
        );
        assert_eq!(rows.len(), 2);
        assert!(matches!(&rows[0][0], CellValue::Text(value) if value == "17"));
        assert!(matches!(&rows[0][1], CellValue::Text(value) if value == "user:1"));
    }

    /// Verifies untrusted RESP collection lengths cannot force proportional eager allocation.
    #[test]
    fn collection_preallocation_is_bounded() {
        assert_eq!(
            bounded_collection_capacity(MAX_COLLECTION_ELEMENTS),
            MAX_PREALLOCATED_COLLECTION_ELEMENTS
        );
        assert_eq!(bounded_collection_capacity(12), 12);
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

    /// Encodes one test command through the production binary-safe encoder.
    fn command(arguments: &[&str]) -> Vec<u8> {
        let arguments = arguments
            .iter()
            .map(|argument| argument.as_bytes())
            .collect::<Vec<_>>();
        encode_command(&arguments)
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
