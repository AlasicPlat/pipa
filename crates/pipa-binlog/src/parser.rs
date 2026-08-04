use crate::assembler::{EventLocation, TransactionAssembler};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use mysql_common::{
    binlog::{
        consts::{BinlogChecksumAlg, BinlogVersion},
        events::{
            Event, EventData, OptionalMetaExtractor, RowsEventData, TableMapEvent,
            TransactionPayloadReader,
        },
        row::BinlogRow,
        value::BinlogValue,
        BinlogFileHeader, EventStreamReader,
    },
    collations::{Collation, CollationId},
    constants::ColumnType,
    packets::Column,
    value::Value,
};
use pipa_core::{
    BinlogAnalysisStatus, BinlogCell, BinlogChange, BinlogDiagnostic, BinlogDiagnosticSeverity,
    BinlogFileSummary, BinlogOperation, BinlogRowChange, BinlogSummary, BinlogTableConfidence,
    BinlogTableSummary, BinlogTransaction, CellValue,
};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, BufRead, BufReader, Cursor, Read, Seek},
    panic::{catch_unwind, AssertUnwindSafe},
    path::Path,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const EVENT_HEADER_LENGTH: usize = 19;
const EVENT_SIZE_OFFSET: usize = 9;
const MAX_EVENT_SIZE_BYTES: usize = 256 * 1024 * 1024;
const MAX_DECOMPRESSED_PAYLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_DECOMPRESSED_PAYLOAD_EVENTS: u64 = 1_000_000;
const MAX_TRANSACTION_PAYLOAD_DEPTH: usize = 8;
const PROGRESS_BYTE_INTERVAL: u64 = 1024 * 1024;
const PROGRESS_EVENT_INTERVAL: u64 = 256;
const MAX_DIAGNOSTICS: usize = 1_000;

/// Progress snapshot emitted at bounded physical input intervals.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BinlogProgress {
    /// Bytes consumed across completed files and the current event boundary.
    pub bytes_read: u64,
    /// Total bytes captured before parsing.
    pub total_bytes: u64,
    /// Total input file count.
    pub file_count: u32,
    /// Number of files that reached a clean end.
    pub files_completed: u32,
    /// Basename of the file currently being read.
    pub current_file: Option<String>,
    /// Number of transactions committed or closed as incomplete so far.
    pub transaction_count: u64,
    /// Physical and decompressed logical events parsed so far.
    pub event_count: u64,
}

/// Safe terminal failure returned by the streaming parser.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct BinlogImportFailure {
    /// Stable failure identifier.
    pub code: String,
    /// User-facing message that excludes row values.
    pub message: String,
    /// Optional redacted technical context.
    pub technical_details: Option<String>,
    /// Whether retrying unchanged input may succeed.
    pub retryable: bool,
    /// Coordinate-rich diagnostic retained with the partial analysis.
    pub diagnostic: Box<BinlogDiagnostic>,
}

/// Terminal state returned alongside every complete or partial analysis.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BinlogImportTerminal {
    /// Every input file reached a clean end.
    Completed,
    /// A cancellation token was observed at an event boundary.
    Canceled,
    /// Parsing stopped at a safe, located failure.
    Failed(BinlogImportFailure),
}

/// Parser output stored atomically by the application repository.
#[derive(Clone, Debug)]
pub struct BinlogAnalysisOutput {
    /// Aggregate state and diagnostics.
    pub summary: BinlogSummary,
    /// Assembled transactions in authoritative file-position order.
    pub transactions: Vec<BinlogTransaction>,
    /// Terminal outcome used to choose the final channel event.
    pub terminal: BinlogImportTerminal,
}

/// Validates selected paths and captures stable file sizes before background parsing.
///
/// # Parameters
/// `paths` are user-selected local file paths in authoritative order.
///
/// # Returns
/// Ordered file metadata or a safe validation/I/O failure.
///
/// # Side effects
/// Reads filesystem metadata but does not open or parse file contents.
pub fn inspect_files(paths: &[String]) -> Result<Vec<BinlogFileSummary>, BinlogImportFailure> {
    if paths.is_empty() {
        return Err(failure(
            "no_input_files",
            "Select at least one MySQL binlog file",
            None,
            None,
            None,
            false,
        ));
    }
    if paths.len() > u32::MAX as usize {
        return Err(failure(
            "too_many_input_files",
            "Too many binlog files were selected",
            None,
            None,
            None,
            false,
        ));
    }

    paths
        .iter()
        .map(|path| {
            let file_name = file_name(path);
            let metadata = std::fs::metadata(path).map_err(|error| {
                failure(
                    "file_metadata_failed",
                    "Could not inspect a selected binlog file",
                    Some(error.to_string()),
                    Some(file_name.clone()),
                    None,
                    error.kind() == io::ErrorKind::Interrupted,
                )
            })?;
            if !metadata.is_file() {
                return Err(failure(
                    "input_is_not_file",
                    "A selected binlog path is not a regular file",
                    None,
                    Some(file_name),
                    None,
                    false,
                ));
            }
            Ok(BinlogFileSummary {
                path: path.clone(),
                size_bytes: metadata.len(),
            })
        })
        .collect()
}

/// Builds the parsing-state summary registered before the background task starts.
///
/// # Parameters
/// `analysis_id` identifies the session, `files` are preflighted inputs, and `started_at`
/// is an RFC 3339 application timestamp.
///
/// # Returns
/// An empty parsing summary.
pub fn initial_summary(
    analysis_id: Uuid,
    files: Vec<BinlogFileSummary>,
    started_at: String,
) -> BinlogSummary {
    BinlogSummary {
        analysis_id,
        files,
        status: BinlogAnalysisStatus::Partial,
        started_at,
        ended_at: None,
        first_event_at: None,
        last_event_at: None,
        transaction_count: 0,
        event_count: 0,
        row_change_count: 0,
        tables: Vec::new(),
        diagnostics: Vec::new(),
    }
}

