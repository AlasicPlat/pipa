use pipa_core::{
    AppErrorCode, ApplyTableMutationsInput, CellValue, ConnectionProfile, DatabaseAdapter, Engine,
    Environment, QueryEvent, QueryRequest, TableMutation, TableMutationField, TableMutationValue,
    TlsMode,
};
use pipa_mysql::MySqlAdapter;
use secrecy::SecretString;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Verifies lossless values and the ordered event contract for a MySQL result set.
#[tokio::test]
async fn streams_lossless_values_in_order() {
    let profile = test_profile();
    let query_id = Uuid::new_v4();
    let events = run_query(
        &profile,
        query_id,
        "SELECT CAST(9007199254740993 AS SIGNED) AS large_integer, \
              CAST(12.3400 AS DECIMAL(10,4)) AS exact_decimal, \
              'Pipa' AS label, NULL AS empty_value",
    )
    .await;

    assert_eq!(events.len(), 4);
    assert!(matches!(events[0], QueryEvent::Started { query_id: id } if id == query_id));
    assert!(matches!(events[1], QueryEvent::Schema { query_id: id, .. } if id == query_id));
    let QueryEvent::Batch {
        query_id: batch_query_id,
        rows,
    } = &events[2]
    else {
        panic!("third event should be a batch");
    };
    assert_eq!(*batch_query_id, query_id);
    assert_eq!(rows.len(), 1);
    assert!(matches!(
        rows[0].as_slice(),
        [
            CellValue::Integer(integer),
            CellValue::Decimal(decimal),
            CellValue::Text(label),
            CellValue::Null,
        ] if integer == "9007199254740993" && decimal == "12.3400" && label == "Pipa"
    ));
    assert!(matches!(
        events[3],
        QueryEvent::Completed {
            query_id: id,
            affected_rows: 0
        } if id == query_id
    ));
}

/// Verifies every MySQL value family is decoded through a live SQLx row.
#[tokio::test]
async fn streams_every_lossless_value_category() {
    let profile = test_profile();
    let query_id = Uuid::new_v4();
    let events = run_query(
        &profile,
        query_id,
        "CREATE TEMPORARY TABLE pipa_value_types (use_type TINYINT(1) NOT NULL); \
         INSERT INTO pipa_value_types VALUES (3); \
         SELECT use_type, \
                CAST(-9223372036854775808 AS SIGNED) AS signed_value, \
                CAST(18446744073709551615 AS UNSIGNED) AS unsigned_value, \
                CAST(12.3400 AS DECIMAL(10,4)) AS decimal_value, \
                CAST(1.25 AS FLOAT) AS float_value, \
                CAST(2.5 AS DOUBLE) AS double_value, \
                JSON_OBJECT('pipa', TRUE) AS json_value, \
                X'00FF' AS binary_value, \
                CAST('2026-07-17' AS DATE) AS date_value, \
                CAST('12:34:56.123456' AS TIME(6)) AS time_value, \
                CAST('2026-07-17 12:34:56.123456' AS DATETIME(6)) AS datetime_value, \
                'Pipa' AS text_value, \
                NULL AS null_value \
         FROM pipa_value_types",
    )
    .await;

    let QueryEvent::Schema { columns, .. } = &events[1] else {
        panic!("second event should be a schema");
    };
    assert_eq!(columns[0].database_type, "TINYINT");

    let QueryEvent::Batch { rows, .. } = &events[2] else {
        panic!("third event should be a batch");
    };
    assert!(
        matches!(
            rows[0].as_slice(),
            [
                CellValue::Integer(use_type),
                CellValue::Integer(signed_value),
                CellValue::Integer(unsigned_value),
                CellValue::Decimal(decimal_value),
                CellValue::Float(float_value),
                CellValue::Float(double_value),
                CellValue::Json(json_value),
                CellValue::Binary(binary_value),
                CellValue::DateTime(date_value),
                CellValue::DateTime(time_value),
                CellValue::DateTime(datetime_value),
                CellValue::Text(text_value),
                CellValue::Null,
            ] if use_type == "3"
                && signed_value == "-9223372036854775808"
                && unsigned_value == "18446744073709551615"
                && decimal_value == "12.3400"
                && *float_value == 1.25
                && *double_value == 2.5
                && json_value == "{\"pipa\": true}"
                && binary_value == "AP8="
                && date_value == "2026-07-17"
                && time_value == "12:34:56.123456"
                && datetime_value == "2026-07-17T12:34:56.123456"
                && text_value == "Pipa"
        ),
        "unexpected live value mapping: {:?}",
        rows[0]
    );
}

