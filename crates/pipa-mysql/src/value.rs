use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{NaiveDate, NaiveDateTime};
use pipa_core::CellValue;
use sqlx_core::{row::Row, value::ValueRef};
use sqlx_mysql::{types::MySqlTime, MySqlRow};

/// Conversion family selected from SQLx's stable MySQL type names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ValueKind {
    Boolean,
    Integer,
    Decimal,
    Float32,
    Float64,
    Json,
    Binary,
    Date,
    Time,
    DateTime,
    Text,
    Null,
}

/// Classifies a SQLx MySQL database type into its transport conversion family.
fn classify_type(database_type: &str) -> ValueKind {
    match database_type {
        "BOOLEAN" => ValueKind::Boolean,
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "TINYINT UNSIGNED"
        | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED"
        | "YEAR" => ValueKind::Integer,
        "DECIMAL" | "NEWDECIMAL" => ValueKind::Decimal,
        "FLOAT" => ValueKind::Float32,
        "DOUBLE" => ValueKind::Float64,
        "JSON" => ValueKind::Json,
        "BIT" | "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB"
        | "GEOMETRY" => ValueKind::Binary,
        "DATE" => ValueKind::Date,
        "TIME" => ValueKind::Time,
        "DATETIME" | "TIMESTAMP" => ValueKind::DateTime,
        "NULL" => ValueKind::Null,
        _ => ValueKind::Text,
    }
}

/// Converts an integer-like value to its lossless decimal-string cell.
fn integer_cell(value: impl ToString) -> CellValue {
    CellValue::Integer(value.to_string())
}

/// Converts a floating-point value to the transport float cell.
fn float_cell(value: impl Into<f64>) -> CellValue {
    CellValue::Float(value.into())
}

/// Base64-encodes opaque MySQL bytes for JSON-safe transport.
fn binary_cell(value: &[u8]) -> CellValue {
    CellValue::Binary(STANDARD.encode(value))
}

/// Converts MySQL text bytes, marking only invalid UTF-8 with replacement characters.
fn text_cell(value: &[u8]) -> CellValue {
    let text = match std::str::from_utf8(value) {
        Ok(text) => text.to_owned(),
        Err(_) => String::from_utf8_lossy(value).into_owned(),
    };
    CellValue::Text(text)
}

/// Converts one dynamically typed SQLx MySQL cell into Pipa's lossless transport value.
pub(crate) fn convert_cell(
    row: &MySqlRow,
    index: usize,
    database_type: &str,
) -> Result<CellValue, sqlx_core::Error> {
    if row.try_get_raw(index)?.is_null() {
        return Ok(CellValue::Null);
    }

    Ok(match classify_type(database_type) {
        ValueKind::Boolean => CellValue::Boolean(row.try_get_unchecked::<bool, _>(index)?),
        ValueKind::Integer if database_type.ends_with("UNSIGNED") || database_type == "YEAR" => {
            integer_cell(row.try_get_unchecked::<u64, _>(index)?)
        }
        ValueKind::Integer => integer_cell(row.try_get_unchecked::<i64, _>(index)?),
        ValueKind::Decimal => CellValue::Decimal(row.try_get_unchecked::<String, _>(index)?),
        ValueKind::Float32 => float_cell(row.try_get_unchecked::<f32, _>(index)?),
        ValueKind::Float64 => float_cell(row.try_get_unchecked::<f64, _>(index)?),
        ValueKind::Json => CellValue::Json(row.try_get::<serde_json::Value, _>(index)?),
        ValueKind::Binary => binary_cell(&row.try_get_unchecked::<Vec<u8>, _>(index)?),
        ValueKind::Date => CellValue::DateTime(
            row.try_get::<NaiveDate, _>(index)?
                .format("%Y-%m-%d")
                .to_string(),
        ),
        ValueKind::Time => CellValue::DateTime(row.try_get::<MySqlTime, _>(index)?.to_string()),
        ValueKind::DateTime => CellValue::DateTime(
            row.try_get::<NaiveDateTime, _>(index)?
                .format("%Y-%m-%dT%H:%M:%S%.f")
                .to_string(),
        ),
        ValueKind::Text => text_cell(&row.try_get_unchecked::<Vec<u8>, _>(index)?),
        ValueKind::Null => CellValue::Null,
    })
}