/// Streams ordered MySQL binlog-v4 files into one transaction timeline.
///
/// # Parameters
/// `analysis_id` is stable across IPC calls, `files` are preflighted ordered inputs,
/// `started_at` is copied into the summary, `cancellation` is checked at every event
/// boundary, and `on_progress` receives rate-bounded snapshots.
///
/// # Returns
/// A terminal output containing complete or safely partial results.
///
/// # Side effects
/// Opens and reads local files. Row values are retained only in the returned analysis and
/// are never logged.
pub fn analyze_files(
    analysis_id: Uuid,
    files: Vec<BinlogFileSummary>,
    started_at: String,
    cancellation: &CancellationToken,
    mut on_progress: impl FnMut(BinlogProgress),
) -> BinlogAnalysisOutput {
    let total_bytes = files.iter().map(|file| file.size_bytes).sum();
    let file_count = files.len() as u32;
    let mut state = ParserState::new(analysis_id);
    let mut completed_bytes = 0_u64;
    let mut files_completed = 0_u32;
    let mut last_progress_bytes = 0_u64;
    let mut last_progress_events = 0_u64;
    let mut terminal = BinlogImportTerminal::Completed;

    'files: for file in &files {
        let current_file = file_name(&file.path);
        if cancellation.is_cancelled() {
            terminal = BinlogImportTerminal::Canceled;
            break;
        }
        let input = match File::open(&file.path) {
            Ok(input) => input,
            Err(error) => {
                terminal = BinlogImportTerminal::Failed(failure(
                    "file_open_failed",
                    "Could not open a selected binlog file",
                    Some(error.to_string()),
                    Some(current_file.clone()),
                    None,
                    error.kind() == io::ErrorKind::Interrupted,
                ));
                break;
            }
        };
        let mut input = BufReader::new(input);
        if let Err(error) = read_file_header(&mut input, &current_file) {
            terminal = BinlogImportTerminal::Failed(error);
            break;
        }
        let mut reader = EventStreamReader::new(BinlogVersion::Version4);

        loop {
            if cancellation.is_cancelled() {
                terminal = BinlogImportTerminal::Canceled;
                break 'files;
            }
            let start_position = match input.stream_position() {
                Ok(position) => position,
                Err(error) => {
                    terminal = BinlogImportTerminal::Failed(io_failure(
                        "file_position_failed",
                        "Could not determine the binlog read position",
                        error,
                        &current_file,
                        None,
                    ));
                    break 'files;
                }
            };
            let frame = match read_event_frame(
                &mut input,
                Some(file.size_bytes),
                &current_file,
                start_position,
                MAX_EVENT_SIZE_BYTES,
            ) {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(error) => {
                    terminal = BinlogImportTerminal::Failed(error);
                    break 'files;
                }
            };
            let end_position = start_position + frame.len() as u64;
            let event =
                match parse_event_frame(&mut reader, frame, false, &current_file, start_position) {
                    Ok(event) => event,
                    Err(error) => {
                        terminal = BinlogImportTerminal::Failed(error);
                        break 'files;
                    }
                };
            state.event_count += 1;
            state.observe_timestamp(event.header().timestamp());
            let location = event_location(&event, &current_file, start_position, end_position);
            if let Err(error) =
                process_event(&mut reader, &event, &location, &mut state, cancellation)
            {
                terminal = BinlogImportTerminal::Failed(error);
                break 'files;
            }

            let bytes_read = completed_bytes + end_position;
            if bytes_read.saturating_sub(last_progress_bytes) >= PROGRESS_BYTE_INTERVAL
                || state.event_count.saturating_sub(last_progress_events) >= PROGRESS_EVENT_INTERVAL
            {
                on_progress(state.progress(
                    bytes_read,
                    total_bytes,
                    file_count,
                    files_completed,
                    Some(current_file.clone()),
                ));
                last_progress_bytes = bytes_read;
                last_progress_events = state.event_count;
            }
        }

        completed_bytes = completed_bytes.saturating_add(file.size_bytes);
        files_completed += 1;
        on_progress(state.progress(
            completed_bytes,
            total_bytes,
            file_count,
            files_completed,
            Some(current_file),
        ));
        last_progress_bytes = completed_bytes;
        last_progress_events = state.event_count;
    }

    if let BinlogImportTerminal::Failed(error) = &terminal {
        state.push_diagnostic(error.diagnostic.as_ref().clone());
    } else if matches!(terminal, BinlogImportTerminal::Canceled) {
        state.push_diagnostic(BinlogDiagnostic {
            code: "import_canceled".into(),
            message: "Binlog import was canceled".into(),
            severity: BinlogDiagnosticSeverity::Info,
            file_name: None,
            position: None,
        });
    }

    let assembler = std::mem::replace(&mut state.assembler, TransactionAssembler::new(analysis_id));
    let transactions = assembler.into_transactions();
    let status = match terminal {
        BinlogImportTerminal::Completed if state.diagnostics.is_empty() => {
            BinlogAnalysisStatus::Complete
        }
        BinlogImportTerminal::Completed => BinlogAnalysisStatus::Warning,
        BinlogImportTerminal::Canceled => BinlogAnalysisStatus::Partial,
        BinlogImportTerminal::Failed(_) => BinlogAnalysisStatus::Error,
    };
    let summary = build_summary(analysis_id, files, started_at, status, state, &transactions);

    BinlogAnalysisOutput {
        summary,
        transactions,
        terminal,
    }
}

/// Mutable parser-wide counters, diagnostics, and transaction assembly state.
struct ParserState {
    assembler: TransactionAssembler,
    event_count: u64,
    decompressed_payload_bytes: u64,
    decompressed_payload_events: u64,
    transaction_payload_depth: usize,
    first_timestamp: Option<u32>,
    last_timestamp: Option<u32>,
    diagnostics: Vec<BinlogDiagnostic>,
    diagnostics_truncated: bool,
}

impl ParserState {
    /// Creates empty parser state for one analysis.
    fn new(analysis_id: Uuid) -> Self {
        Self {
            assembler: TransactionAssembler::new(analysis_id),
            event_count: 0,
            decompressed_payload_bytes: 0,
            decompressed_payload_events: 0,
            transaction_payload_depth: 0,
            first_timestamp: None,
            last_timestamp: None,
            diagnostics: Vec::new(),
            diagnostics_truncated: false,
        }
    }

    /// Tracks the first and latest non-zero header timestamp in parse order.
    fn observe_timestamp(&mut self, timestamp: u32) {
        if timestamp == 0 {
            return;
        }
        self.first_timestamp.get_or_insert(timestamp);
        self.last_timestamp = Some(timestamp);
    }

    /// Enters one compressed payload after validating declared size and nesting depth.
    fn enter_transaction_payload(
        &mut self,
        declared_size: u64,
        location: &EventLocation,
    ) -> Result<(), BinlogImportFailure> {
        if self.transaction_payload_depth >= MAX_TRANSACTION_PAYLOAD_DEPTH {
            return Err(failure(
                "transaction_payload_too_deep",
                "Nested transaction payloads exceed the parser safety limit",
                Some(format!("limit {MAX_TRANSACTION_PAYLOAD_DEPTH}")),
                Some(location.file_name.clone()),
                Some(location.start_position),
                false,
            ));
        }
        let remaining =
            MAX_DECOMPRESSED_PAYLOAD_BYTES.saturating_sub(self.decompressed_payload_bytes);
        if declared_size > remaining {
            return Err(failure(
                "transaction_payload_too_large",
                "Decompressed transaction payload data exceeds the parser safety limit",
                Some(format!(
                    "declared {declared_size} bytes, remaining {remaining} bytes"
                )),
                Some(location.file_name.clone()),
                Some(location.start_position),
                false,
            ));
        }
        self.transaction_payload_depth += 1;
        Ok(())
    }

    /// Leaves the current compressed payload after success or failure.
    fn leave_transaction_payload(&mut self) {
        debug_assert!(self.transaction_payload_depth > 0);
        self.transaction_payload_depth = self.transaction_payload_depth.saturating_sub(1);
    }

    /// Accounts for one actual decompressed frame before it is parsed or recursed into.
    fn record_decompressed_event(
        &mut self,
        frame_size: usize,
        location: &EventLocation,
    ) -> Result<(), BinlogImportFailure> {
        if self.decompressed_payload_events >= MAX_DECOMPRESSED_PAYLOAD_EVENTS {
            return Err(failure(
                "transaction_payload_event_limit",
                "A transaction payload contains too many decompressed events",
                Some(format!("limit {MAX_DECOMPRESSED_PAYLOAD_EVENTS}")),
                Some(location.file_name.clone()),
                Some(location.start_position),
                false,
            ));
        }
        let total = self
            .decompressed_payload_bytes
            .checked_add(frame_size as u64)
            .ok_or_else(|| {
                failure(
                    "transaction_payload_too_large",
                    "Decompressed transaction payload data exceeds the parser safety limit",
                    None,
                    Some(location.file_name.clone()),
                    Some(location.start_position),
                    false,
                )
            })?;
        if total > MAX_DECOMPRESSED_PAYLOAD_BYTES {
            return Err(failure(
                "transaction_payload_too_large",
                "Decompressed transaction payload data exceeds the parser safety limit",
                Some(format!(
                    "decoded {total} bytes, limit {MAX_DECOMPRESSED_PAYLOAD_BYTES}"
                )),
                Some(location.file_name.clone()),
                Some(location.start_position),
                false,
            ));
        }
        self.decompressed_payload_bytes = total;
        self.decompressed_payload_events += 1;
        Ok(())
    }