/// Verifies legal zero date variants survive decoding without Chrono validation.
#[tokio::test]
async fn preserves_zero_temporal_values() {
    let profile = test_profile();
    let query_id = Uuid::new_v4();
    let events = run_query(
        &profile,
        query_id,
        "SET SESSION sql_mode = ''; \
         CREATE TEMPORARY TABLE pipa_zero_temporals (\
             date_value DATE NOT NULL, \
             datetime_value DATETIME(6) NOT NULL, \
             timestamp_value TIMESTAMP(6) NOT NULL\
         ); \
         INSERT INTO pipa_zero_temporals VALUES (\
             '0000-00-00', \
             '0000-00-00 00:00:00.000000', \
             '0000-00-00 00:00:00.000000'\
         ); \
         SELECT date_value, datetime_value, timestamp_value \
         FROM pipa_zero_temporals",
    )
    .await;

    let QueryEvent::Batch { rows, .. } = &events[2] else {
        panic!("zero temporal query should emit a batch: {events:?}");
    };
    assert!(matches!(
        rows[0].as_slice(),
        [
            CellValue::DateTime(date_value),
            CellValue::DateTime(datetime_value),
            CellValue::DateTime(timestamp_value),
        ] if date_value == "0000-00-00"
            && datetime_value == "0000-00-00T00:00:00.000000"
            && timestamp_value == "0000-00-00T00:00:00.000000"
    ));
}

/// Verifies result batches never exceed 256 rows and preserve every streamed row.
#[tokio::test]
async fn caps_batches_at_256_rows() {
    let profile = test_profile();
    let query_id = Uuid::new_v4();
    let events = run_query(
        &profile,
        query_id,
        "WITH RECURSIVE sequence AS (\
             SELECT 1 AS value \
             UNION ALL \
             SELECT value + 1 FROM sequence WHERE value < 300\
         ) SELECT value FROM sequence",
    )
    .await;

    let batch_sizes: Vec<usize> = events
        .iter()
        .filter_map(|event| match event {
            QueryEvent::Batch { rows, .. } => Some(rows.len()),
            _ => None,
        })
        .collect();

    assert_eq!(batch_sizes, vec![256, 44]);
    assert!(
        matches!(events.last(), Some(QueryEvent::Completed { query_id: id, .. }) if *id == query_id)
    );
}

/// Verifies a second row-producing result set fails before its rows can mix schemas.
#[tokio::test]
async fn rejects_a_second_row_producing_result_set() {
    let profile = test_profile();
    let query_id = Uuid::new_v4();
    let events = run_query(&profile, query_id, "SELECT 1 AS a; SELECT 'x' AS b").await;

    assert_eq!(events.len(), 4, "unexpected event stream: {events:?}");
    assert!(matches!(
        &events[1],
        QueryEvent::Schema { columns, .. }
            if columns.len() == 1 && columns[0].name == "a"
    ));
    assert!(
        matches!(
            &events[2],
            QueryEvent::Batch { rows, .. }
                if matches!(rows.as_slice(), [row]
                    if matches!(row.as_slice(), [CellValue::Integer(value)] if value == "1"))
        ),
        "later result rows must not share the first schema: {:?}",
        events[2]
    );
    assert!(matches!(
        &events[3],
        QueryEvent::Failed { error, .. }
            if matches!(error.code, AppErrorCode::Query)
                && error.message == "Multiple result sets are not supported"
                && error.technical_details.is_none()
                && !error.retryable
    ));
}