#[cfg(test)]
mod tests {
    use super::{binary_cell, classify_type, float_cell, integer_cell, text_cell, ValueKind};
    use pipa_core::CellValue;

    /// Verifies signed and unsigned MySQL integer families use lossless integer strings.
    #[test]
    fn classifies_integer_families() {
        for database_type in [
            "TINYINT",
            "SMALLINT",
            "MEDIUMINT",
            "INT",
            "BIGINT",
            "TINYINT UNSIGNED",
            "SMALLINT UNSIGNED",
            "MEDIUMINT UNSIGNED",
            "INT UNSIGNED",
            "BIGINT UNSIGNED",
            "YEAR",
        ] {
            assert_eq!(classify_type(database_type), ValueKind::Integer);
        }
        assert!(matches!(integer_cell(18_u64), CellValue::Integer(value) if value == "18"));
    }

    /// Verifies exact MySQL decimals stay decimal strings.
    #[test]
    fn classifies_exact_decimals() {
        assert_eq!(classify_type("DECIMAL"), ValueKind::Decimal);
        assert_eq!(classify_type("NEWDECIMAL"), ValueKind::Decimal);
    }

    /// Verifies MySQL floating families become transport-safe f64 cells.
    #[test]
    fn classifies_floating_values() {
        assert_eq!(classify_type("FLOAT"), ValueKind::Float32);
        assert_eq!(classify_type("DOUBLE"), ValueKind::Float64);
        assert!(matches!(float_cell(1.5), CellValue::Float(value) if value == 1.5));
    }

    /// Verifies JSON uses structured JSON transport values.
    #[test]
    fn classifies_json_values() {
        assert_eq!(classify_type("JSON"), ValueKind::Json);
    }

    /// Verifies every binary family is base64 encoded.
    #[test]
    fn classifies_and_encodes_binary_values() {
        for database_type in [
            "BIT",
            "BINARY",
            "VARBINARY",
            "TINYBLOB",
            "BLOB",
            "MEDIUMBLOB",
            "LONGBLOB",
            "GEOMETRY",
        ] {
            assert_eq!(classify_type(database_type), ValueKind::Binary);
        }
        assert!(matches!(binary_cell(&[0, 255]), CellValue::Binary(value) if value == "AP8="));
    }

    /// Verifies date and time families use date-time transport strings.
    #[test]
    fn classifies_date_and_time_values() {
        assert_eq!(classify_type("DATE"), ValueKind::Date);
        assert_eq!(classify_type("TIME"), ValueKind::Time);
        assert_eq!(classify_type("DATETIME"), ValueKind::DateTime);
        assert_eq!(classify_type("TIMESTAMP"), ValueKind::DateTime);
    }

    /// Verifies text families preserve UTF-8 and mark replacement only after invalid decoding.
    #[test]
    fn classifies_text_and_replaces_invalid_utf8() {
        for database_type in [
            "CHAR",
            "VARCHAR",
            "TINYTEXT",
            "TEXT",
            "MEDIUMTEXT",
            "LONGTEXT",
            "ENUM",
            "SET",
        ] {
            assert_eq!(classify_type(database_type), ValueKind::Text);
        }
        assert!(matches!(text_cell(b"Pipa"), CellValue::Text(value) if value == "Pipa"));
        assert!(matches!(text_cell(&[b'P', 0xff]), CellValue::Text(value) if value == "P�"));
    }

    /// Verifies BOOLEAN is distinct from other TINYINT columns.
    #[test]
    fn classifies_boolean_values() {
        assert_eq!(classify_type("BOOLEAN"), ValueKind::Boolean);
    }

    /// Verifies SQL NULL is a dedicated conversion category.
    #[test]
    fn classifies_sql_null() {
        assert_eq!(classify_type("NULL"), ValueKind::Null);
    }
}