    /// Retains diagnostics up to a fixed bound and records one explicit truncation warning.
    fn push_diagnostic(&mut self, diagnostic: BinlogDiagnostic) {
        if self.diagnostics.len() < MAX_DIAGNOSTICS {
            self.diagnostics.push(diagnostic);
        } else if !self.diagnostics_truncated {
            self.diagnostics_truncated = true;
            self.diagnostics.push(BinlogDiagnostic {
                code: "diagnostics_truncated".into(),
                message: "Additional parser diagnostics were omitted after the safety limit".into(),
                severity: BinlogDiagnosticSeverity::Warning,
                file_name: None,
                position: None,
            });
        }
    }

    /// Builds one bounded progress snapshot without cloning transaction row data.
    fn progress(
        &self,
        bytes_read: u64,
        total_bytes: u64,
        file_count: u32,
        files_completed: u32,
        current_file: Option<String>,
    ) -> BinlogProgress {
        BinlogProgress {
            bytes_read,
            total_bytes,
            file_count,
            files_completed,
            current_file,
            transaction_count: self.assembler.transaction_count(),
            event_count: self.event_count,
        }
    }
}

/// Reads and validates the four-byte binlog magic header.
fn read_file_header(input: &mut impl Read, file_name: &str) -> Result<(), BinlogImportFailure> {
    BinlogFileHeader::read(input).map(|_| ()).map_err(|error| {
        let (code, message) = if error.kind() == io::ErrorKind::UnexpectedEof {
            (
                "truncated_file_header",
                "The binlog file is truncated before its header is complete",
            )
        } else {
            (
                "invalid_file_header",
                "The selected file is not a supported MySQL binlog v4 file",
            )
        };
        failure(
            code,
            message,
            Some(error.to_string()),
            Some(file_name.to_owned()),
            Some(0),
            false,
        )
    })
}

/// Reads one complete event frame before invoking `mysql_common`.
///
/// This pre-framing prevents the dependency's current `read_exact(...).unwrap()` body path
/// from turning a truncated input into a process panic.
fn read_event_frame(
    input: &mut impl BufRead,
    file_size: Option<u64>,
    file_name: &str,
    position: u64,
    max_event_size: usize,
) -> Result<Option<Vec<u8>>, BinlogImportFailure> {
    if input
        .fill_buf()
        .map_err(|error| {
            io_failure(
                "event_read_failed",
                "Could not read the next binlog event",
                error,
                file_name,
                Some(position),
            )
        })?
        .is_empty()
    {
        return Ok(None);
    }

    if file_size.is_some_and(|size| size.saturating_sub(position) < EVENT_HEADER_LENGTH as u64) {
        return Err(failure(
            "truncated_event_header",
            "The binlog ends inside an event header",
            None,
            Some(file_name.to_owned()),
            Some(position),
            false,
        ));
    }
    let mut header = [0_u8; EVENT_HEADER_LENGTH];
    input.read_exact(&mut header).map_err(|error| {
        io_failure(
            "truncated_event_header",
            "The binlog ends inside an event header",
            error,
            file_name,
            Some(position),
        )
    })?;
    let event_size = u32::from_le_bytes(
        header[EVENT_SIZE_OFFSET..EVENT_SIZE_OFFSET + 4]
            .try_into()
            .expect("event-size slice has a fixed length"),
    ) as usize;
    if event_size < EVENT_HEADER_LENGTH {
        return Err(failure(
            "invalid_event_size",
            "A binlog event declares an invalid size",
            Some(format!("declared event size {event_size}")),
            Some(file_name.to_owned()),
            Some(position),
            false,
        ));
    }
    if event_size > max_event_size {
        let (code, message) = if max_event_size < MAX_EVENT_SIZE_BYTES {
            (
                "transaction_payload_too_large",
                "Decompressed transaction payload data exceeds the parser safety limit",
            )
        } else {
            (
                "event_too_large",
                "A binlog event exceeds the parser safety limit",
            )
        };
        return Err(failure(
            code,
            message,
            Some(format!(
                "declared event size {event_size}, remaining limit {max_event_size}"
            )),
            Some(file_name.to_owned()),
            Some(position),
            false,
        ));
    }
    if file_size.is_some_and(|size| position.saturating_add(event_size as u64) > size) {
        return Err(failure(
            "truncated_event_body",
            "The binlog ends inside an event body",
            Some(format!("declared event size {event_size}")),
            Some(file_name.to_owned()),
            Some(position),
            false,
        ));
    }

    let mut frame = vec![0_u8; event_size];
    frame[..EVENT_HEADER_LENGTH].copy_from_slice(&header);
    input
        .read_exact(&mut frame[EVENT_HEADER_LENGTH..])
        .map_err(|error| {
            io_failure(
                "truncated_event_body",
                "The binlog ends inside an event body",
                error,
                file_name,
                Some(position),
            )
        })?;
    Ok(Some(frame))
}

/// Parses one pre-framed event and verifies regular-file CRC32 checksums.
fn parse_event_frame(
    reader: &mut EventStreamReader,
    frame: Vec<u8>,
    decompressed: bool,
    file_name: &str,
    position: u64,
) -> Result<Event, BinlogImportFailure> {
    let parsed = catch_unwind(AssertUnwindSafe(|| {
        if decompressed {
            reader.read_decompressed(Cursor::new(frame))
        } else {
            reader.read(Cursor::new(frame))
        }
    }))
    .map_err(|_| {
        failure(
            "parser_panicked",
            "The binlog event triggered an internal parser failure",
            None,
            Some(file_name.to_owned()),
            Some(position),
            false,
        )
    })?
    .map_err(|error| {
        io_failure(
            "event_decode_failed",
            "Could not decode a binlog event",
            error,
            file_name,
            Some(position),
        )
    })?
    .ok_or_else(|| {
        failure(
            "empty_event_frame",
            "A non-empty binlog event frame decoded as empty",
            None,
            Some(file_name.to_owned()),
            Some(position),
            false,
        )
    })?;
    if !decompressed {
        verify_checksum(&parsed, file_name, position)?;
    }
    Ok(parsed)
}

/// Compares a stored CRC32 footer with the checksum calculated over the decoded event.
fn verify_checksum(
    event: &Event,
    file_name: &str,
    position: u64,
) -> Result<(), BinlogImportFailure> {
    let algorithm = event.footer().get_checksum_alg().map_err(|error| {
        failure(
            "unsupported_checksum",
            "The binlog uses an unknown checksum algorithm",
            Some(error.to_string()),
            Some(file_name.to_owned()),
            Some(position),
            false,
        )
    })?;
    if algorithm != Some(BinlogChecksumAlg::BINLOG_CHECKSUM_ALG_CRC32) {
        return Ok(());
    }
    let expected = event.checksum().ok_or_else(|| {
        failure(
            "missing_checksum",
            "A checksummed binlog event has no checksum footer",
            None,
            Some(file_name.to_owned()),
            Some(position),
            false,
        )
    })?;
    let expected = u32::from_le_bytes(expected);
    let actual = event.calc_checksum(BinlogChecksumAlg::BINLOG_CHECKSUM_ALG_CRC32);
    if expected != actual {
        return Err(failure(
            "checksum_mismatch",
            "A binlog event failed CRC32 verification",
            Some(format!("expected {expected:08x}, calculated {actual:08x}")),
            Some(file_name.to_owned()),
            Some(position),
            false,
        ));
    }
    Ok(())
}