/// Verifies cancellation closes the active query with Canceled and emits no later batch.
#[tokio::test]
async fn cancellation_is_the_final_event() {
    let profile = test_profile();
    let query_id = Uuid::new_v4();
    let cancellation = CancellationToken::new();
    let task_cancellation = cancellation.clone();
    let (events_tx, mut events_rx) = mpsc::channel(8);
    let task = tokio::spawn(async move {
        MySqlAdapter::new()
            .query(
                &profile,
                SecretString::from("pipa_test_password"),
                QueryRequest {
                    query_id,
                    connection_id: profile.id,
                    sql: "SELECT SLEEP(30)".into(),
                    database: None,
                },
                events_tx,
                task_cancellation,
            )
            .await
    });

    let started = tokio::time::timeout(Duration::from_secs(5), events_rx.recv())
        .await
        .expect("query should start before timeout")
        .expect("started event should arrive");
    assert!(matches!(started, QueryEvent::Started { query_id: id } if id == query_id));
    cancellation.cancel();

    let canceled = tokio::time::timeout(Duration::from_secs(5), events_rx.recv())
        .await
        .expect("cancellation should finish before timeout")
        .expect("canceled event should arrive");
    assert!(matches!(canceled, QueryEvent::Canceled { query_id: id } if id == query_id));
    task.await
        .expect("query task should not panic")
        .expect("cancellation should be a successful query outcome");
    assert!(events_rx.recv().await.is_none());
}

/// Verifies invalid SQL becomes one stable Failed event after Started.
#[tokio::test]
async fn invalid_sql_emits_stable_failed_event() {
    let profile = test_profile();
    let query_id = Uuid::new_v4();
    let events = run_query(&profile, query_id, "SELECT FROM invalid syntax").await;

    assert_eq!(events.len(), 2);
    assert!(matches!(events[0], QueryEvent::Started { query_id: id } if id == query_id));
    assert!(matches!(
        &events[1],
        QueryEvent::Failed { query_id: id, error }
            if *id == query_id
                && matches!(error.code, AppErrorCode::Query)
                && error.message == "Query execution failed"
                && error.technical_details.is_some()
                && !error.retryable
    ));
}

/// Verifies the MCP adapter path rejects writes even after syntactic approval.
#[tokio::test]
async fn readonly_query_uses_a_database_enforced_session() {
    let profile = test_profile();
    let table_name = format!("pipa_readonly_{}", Uuid::new_v4().simple());
    let ddl_table_name = format!("pipa_readonly_ddl_{}", Uuid::new_v4().simple());
    let setup_events = run_query(
        &profile,
        Uuid::new_v4(),
        &format!("CREATE TABLE `{table_name}` (id INT)"),
    )
    .await;
    assert!(matches!(
        setup_events.last(),
        Some(QueryEvent::Completed { .. })
    ));

    let query_id = Uuid::new_v4();
    let events = run_readonly_query(
        &profile,
        query_id,
        &format!("INSERT INTO `{table_name}` VALUES (1)"),
    )
    .await;

    assert!(
        matches!(
            events.as_slice(),
            [
                QueryEvent::Started { query_id: started },
                QueryEvent::Failed {
                    query_id: failed,
                    ..
                }
            ] if *started == query_id && *failed == query_id
        ),
        "unexpected read-only event stream: {events:?}"
    );

    let ddl_query_id = Uuid::new_v4();
    let ddl_events = run_readonly_query(
        &profile,
        ddl_query_id,
        &format!("CREATE TABLE `{ddl_table_name}` (id INT)"),
    )
    .await;
    assert!(
        matches!(
            ddl_events.as_slice(),
            [
                QueryEvent::Started { query_id: started },
                QueryEvent::Failed {
                    query_id: failed,
                    ..
                }
            ] if *started == ddl_query_id && *failed == ddl_query_id
        ),
        "unexpected read-only DDL event stream: {ddl_events:?}"
    );

    let cleanup_events = run_query(
        &profile,
        Uuid::new_v4(),
        &format!("DROP TABLE IF EXISTS `{table_name}`, `{ddl_table_name}`"),
    )
    .await;
    assert!(matches!(
        cleanup_events.last(),
        Some(QueryEvent::Completed { .. })
    ));
}

/// Verifies typed binary/JSON/default writes commit atomically and a later key conflict rolls back.
#[tokio::test]
async fn applies_typed_table_mutations_atomically() {
    let profile = test_profile();
    let table_name = format!("pipa_mutation_{}", Uuid::new_v4().simple());
    let setup = run_query(
        &profile,
        Uuid::new_v4(),
        &format!(
            "CREATE TABLE `{table_name}` (\
                id BIGINT UNSIGNED PRIMARY KEY, \
                token VARBINARY(4) NOT NULL, \
                payload JSON NOT NULL, \
                note VARCHAR(50) NOT NULL DEFAULT 'default-note'\
             ); \
             INSERT INTO `{table_name}` VALUES (18446744073709551615, X'00FF', JSON_OBJECT('id', 1), 'old')"
        ),
    )
    .await;
    assert!(matches!(setup.last(), Some(QueryEvent::Completed { .. })));

    let result = MySqlAdapter::new()
        .apply_table_mutations(
            &profile,
            SecretString::from("pipa_test_password"),
            ApplyTableMutationsInput {
                connection_id: profile.id,
                database: "pipa_test".into(),
                table: table_name.clone(),
                mutations: vec![
                    TableMutation::Update {
                        key: vec![field(
                            "id",
                            TableMutationValue::Integer("18446744073709551615".into()),
                        )],
                        values: vec![
                            field("token", TableMutationValue::Binary("AQID".into())),
                            field(
                                "payload",
                                TableMutationValue::Json("{\"id\":18446744073709551615}".into()),
                            ),
                        ],
                    },
                    TableMutation::Insert {
                        values: vec![
                            field("id", TableMutationValue::Integer("2".into())),
                            field("token", TableMutationValue::Binary("BAUG".into())),
                            field("payload", TableMutationValue::Json("{\"ok\":true}".into())),
                        ],
                    },
                ],
            },
        )
        .await
        .expect("typed mutation transaction should commit");
    assert_eq!(result.applied_mutations, 2);

    let rows = run_query(
        &profile,
        Uuid::new_v4(),
        &format!("SELECT id, token, payload, note FROM `{table_name}` ORDER BY id"),
    )
    .await;
    let QueryEvent::Batch { rows, .. } = &rows[2] else {
        panic!("typed mutation verification should return rows: {rows:?}");
    };
    assert_eq!(rows.len(), 2);
    assert!(matches!(
        rows[0].as_slice(),
        [
            CellValue::Integer(id),
            CellValue::Binary(token),
            CellValue::Json(payload),
            CellValue::Text(note),
        ] if id == "2"
            && token == "BAUG"
            && payload == "{\"ok\": true}"
            && note == "default-note"
    ));
    assert!(matches!(
        rows[1].as_slice(),
        [
            CellValue::Integer(id),
            CellValue::Binary(token),
            CellValue::Json(payload),
            CellValue::Text(note),
        ] if id == "18446744073709551615"
            && token == "AQID"
            && payload.contains("18446744073709551615")
            && note == "old"
    ));

    let conflict = MySqlAdapter::new()
        .apply_table_mutations(
            &profile,
            SecretString::from("pipa_test_password"),
            ApplyTableMutationsInput {
                connection_id: profile.id,
                database: "pipa_test".into(),
                table: table_name.clone(),
                mutations: vec![
                    TableMutation::Insert {
                        values: vec![
                            field("id", TableMutationValue::Integer("3".into())),
                            field("token", TableMutationValue::Binary("BwgJ".into())),
                            field("payload", TableMutationValue::Json("{}".into())),
                        ],
                    },
                    TableMutation::Update {
                        key: vec![field("id", TableMutationValue::Integer("999".into()))],
                        values: vec![field("note", TableMutationValue::Text("never".into()))],
                    },
                ],
            },
        )
        .await
        .expect_err("missing original key should roll the transaction back");
    assert!(conflict.retryable);

    let rolled_back = run_query(
        &profile,
        Uuid::new_v4(),
        &format!("SELECT COUNT(*) FROM `{table_name}` WHERE id = 3"),
    )
    .await;
    assert!(matches!(
        &rolled_back[2],
        QueryEvent::Batch { rows, .. }
            if rows.len() == 1
                && matches!(rows[0].as_slice(), [CellValue::Integer(count)] if count == "0")
    ));

    let cleanup = run_query(
        &profile,
        Uuid::new_v4(),
        &format!("DROP TABLE `{table_name}`"),
    )
    .await;
    assert!(matches!(cleanup.last(), Some(QueryEvent::Completed { .. })));
}