/// Dispatches one decoded event into transaction assembly or diagnostics.
fn process_event(
    reader: &mut EventStreamReader,
    event: &Event,
    location: &EventLocation,
    state: &mut ParserState,
    cancellation: &CancellationToken,
) -> Result<(), BinlogImportFailure> {
    let event_data = event.read_data().map_err(|error| {
        io_failure(
            "event_data_decode_failed",
            "Could not decode binlog event data",
            error,
            &location.file_name,
            Some(location.start_position),
        )
    })?;
    let Some(event_data) = event_data else {
        state.push_diagnostic(BinlogDiagnostic {
            code: "unknown_event_type".into(),
            message: format!(
                "Unknown binlog event type {} was preserved as a diagnostic",
                event.header().event_type_raw()
            ),
            severity: BinlogDiagnosticSeverity::Warning,
            file_name: Some(location.file_name.clone()),
            position: Some(location.start_position),
        });
        return Ok(());
    };

    match event_data {
        EventData::QueryEvent(query) => {
            state
                .assembler
                .on_query(&query.schema(), &query.query(), location);
        }
        EventData::XidEvent(xid) => state.assembler.on_xid(xid.xid, location),
        EventData::GtidEvent(gtid) => state.assembler.on_gtid(format_gtid(&gtid), location),
        EventData::RowsQueryEvent(query) => {
            state.assembler.on_rows_query(query.query().into_owned());
        }
        EventData::RowsEvent(rows) => {
            let change = decode_rows_event(reader, &rows, location, state);
            state.assembler.on_rows(change, location);
        }
        EventData::TransactionPayloadEvent(payload) => {
            state.enter_transaction_payload(payload.uncompressed_size(), location)?;
            let result = payload
                .decompressed()
                .map_err(|error| {
                    io_failure(
                        "transaction_payload_decompress_failed",
                        "Could not decompress a transaction payload event",
                        error,
                        &location.file_name,
                        Some(location.start_position),
                    )
                })
                .and_then(|mut payload_reader| {
                    process_transaction_payload(
                        reader,
                        &mut payload_reader,
                        location,
                        state,
                        cancellation,
                    )
                });
            state.leave_transaction_payload();
            result?;
        }
        EventData::FormatDescriptionEvent(description) => {
            let server_version = description.server_version();
            if server_version.to_ascii_lowercase().contains("mariadb") {
                return Err(failure(
                    "unsupported_mariadb_binlog",
                    "MariaDB binlogs are not supported by this MySQL parser",
                    Some(format!("server version {server_version}")),
                    Some(location.file_name.clone()),
                    Some(location.start_position),
                    false,
                ));
            }
        }
        EventData::IncidentEvent(incident) => {
            state.push_diagnostic(BinlogDiagnostic {
                code: "mysql_incident".into(),
                message: format!("MySQL recorded an incident: {}", incident.message()),
                severity: BinlogDiagnosticSeverity::Warning,
                file_name: Some(location.file_name.clone()),
                position: Some(location.start_position),
            });
        }
        EventData::UnknownEvent
        | EventData::PreGaWriteRowsEvent(_)
        | EventData::PreGaUpdateRowsEvent(_)
        | EventData::PreGaDeleteRowsEvent(_) => {
            state.push_diagnostic(BinlogDiagnostic {
                code: "unsupported_event".into(),
                message: "A legacy or unknown binlog event could not be analyzed".into(),
                severity: BinlogDiagnosticSeverity::Warning,
                file_name: Some(location.file_name.clone()),
                position: Some(location.start_position),
            });
        }
        EventData::RotateEvent(_)
        | EventData::StopEvent
        | EventData::TableMapEvent(_)
        | EventData::PreviousGtidsEvent(_)
        | EventData::HeartbeatEvent
        | EventData::AnonymousGtidEvent(_)
        | EventData::StartEventV3(_)
        | EventData::IntvarEvent(_)
        | EventData::LoadEvent(_)
        | EventData::SlaveEvent
        | EventData::CreateFileEvent(_)
        | EventData::AppendBlockEvent(_)
        | EventData::ExecLoadEvent(_)
        | EventData::DeleteFileEvent(_)
        | EventData::NewLoadEvent(_)
        | EventData::RandEvent(_)
        | EventData::UserVarEvent(_)
        | EventData::BeginLoadQueryEvent(_)
        | EventData::ExecuteLoadQueryEvent(_)
        | EventData::IgnorableEvent(_)
        | EventData::TransactionContextEvent(_)
        | EventData::ViewChangeEvent(_)
        | EventData::XaPrepareLogEvent(_) => state.assembler.update_end(location),
    }
    Ok(())
}

/// Streams inner events from one compressed transaction payload using the same table-map reader.
fn process_transaction_payload(
    reader: &mut EventStreamReader,
    payload: &mut TransactionPayloadReader<'_>,
    outer_location: &EventLocation,
    state: &mut ParserState,
    cancellation: &CancellationToken,
) -> Result<(), BinlogImportFailure> {
    while payload.has_data_left().map_err(|error| {
        io_failure(
            "transaction_payload_read_failed",
            "Could not read a decompressed transaction payload",
            error,
            &outer_location.file_name,
            Some(outer_location.start_position),
        )
    })? {
        if cancellation.is_cancelled() {
            return Ok(());
        }
        let frame = read_event_frame(
            payload,
            None,
            &outer_location.file_name,
            outer_location.start_position,
            usize::try_from(
                MAX_DECOMPRESSED_PAYLOAD_BYTES.saturating_sub(state.decompressed_payload_bytes),
            )
            .unwrap_or(usize::MAX)
            .min(MAX_EVENT_SIZE_BYTES),
        )?
        .ok_or_else(|| {
            failure(
                "transaction_payload_truncated",
                "A transaction payload ended unexpectedly",
                None,
                Some(outer_location.file_name.clone()),
                Some(outer_location.start_position),
                false,
            )
        })?;
        state.record_decompressed_event(frame.len(), outer_location)?;
        let inner = parse_event_frame(
            reader,
            frame,
            true,
            &outer_location.file_name,
            outer_location.start_position,
        )?;
        state.event_count += 1;
        state.observe_timestamp(inner.header().timestamp());
        let mut inner_location = outer_location.clone();
        inner_location.timestamp = timestamp_from_seconds(inner.header().timestamp());
        inner_location.server_id = inner.header().server_id();
        process_event(reader, &inner, &inner_location, state, cancellation)?;
    }
    Ok(())
}