/// Verifies every scalar mutation bind family reaches MySQL with the intended value.
#[tokio::test]
async fn applies_all_scalar_mutation_value_types() {
    let profile = test_profile();
    let table_name = format!("pipa_scalar_mutation_{}", Uuid::new_v4().simple());
    let setup = run_query(
        &profile,
        Uuid::new_v4(),
        &format!(
            "CREATE TABLE `{table_name}` (\
                id INT PRIMARY KEY, \
                enabled BOOLEAN NOT NULL, \
                amount DECIMAL(20,4) NOT NULL, \
                ratio DOUBLE NOT NULL, \
                happened_at DATETIME(6) NOT NULL, \
                optional_note VARCHAR(20) NULL\
             ) ENGINE=InnoDB"
        ),
    )
    .await;
    assert!(matches!(setup.last(), Some(QueryEvent::Completed { .. })));

    let result = MySqlAdapter::new()
        .apply_table_mutations(
            &profile,
            SecretString::from("pipa_test_password"),
            ApplyTableMutationsInput {
                connection_id: profile.id,
                database: "pipa_test".into(),
                table: table_name.clone(),
                mutations: vec![TableMutation::Insert {
                    values: vec![
                        field("id", TableMutationValue::Integer("1".into())),
                        field("enabled", TableMutationValue::Boolean(true)),
                        field(
                            "amount",
                            TableMutationValue::Decimal("1234567890123456.7890".into()),
                        ),
                        field("ratio", TableMutationValue::Float("1.25".into())),
                        field(
                            "happened_at",
                            TableMutationValue::DateTime("2026-08-04T12:34:56.123456".into()),
                        ),
                        field("optional_note", TableMutationValue::Null),
                    ],
                }],
            },
        )
        .await
        .expect("all scalar bind families should commit");
    assert_eq!(result.applied_mutations, 1);

    let rows = run_query(
        &profile,
        Uuid::new_v4(),
        &format!("SELECT enabled, amount, ratio, happened_at, optional_note FROM `{table_name}`"),
    )
    .await;
    assert!(matches!(
        &rows[2],
        QueryEvent::Batch { rows, .. }
            if rows.len() == 1
                && matches!(
                    rows[0].as_slice(),
                    [
                        CellValue::Integer(enabled),
                        CellValue::Decimal(amount),
                        CellValue::Float(ratio),
                        CellValue::DateTime(happened_at),
                        CellValue::Null,
                    ] if enabled == "1"
                        && amount == "1234567890123456.7890"
                        && *ratio == 1.25
                        && happened_at == "2026-08-04T12:34:56.123456"
                )
    ));

    let cleanup = run_query(
        &profile,
        Uuid::new_v4(),
        &format!("DROP TABLE `{table_name}`"),
    )
    .await;
    assert!(matches!(cleanup.last(), Some(QueryEvent::Completed { .. })));
}