/// Decodes one row event using its exact matching table map.
fn decode_rows_event(
    reader: &EventStreamReader,
    rows: &RowsEventData<'_>,
    location: &EventLocation,
    state: &mut ParserState,
) -> BinlogChange {
    let operation = rows_operation(rows);
    let num_columns = rows.num_columns() as usize;
    let columns_before = rows
        .columns_before_image()
        .map(|bits| bits.iter().map(|bit| *bit).collect::<Vec<_>>());
    let columns_after = rows
        .columns_after_image()
        .map(|bits| bits.iter().map(|bit| *bit).collect::<Vec<_>>());
    let Some(table_map) = reader.get_tme(rows.table_id()) else {
        state.push_diagnostic(BinlogDiagnostic {
            code: "missing_table_map".into(),
            message: "A row event has no matching TableMap event".into(),
            severity: BinlogDiagnosticSeverity::Warning,
            file_name: Some(location.file_name.clone()),
            position: Some(location.start_position),
        });
        return BinlogChange {
            database: String::new(),
            table: String::new(),
            operation,
            row_count: 0,
            columns: fallback_column_names(num_columns),
            rows: Vec::new(),
            table_confidence: BinlogTableConfidence::Unknown,
            sql: None,
        };
    };
    let columns = table_column_names(table_map, num_columns, location, state);
    let mut decoded_rows = Vec::new();
    for decoded in rows.rows(table_map) {
        match decoded {
            Ok((before, after)) => decoded_rows.push(BinlogRowChange {
                before: before.map(|row| {
                    expand_row_image(row, columns_before.as_deref().unwrap_or(&[]), &columns)
                }),
                after: after.map(|row| {
                    expand_row_image(row, columns_after.as_deref().unwrap_or(&[]), &columns)
                }),
            }),
            Err(error) => {
                let message = "The logged row image could not be decoded".to_owned();
                state.push_diagnostic(BinlogDiagnostic {
                    code: "row_decode_failed".into(),
                    message: message.clone(),
                    severity: BinlogDiagnosticSeverity::Warning,
                    file_name: Some(location.file_name.clone()),
                    position: Some(location.start_position),
                });
                let _redacted_error = error;
                decoded_rows.push(BinlogRowChange {
                    before: columns_before
                        .as_deref()
                        .map(|present| failed_row_image(present, &columns, &message)),
                    after: columns_after
                        .as_deref()
                        .map(|present| failed_row_image(present, &columns, &message)),
                });
                break;
            }
        }
    }

    BinlogChange {
        database: table_map.database_name().into_owned(),
        table: table_map.table_name().into_owned(),
        operation,
        row_count: decoded_rows.len() as u64,
        columns,
        rows: decoded_rows,
        table_confidence: BinlogTableConfidence::Exact,
        sql: None,
    }
}

/// Maps every rows-event wire variant to its user-facing operation.
fn rows_operation(rows: &RowsEventData<'_>) -> BinlogOperation {
    match rows {
        RowsEventData::WriteRowsEventV1(_) | RowsEventData::WriteRowsEvent(_) => {
            BinlogOperation::Insert
        }
        RowsEventData::UpdateRowsEventV1(_)
        | RowsEventData::UpdateRowsEvent(_)
        | RowsEventData::PartialUpdateRowsEvent(_) => BinlogOperation::Update,
        RowsEventData::DeleteRowsEventV1(_) | RowsEventData::DeleteRowsEvent(_) => {
            BinlogOperation::Delete
        }
    }
}

/// Reads optional FULL metadata column names and fills missing names with one-based placeholders.
fn table_column_names(
    table_map: &TableMapEvent<'_>,
    num_columns: usize,
    location: &EventLocation,
    state: &mut ParserState,
) -> Vec<String> {
    let extractor = match OptionalMetaExtractor::new(table_map.iter_optional_meta()) {
        Ok(extractor) => extractor,
        Err(_error) => {
            state.push_diagnostic(BinlogDiagnostic {
                code: "optional_metadata_decode_failed".into(),
                message:
                    "TableMap optional metadata could not be decoded; placeholder columns are used"
                        .into(),
                severity: BinlogDiagnosticSeverity::Warning,
                file_name: Some(location.file_name.clone()),
                position: Some(location.start_position),
            });
            return fallback_column_names(num_columns);
        }
    };
    let mut names = extractor
        .iter_column_name()
        .map(|name| name.map(|name| name.name().into_owned()))
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();
    names.resize_with(num_columns, String::new);
    for (index, name) in names.iter_mut().enumerate() {
        if name.is_empty() {
            *name = format!("@{}", index + 1);
        }
    }
    names
}

/// Creates one-based placeholder names when the binlog lacks FULL metadata.
fn fallback_column_names(num_columns: usize) -> Vec<String> {
    (1..=num_columns).map(|index| format!("@{index}")).collect()
}

/// Expands a compact `BinlogRow` back to the full bitmap width with explicit `not_logged` cells.
fn expand_row_image(
    row: BinlogRow,
    present: &[bool],
    column_names: &[String],
) -> BTreeMap<String, BinlogCell> {
    let columns = row.columns_ref().to_vec();
    let values = row.unwrap();
    let mut values = values.into_iter().zip(columns);
    let mut image = BTreeMap::new();
    for (index, column_name) in column_names.iter().enumerate() {
        if !present.get(index).copied().unwrap_or(false) {
            image.insert(column_name.clone(), BinlogCell::NotLogged);
            continue;
        }
        let cell = values
            .next()
            .map(|(value, column)| decode_binlog_value(value, &column))
            .unwrap_or_else(|| BinlogCell::DecodeError {
                message: "The row image is missing a logged column value".into(),
            });
        image.insert(column_name.clone(), cell);
    }
    image
}

/// Marks every logged bitmap position as a decode error without inventing NULL values.
fn failed_row_image(
    present: &[bool],
    column_names: &[String],
    message: &str,
) -> BTreeMap<String, BinlogCell> {
    column_names
        .iter()
        .enumerate()
        .map(|(index, column_name)| {
            if present.get(index).copied().unwrap_or(false) {
                (
                    column_name.clone(),
                    BinlogCell::DecodeError {
                        message: message.to_owned(),
                    },
                )
            } else {
                (column_name.clone(), BinlogCell::NotLogged)
            }
        })
        .collect()
}

/// Converts one mysql_common binlog value into the shared lossless transport type.
fn decode_binlog_value(value: BinlogValue<'_>, column: &Column) -> BinlogCell {
    match value {
        BinlogValue::Value(value) => decode_mysql_value(value, column),
        BinlogValue::Jsonb(value) => match serde_json::Value::try_from(value) {
            Ok(value) => BinlogCell::Value {
                value: CellValue::Json(value.to_string()),
            },
            Err(_error) => BinlogCell::DecodeError {
                message: "The binary JSON value could not be decoded".into(),
            },
        },
        BinlogValue::JsonDiff(_diff) => BinlogCell::DecodeError {
            message: "A partial JSON update is not materialized in this version".into(),
        },
    }
}

/// Maps a protocol `Value` without numeric precision loss or lossy binary decoding.
fn decode_mysql_value(value: Value, column: &Column) -> BinlogCell {
    let value = match value {
        Value::NULL => return BinlogCell::Null,
        value => value,
    };
    if matches!(
        column.column_type(),
        ColumnType::MYSQL_TYPE_TIMESTAMP | ColumnType::MYSQL_TYPE_TIMESTAMP2
    ) {
        return decode_mysql_timestamp(value);
    }

    let value = match value {
        Value::NULL => unreachable!("NULL is handled before type-specific decoding"),
        Value::Int(value) => CellValue::Integer(value.to_string()),
        Value::UInt(value) => CellValue::Integer(value.to_string()),
        Value::Float(value) if value.is_finite() => CellValue::Float(value as f64),
        Value::Double(value) if value.is_finite() => CellValue::Float(value),
        Value::Float(value) => CellValue::Text(value.to_string()),
        Value::Double(value) => CellValue::Text(value.to_string()),
        Value::Date(year, month, day, hour, minute, second, micros) => CellValue::DateTime(
            format_mysql_date(year, month, day, hour, minute, second, micros),
        ),
        Value::Time(negative, days, hours, minutes, seconds, micros) => CellValue::DateTime(
            format_mysql_time(negative, days, hours, minutes, seconds, micros),
        ),
        Value::Bytes(bytes) => return decode_bytes(bytes, column),
    };
    BinlogCell::Value { value }
}