/// Verifies non-transactional engines are rejected before any staged row can be written.
#[tokio::test]
async fn rejects_non_transactional_table_mutations() {
    let profile = test_profile();
    let table_name = format!("pipa_myisam_mutation_{}", Uuid::new_v4().simple());
    let setup = run_query(
        &profile,
        Uuid::new_v4(),
        &format!("CREATE TABLE `{table_name}` (id INT PRIMARY KEY) ENGINE=MyISAM"),
    )
    .await;
    assert!(matches!(setup.last(), Some(QueryEvent::Completed { .. })));

    let error = MySqlAdapter::new()
        .apply_table_mutations(
            &profile,
            SecretString::from("pipa_test_password"),
            ApplyTableMutationsInput {
                connection_id: profile.id,
                database: "pipa_test".into(),
                table: table_name.clone(),
                mutations: vec![TableMutation::Insert {
                    values: vec![field("id", TableMutationValue::Integer("1".into()))],
                }],
            },
        )
        .await
        .expect_err("MyISAM cannot provide request-wide rollback semantics");
    assert!(matches!(error.code, AppErrorCode::Validation));

    let rows = run_query(
        &profile,
        Uuid::new_v4(),
        &format!("SELECT COUNT(*) FROM `{table_name}`"),
    )
    .await;
    assert!(matches!(
        &rows[2],
        QueryEvent::Batch { rows, .. }
            if rows.len() == 1
                && matches!(rows[0].as_slice(), [CellValue::Integer(count)] if count == "0")
    ));

    let cleanup = run_query(
        &profile,
        Uuid::new_v4(),
        &format!("DROP TABLE `{table_name}`"),
    )
    .await;
    assert!(matches!(cleanup.last(), Some(QueryEvent::Completed { .. })));
}

/// Creates one named typed field for integration mutation requests.
fn field(name: &str, value: TableMutationValue) -> TableMutationField {
    TableMutationField {
        name: name.into(),
        value,
    }
}

/// Verifies authentication failures use a stable category and redact the supplied password.
#[tokio::test]
async fn authentication_errors_are_stable_and_redacted() {
    let password = "definitely-not-the-password";
    let error = MySqlAdapter::new()
        .test_connection(&test_profile(), &SecretString::from(password))
        .await
        .expect_err("invalid password should fail authentication");

    assert!(matches!(error.code, AppErrorCode::Authentication));
    assert_eq!(error.message, "Authentication failed");
    assert!(!error.retryable);
    assert!(!error
        .technical_details
        .expect("driver details should be retained")
        .contains(password));
}

/// Runs one integration query and collects every emitted event after the sender closes.
async fn run_query(profile: &ConnectionProfile, query_id: Uuid, sql: &str) -> Vec<QueryEvent> {
    let (events_tx, mut events_rx) = mpsc::channel(16);
    MySqlAdapter::new()
        .query(
            profile,
            SecretString::from("pipa_test_password"),
            QueryRequest {
                query_id,
                connection_id: profile.id,
                sql: sql.into(),
                database: None,
            },
            events_tx,
            CancellationToken::new(),
        )
        .await
        .expect("query should complete through its event stream");

    let mut events = Vec::new();
    while let Some(event) = events_rx.recv().await {
        events.push(event);
    }
    events
}

/// Runs one read-only integration query and collects every emitted event.
async fn run_readonly_query(
    profile: &ConnectionProfile,
    query_id: Uuid,
    sql: &str,
) -> Vec<QueryEvent> {
    let (events_tx, mut events_rx) = mpsc::channel(16);
    MySqlAdapter::new()
        .query_readonly(
            profile,
            SecretString::from("pipa_test_password"),
            QueryRequest {
                query_id,
                connection_id: profile.id,
                sql: sql.into(),
                database: None,
            },
            events_tx,
            CancellationToken::new(),
        )
        .await
        .expect("read-only query should complete through its event stream");

    let mut events = Vec::new();
    while let Some(event) = events_rx.recv().await {
        events.push(event);
    }
    events
}

/// Builds the fixed local MySQL integration profile.
fn test_profile() -> ConnectionProfile {
    ConnectionProfile {
        id: Uuid::new_v4(),
        name: "MySQL integration".into(),
        engine: Engine::MySql,
        environment: Environment::Development,
        host: "127.0.0.1".into(),
        port: 33306,
        username: "pipa".into(),
        database: Some("pipa_test".into()),
        tls_mode: TlsMode::Disabled,
    }
}