/// Retains MySQL TIMESTAMP values as decimal Unix seconds for type-aware SQL generation.
fn decode_mysql_timestamp(value: Value) -> BinlogCell {
    let value = match value {
        Value::Int(value) if value >= 0 => value.to_string(),
        Value::UInt(value) => value.to_string(),
        Value::Bytes(bytes) => match String::from_utf8(bytes) {
            Ok(value) => value,
            Err(_error) => {
                return BinlogCell::DecodeError {
                    message: "The TIMESTAMP value is not valid decimal Unix seconds".into(),
                }
            }
        },
        _ => {
            return BinlogCell::DecodeError {
                message: "The TIMESTAMP value has an unsupported wire representation".into(),
            }
        }
    };
    if !valid_unix_seconds(&value) {
        return BinlogCell::DecodeError {
            message: "The TIMESTAMP value is not valid decimal Unix seconds".into(),
        };
    }
    BinlogCell::UnixTimestamp { value }
}

/// Validates the unsigned fixed-point form emitted for MySQL TIMESTAMP values.
fn valid_unix_seconds(value: &str) -> bool {
    let mut parts = value.split('.');
    let Some(seconds) = parts.next() else {
        return false;
    };
    if seconds.is_empty() || !seconds.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    match (parts.next(), parts.next()) {
        (None, None) => true,
        (Some(fraction), None) => {
            !fraction.is_empty() && fraction.bytes().all(|byte| byte.is_ascii_digit())
        }
        _ => false,
    }
}

/// Interprets byte-backed wire values only when their type metadata is unambiguous.
fn decode_bytes(bytes: Vec<u8>, column: &Column) -> BinlogCell {
    match column.column_type() {
        ColumnType::MYSQL_TYPE_NEWDECIMAL => match String::from_utf8(bytes) {
            Ok(value) => BinlogCell::Value {
                value: CellValue::Decimal(value),
            },
            Err(error) => raw_partial_cell(
                error.into_bytes(),
                "The decimal value was retained as raw bytes",
            ),
        },
        ColumnType::MYSQL_TYPE_YEAR => match String::from_utf8(bytes) {
            Ok(value) => BinlogCell::Value {
                value: CellValue::Text(value),
            },
            Err(error) => raw_partial_cell(
                error.into_bytes(),
                "The YEAR value was retained as raw bytes",
            ),
        },
        column_type if column_type.is_character_type() => {
            decode_character_bytes(bytes, column.character_set())
        }
        _ => BinlogCell::Value {
            value: CellValue::Binary(STANDARD.encode(bytes)),
        },
    }
}

/// Decodes UTF-compatible character data and conservatively retains every other charset.
fn decode_character_bytes(bytes: Vec<u8>, character_set: u16) -> BinlogCell {
    if character_set == 63 {
        return BinlogCell::Value {
            value: CellValue::Binary(STANDARD.encode(bytes)),
        };
    }
    let collation: Collation<'static> = CollationId::from(character_set).into();
    if matches!(collation.charset, "ascii" | "utf8mb3" | "utf8mb4") {
        return match String::from_utf8(bytes) {
            Ok(value) => BinlogCell::Value {
                value: CellValue::Text(value),
            },
            Err(error) => raw_partial_cell(
                error.into_bytes(),
                "Character data did not match its declared UTF encoding; raw bytes were retained",
            ),
        };
    }
    let message = if collation.charset == "unknown" {
        "Character-set metadata is unavailable; raw bytes were retained".to_owned()
    } else {
        format!(
            "Character data uses {}; raw bytes were retained",
            collation.charset
        )
    };
    raw_partial_cell(bytes, message)
}

/// Preserves an undecoded byte sequence while marking it unsafe for Reset SQL.
fn raw_partial_cell(bytes: Vec<u8>, message: impl Into<String>) -> BinlogCell {
    BinlogCell::Partial {
        value: CellValue::Binary(STANDARD.encode(bytes)),
        message: Some(message.into()),
    }
}

/// Formats a possibly zero MySQL date without relying on chrono validation.
fn format_mysql_date(
    year: u16,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    micros: u32,
) -> String {
    let base = format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}");
    if micros == 0 {
        base
    } else {
        format!("{base}.{micros:06}")
    }
}

/// Formats MySQL time values including negative and multi-day durations.
fn format_mysql_time(
    negative: bool,
    days: u32,
    hours: u8,
    minutes: u8,
    seconds: u8,
    micros: u32,
) -> String {
    let sign = if negative { "-" } else { "" };
    let total_hours = u64::from(days) * 24 + u64::from(hours);
    let base = format!("{sign}{total_hours:02}:{minutes:02}:{seconds:02}");
    if micros == 0 {
        base
    } else {
        format!("{base}.{micros:06}")
    }
}

/// Formats traditional and tagged GTIDs without losing the 64-bit group number.
fn format_gtid(gtid: &mysql_common::binlog::events::GtidEvent) -> String {
    let sid = Uuid::from_bytes(gtid.sid());
    match gtid.tag() {
        Some(tag) => format!("{sid}:{tag}:{}", gtid.gno()),
        None => format!("{sid}:{}", gtid.gno()),
    }
}

/// Builds physical location metadata from one decoded event.
fn event_location(
    event: &Event,
    file_name: &str,
    start_position: u64,
    end_position: u64,
) -> EventLocation {
    EventLocation {
        timestamp: timestamp_from_seconds(event.header().timestamp()),
        server_id: event.header().server_id(),
        file_name: file_name.to_owned(),
        start_position,
        end_position,
    }
}

/// Converts a binlog header timestamp to a stable UTC RFC 3339 string.
fn timestamp_from_seconds(timestamp: u32) -> String {
    DateTime::<Utc>::from_timestamp(i64::from(timestamp), 0)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Computes summary counts and table aggregates from assembled transactions.
fn build_summary(
    analysis_id: Uuid,
    files: Vec<BinlogFileSummary>,
    started_at: String,
    status: BinlogAnalysisStatus,
    state: ParserState,
    transactions: &[BinlogTransaction],
) -> BinlogSummary {
    let mut table_summaries = BTreeMap::<(String, String), BinlogTableSummary>::new();
    for transaction in transactions {
        for change in &transaction.changes {
            if change.table.is_empty() {
                continue;
            }
            let table = table_summaries
                .entry((change.database.clone(), change.table.clone()))
                .or_insert_with(|| BinlogTableSummary {
                    database: change.database.clone(),
                    table: change.table.clone(),
                    insert_count: 0,
                    update_count: 0,
                    delete_count: 0,
                    ddl_count: 0,
                    row_change_count: 0,
                });
            table.row_change_count += change.row_count;
            match change.operation {
                BinlogOperation::Insert => table.insert_count += change.row_count,
                BinlogOperation::Update => table.update_count += change.row_count,
                BinlogOperation::Delete => table.delete_count += change.row_count,
                BinlogOperation::Ddl => table.ddl_count += 1,
            }
        }
    }
    let row_change_count = transactions
        .iter()
        .map(|transaction| transaction.row_change_count)
        .sum();

    BinlogSummary {
        analysis_id,
        files,
        status,
        started_at,
        ended_at: Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
        first_event_at: state.first_timestamp.map(timestamp_from_seconds),
        last_event_at: state.last_timestamp.map(timestamp_from_seconds),
        transaction_count: transactions.len() as u64,
        event_count: state.event_count,
        row_change_count,
        tables: table_summaries.into_values().collect(),
        diagnostics: state.diagnostics,
    }
}

/// Creates a safe parser failure and matching located diagnostic.
fn failure(
    code: &str,
    message: &str,
    technical_details: Option<String>,
    file_name: Option<String>,
    position: Option<u64>,
    retryable: bool,
) -> BinlogImportFailure {
    BinlogImportFailure {
        code: code.to_owned(),
        message: message.to_owned(),
        technical_details,
        retryable,
        diagnostic: Box::new(BinlogDiagnostic {
            code: code.to_owned(),
            message: message.to_owned(),
            severity: BinlogDiagnosticSeverity::Error,
            file_name,
            position,
        }),
    }
}

/// Maps an I/O failure to safe user-facing and diagnostic fields.
fn io_failure(
    code: &str,
    message: &str,
    error: io::Error,
    file_name: &str,
    position: Option<u64>,
) -> BinlogImportFailure {
    let retryable = matches!(
        error.kind(),
        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
    );
    failure(
        code,
        message,
        Some(error.to_string()),
        Some(file_name.to_owned()),
        position,
        retryable,
    )
}

/// Returns a non-secret basename for progress and diagnostics.
fn file_name(path: impl AsRef<Path>) -> String {
    path.as_ref()
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("binlog")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_files, decode_mysql_value, failed_row_image, initial_summary, inspect_files,
        BinlogChecksumAlg, BinlogImportTerminal, ParserState, MAX_DECOMPRESSED_PAYLOAD_BYTES,
        MAX_DECOMPRESSED_PAYLOAD_EVENTS, MAX_TRANSACTION_PAYLOAD_DEPTH,
    };
    use crate::assembler::EventLocation;
    use mysql_common::{
        binlog::consts::EventType, constants::ColumnType, packets::Column, value::Value,
    };
    use pipa_core::{BinlogAnalysisStatus, BinlogCell, CellValue};
    use std::io::Write;
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    /// Writes one small test file and returns its preflight metadata.
    fn fixture_file(bytes: &[u8]) -> (tempfile::TempDir, Vec<pipa_core::BinlogFileSummary>) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mysql-bin.000001");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        let files = inspect_files(&[path.to_string_lossy().into_owned()]).unwrap();
        (directory, files)
    }

    /// Appends one checksum-free v4 event with a correct physical next-position header.
    fn push_event(binlog: &mut Vec<u8>, event_type: EventType, body: &[u8]) {
        let event_size = 19 + body.len();
        let next_position = binlog.len() + event_size;
        binlog.extend_from_slice(&1_700_000_000_u32.to_le_bytes());
        binlog.push(event_type as u8);
        binlog.extend_from_slice(&7_u32.to_le_bytes());
        binlog.extend_from_slice(&(event_size as u32).to_le_bytes());
        binlog.extend_from_slice(&(next_position as u32).to_le_bytes());
        binlog.extend_from_slice(&0_u16.to_le_bytes());
        binlog.extend_from_slice(body);
    }

    /// Creates an old checksum-free FDE body whose missing header table uses library defaults.
    fn checksum_free_fde_body() -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&4_u16.to_le_bytes());
        let mut server_version = [0_u8; 50];
        server_version[..5].copy_from_slice(b"5.5.0");
        body.extend_from_slice(&server_version);
        body.extend_from_slice(&1_700_000_000_u32.to_le_bytes());
        body.push(19);
        body
    }

    /// Builds a minimal FDE/GTID/TableMap/UPDATE/XID fixture entirely in test code.
    fn minimal_row_binlog() -> Vec<u8> {
        let mut binlog = vec![0xfe, b'b', b'i', b'n'];
        push_event(
            &mut binlog,
            EventType::FORMAT_DESCRIPTION_EVENT,
            &checksum_free_fde_body(),
        );

        let mut gtid = vec![0_u8];
        gtid.extend_from_slice(&[0xaa; 16]);
        gtid.extend_from_slice(&9_u64.to_le_bytes());
        push_event(&mut binlog, EventType::GTID_EVENT, &gtid);

        let table_id = 3_u64.to_le_bytes();
        let mut table_map = Vec::new();
        table_map.extend_from_slice(&table_id[..6]);
        table_map.extend_from_slice(&0_u16.to_le_bytes());
        table_map.push(5);
        table_map.extend_from_slice(b"sales");
        table_map.push(0);
        table_map.push(6);
        table_map.extend_from_slice(b"orders");
        table_map.push(0);
        table_map.push(2);
        table_map.push(ColumnType::MYSQL_TYPE_LONG as u8);
        table_map.push(ColumnType::MYSQL_TYPE_LONG as u8);
        table_map.push(0);
        table_map.push(0);
        push_event(&mut binlog, EventType::TABLE_MAP_EVENT, &table_map);

        let mut update = Vec::new();
        update.extend_from_slice(&table_id[..6]);
        update.extend_from_slice(&0_u16.to_le_bytes());
        update.extend_from_slice(&2_u16.to_le_bytes());
        update.push(2);
        update.push(0b0000_0001);
        update.push(0b0000_0010);
        update.push(0);
        update.extend_from_slice(&42_i32.to_le_bytes());
        update.push(0);
        update.extend_from_slice(&99_i32.to_le_bytes());
        push_event(&mut binlog, EventType::UPDATE_ROWS_EVENT, &update);

        push_event(&mut binlog, EventType::XID_EVENT, &91_u64.to_le_bytes());
        binlog
    }

    /// Verifies a clean empty event stream completes without inventing transactions.
    #[test]
    fn header_only_fixture_completes() {
        let (_directory, files) = fixture_file(&[0xfe, b'b', b'i', b'n']);
        let output = analyze_files(
            Uuid::new_v4(),
            files,
            "2026-01-01T00:00:00Z".into(),
            &CancellationToken::new(),
            |_| {},
        );

        assert!(matches!(output.terminal, BinlogImportTerminal::Completed));
        assert_eq!(output.summary.status, BinlogAnalysisStatus::Complete);
        assert_eq!(output.summary.event_count, 0);
        assert!(output.transactions.is_empty());
    }

    /// Verifies a programmatic row fixture exercises native TableMap bitmap alignment.
    #[test]
    fn native_row_fixture_decodes_before_after_and_not_logged() {
        let (_directory, files) = fixture_file(&minimal_row_binlog());
        let output = analyze_files(
            Uuid::new_v4(),
            files,
            "2026-01-01T00:00:00Z".into(),
            &CancellationToken::new(),
            |_| {},
        );

        assert!(matches!(output.terminal, BinlogImportTerminal::Completed));
        assert_eq!(output.summary.event_count, 5);
        assert_eq!(output.summary.row_change_count, 1);
        assert_eq!(output.transactions.len(), 1);
        assert_eq!(
            output.transactions[0].gtid.as_deref(),
            Some("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:9")
        );
        assert_eq!(output.transactions[0].xid.as_deref(), Some("91"));
        let row = &output.transactions[0].changes[0].rows[0];
        assert!(matches!(
            row.before.as_ref().unwrap()["@1"],
            BinlogCell::Value { .. }
        ));
        assert!(matches!(
            row.before.as_ref().unwrap()["@2"],
            BinlogCell::NotLogged
        ));
        assert!(matches!(
            row.after.as_ref().unwrap()["@1"],
            BinlogCell::NotLogged
        ));
        assert!(matches!(
            row.after.as_ref().unwrap()["@2"],
            BinlogCell::Value { .. }
        ));
    }

    /// Verifies CRC32-enabled FDE corruption is detected rather than silently accepted.
    #[test]
    fn checksum_mismatch_is_failed_and_located() {
        let mut binlog = vec![0xfe, b'b', b'i', b'n'];
        let mut fde = Vec::new();
        fde.extend_from_slice(&4_u16.to_le_bytes());
        let mut server_version = [0_u8; 50];
        server_version[..6].copy_from_slice(b"8.0.36");
        fde.extend_from_slice(&server_version);
        fde.extend_from_slice(&1_700_000_000_u32.to_le_bytes());
        fde.push(19);
        fde.push(BinlogChecksumAlg::BINLOG_CHECKSUM_ALG_CRC32 as u8);
        fde.extend_from_slice(&0_u32.to_le_bytes());
        push_event(&mut binlog, EventType::FORMAT_DESCRIPTION_EVENT, &fde);
        let (_directory, files) = fixture_file(&binlog);

        let output = analyze_files(
            Uuid::new_v4(),
            files,
            "2026-01-01T00:00:00Z".into(),
            &CancellationToken::new(),
            |_| {},
        );

        let BinlogImportTerminal::Failed(error) = output.terminal else {
            panic!("expected checksum failure");
        };
        assert_eq!(error.code, "checksum_mismatch");
        assert_eq!(error.diagnostic.position, Some(4));
    }

    /// Verifies a partial event header is reported at its exact physical offset.
    #[test]
    fn truncated_event_header_is_failed_and_located() {
        let (_directory, files) = fixture_file(&[0xfe, b'b', b'i', b'n', 1, 2, 3, 4, 5]);
        let output = analyze_files(
            Uuid::new_v4(),
            files,
            "2026-01-01T00:00:00Z".into(),
            &CancellationToken::new(),
            |_| {},
        );

        let BinlogImportTerminal::Failed(error) = output.terminal else {
            panic!("expected failure");
        };
        assert_eq!(error.code, "truncated_event_header");
        assert_eq!(error.diagnostic.position, Some(4));
        assert_eq!(output.summary.status, BinlogAnalysisStatus::Error);
    }

    /// Verifies cancellation before file I/O produces a terminal canceled analysis.
    #[test]
    fn pre_canceled_import_is_canceled() {
        let (_directory, files) = fixture_file(&[0xfe, b'b', b'i', b'n']);
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let output = analyze_files(
            Uuid::new_v4(),
            files,
            "2026-01-01T00:00:00Z".into(),
            &cancellation,
            |_| {},
        );

        assert!(matches!(output.terminal, BinlogImportTerminal::Canceled));
        assert_eq!(output.summary.status, BinlogAnalysisStatus::Partial);
        assert_eq!(output.summary.diagnostics[0].code, "import_canceled");
    }

    /// Verifies a malformed magic header is rejected without attempting event parsing.
    #[test]
    fn invalid_magic_header_is_failed() {
        let (_directory, files) = fixture_file(b"NOPE");

        let output = analyze_files(
            Uuid::new_v4(),
            files,
            "2026-01-01T00:00:00Z".into(),
            &CancellationToken::new(),
            |_| {},
        );

        let BinlogImportTerminal::Failed(error) = output.terminal else {
            panic!("expected failure");
        };
        assert_eq!(error.code, "invalid_file_header");
    }

    /// Verifies decode failures and omitted columns never collapse into explicit SQL NULL.
    #[test]
    fn failed_row_image_preserves_not_logged_columns() {
        let image = failed_row_image(
            &[true, false, true],
            &["@1".into(), "@2".into(), "@3".into()],
            "decode failed",
        );

        assert!(matches!(image["@1"], BinlogCell::DecodeError { .. }));
        assert!(matches!(image["@2"], BinlogCell::NotLogged));
        assert!(matches!(image["@3"], BinlogCell::DecodeError { .. }));
    }

    /// Verifies character metadata controls decoding and uncertain bytes remain non-resettable.
    #[test]
    fn character_values_respect_table_map_collations() {
        let utf8 = Column::new(ColumnType::MYSQL_TYPE_VARCHAR).with_character_set(45);
        assert_eq!(
            decode_mysql_value(Value::Bytes("你好".as_bytes().to_vec()), &utf8),
            BinlogCell::Value {
                value: CellValue::Text("你好".into())
            }
        );

        let utf8_blob = Column::new(ColumnType::MYSQL_TYPE_BLOB).with_character_set(45);
        assert_eq!(
            decode_mysql_value(Value::Bytes(b"notes".to_vec()), &utf8_blob),
            BinlogCell::Value {
                value: CellValue::Text("notes".into())
            }
        );

        let latin1 = Column::new(ColumnType::MYSQL_TYPE_VARCHAR).with_character_set(8);
        let BinlogCell::Partial { value, message } =
            decode_mysql_value(Value::Bytes(vec![0xe9]), &latin1)
        else {
            panic!("expected raw partial character data");
        };
        assert_eq!(value, CellValue::Binary("6Q==".into()));
        assert!(message.is_some_and(|message| message.contains("latin1")));

        let binary = Column::new(ColumnType::MYSQL_TYPE_BLOB).with_character_set(63);
        assert_eq!(
            decode_mysql_value(Value::Bytes(vec![0xe9]), &binary),
            BinlogCell::Value {
                value: CellValue::Binary("6Q==".into())
            }
        );

        let unknown = Column::new(ColumnType::MYSQL_TYPE_STRING);
        assert!(matches!(
            decode_mysql_value(Value::Bytes(b"text".to_vec()), &unknown),
            BinlogCell::Partial {
                value: CellValue::Binary(_),
                ..
            }
        ));
    }

    /// Verifies both TIMESTAMP wire encodings retain exact Unix-second semantics.
    #[test]
    fn timestamp_values_retain_unix_seconds() {
        let legacy = Column::new(ColumnType::MYSQL_TYPE_TIMESTAMP);
        assert_eq!(
            decode_mysql_value(Value::Int(1_722_067_200), &legacy),
            BinlogCell::UnixTimestamp {
                value: "1722067200".into()
            }
        );

        let fractional = Column::new(ColumnType::MYSQL_TYPE_TIMESTAMP2);
        assert_eq!(
            decode_mysql_value(Value::Bytes(b"1722067200.123456".to_vec()), &fractional),
            BinlogCell::UnixTimestamp {
                value: "1722067200.123456".into()
            }
        );
    }

    /// Verifies declared size, actual size, event count, and nesting all share hard bounds.
    #[test]
    fn transaction_payload_resource_limits_are_enforced() {
        let location = EventLocation {
            timestamp: "2026-01-01T00:00:00Z".into(),
            server_id: 1,
            file_name: "mysql-bin.000001".into(),
            start_position: 4,
            end_position: 100,
        };
        let mut state = ParserState::new(Uuid::new_v4());
        let error = state
            .enter_transaction_payload(MAX_DECOMPRESSED_PAYLOAD_BYTES + 1, &location)
            .unwrap_err();
        assert_eq!(error.code, "transaction_payload_too_large");

        state.decompressed_payload_bytes = MAX_DECOMPRESSED_PAYLOAD_BYTES - 1;
        let error = state.record_decompressed_event(2, &location).unwrap_err();
        assert_eq!(error.code, "transaction_payload_too_large");

        state.decompressed_payload_bytes = 0;
        state.decompressed_payload_events = MAX_DECOMPRESSED_PAYLOAD_EVENTS;
        let error = state.record_decompressed_event(19, &location).unwrap_err();
        assert_eq!(error.code, "transaction_payload_event_limit");

        state.decompressed_payload_events = 0;
        state.transaction_payload_depth = MAX_TRANSACTION_PAYLOAD_DEPTH;
        let error = state.enter_transaction_payload(1, &location).unwrap_err();
        assert_eq!(error.code, "transaction_payload_too_deep");
    }

    /// Verifies the initial session contract is queryable before parsing completes.
    #[test]
    fn initial_summary_is_partial_while_parsing() {
        let analysis_id = Uuid::new_v4();
        let summary = initial_summary(analysis_id, Vec::new(), "2026-01-01T00:00:00Z".into());

        assert_eq!(summary.analysis_id, analysis_id);
        assert_eq!(summary.status, BinlogAnalysisStatus::Partial);
        assert_eq!(summary.transaction_count, 0);
    }
}
