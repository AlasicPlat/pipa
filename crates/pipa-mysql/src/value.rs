use base64::{engine::general_purpose::STANDARD, Engine as _};
use pipa_core::CellValue;
use sqlx_core::{row::Row, type_info::TypeInfo, types::Type, value::ValueRef};
use sqlx_mysql::{MySql, MySqlRow, MySqlTypeInfo};

/// Conversion family selected from SQLx's stable MySQL type names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ValueKind {
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

/// 根据 SQLx 类型名称与真实字符集兼容性选择传输类型。
///
/// # 参数
/// `database_type` 是 SQLx 根据 MySQL 字段标志生成的类型名称。
/// `text_compatible` 表示字段的 collation 是否允许按字符串解码。
///
/// # 返回值
/// 返回单元格应采用的无损传输类型。
///
/// # 副作用
/// 无。
fn classify_type(database_type: &str, text_compatible: bool) -> ValueKind {
    // MySQL 会给 utf8mb3_bin 等文本元数据设置 BINARY 标志，SQLx 因而把类型名称
    // 报告为 VARBINARY；真实 collation 仍可区分这些文本与 binary 字符集。
    if text_compatible {
        return ValueKind::Text;
    }

    match normalize_database_type(database_type) {
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

/// 将 SQLx 含义不明确的 `BOOLEAN` 标签还原为 MySQL 线协议中的整数类型。
///
/// # 参数
/// `database_type` 是 SQLx 元数据返回的稳定类型名称。
///
/// # 返回值
/// `BOOLEAN` 返回 `TINYINT`，其他类型返回原始借用名称。
///
/// # 副作用
/// 无。
pub(crate) fn normalize_database_type(database_type: &str) -> &str {
    if database_type == "BOOLEAN" {
        "TINYINT"
    } else {
        database_type
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
    CellValue::Text(String::from_utf8_lossy(value).into_owned())
}

/// Preserves MySQL temporal text in its native readable representation.
fn temporal_cell(value: &[u8]) -> CellValue {
    CellValue::DateTime(String::from_utf8_lossy(value).into_owned())
}

/// 将一个动态 SQLx MySQL 单元格转换为 Pipa 的无损传输值。
///
/// # 参数
/// `row` 是当前 MySQL 结果行，`index` 是字段位置，`type_info` 是完整 SQLx 类型信息。
///
/// # 返回值
/// 返回保留数值精度、文本语义与二进制字节的单元格值；解码失败时返回 SQLx 错误。
///
/// # 副作用
/// 无。
pub(crate) fn convert_cell(
    row: &MySqlRow,
    index: usize,
    type_info: &MySqlTypeInfo,
) -> Result<CellValue, sqlx_core::Error> {
    if row.try_get_raw(index)?.is_null() {
        return Ok(CellValue::Null);
    }

    let database_type = normalize_database_type(type_info.name());
    let text_compatible = <String as Type<MySql>>::compatible(type_info);
    Ok(match classify_type(database_type, text_compatible) {
        ValueKind::Integer if database_type.ends_with("UNSIGNED") || database_type == "YEAR" => {
            integer_cell(row.try_get_unchecked::<u64, _>(index)?)
        }
        ValueKind::Integer => integer_cell(row.try_get_unchecked::<i64, _>(index)?),
        ValueKind::Decimal => CellValue::Decimal(row.try_get_unchecked::<String, _>(index)?),
        ValueKind::Float32 => float_cell(row.try_get_unchecked::<f32, _>(index)?),
        ValueKind::Float64 => float_cell(row.try_get_unchecked::<f64, _>(index)?),
        ValueKind::Json => CellValue::Json(row.try_get_unchecked::<String, _>(index)?),
        ValueKind::Binary => binary_cell(&row.try_get_unchecked::<Vec<u8>, _>(index)?),
        ValueKind::Date | ValueKind::Time | ValueKind::DateTime => {
            temporal_cell(&row.try_get_unchecked::<Vec<u8>, _>(index)?)
        }
        ValueKind::Text => text_cell(&row.try_get_unchecked::<Vec<u8>, _>(index)?),
        ValueKind::Null => CellValue::Null,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        binary_cell, classify_type, float_cell, integer_cell, normalize_database_type,
        temporal_cell, text_cell, ValueKind,
    };
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
            assert_eq!(classify_type(database_type, false), ValueKind::Integer);
        }
        assert!(matches!(integer_cell(18_u64), CellValue::Integer(value) if value == "18"));
    }

    /// Verifies exact MySQL decimals stay decimal strings.
    #[test]
    fn classifies_exact_decimals() {
        assert_eq!(classify_type("DECIMAL", false), ValueKind::Decimal);
        assert_eq!(classify_type("NEWDECIMAL", false), ValueKind::Decimal);
    }

    /// Verifies MySQL floating families become transport-safe f64 cells.
    #[test]
    fn classifies_floating_values() {
        assert_eq!(classify_type("FLOAT", false), ValueKind::Float32);
        assert_eq!(classify_type("DOUBLE", false), ValueKind::Float64);
        assert!(matches!(float_cell(1.5), CellValue::Float(value) if value == 1.5));
    }

    /// Verifies JSON uses raw text so JavaScript cannot round large numbers.
    #[test]
    fn classifies_json_values() {
        assert_eq!(classify_type("JSON", false), ValueKind::Json);
        let raw = "{\"id\":18446744073709551615}".to_owned();
        assert!(matches!(CellValue::Json(raw.clone()), CellValue::Json(value) if value == raw));
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
            assert_eq!(classify_type(database_type, false), ValueKind::Binary);
        }
        assert!(matches!(binary_cell(&[0, 255]), CellValue::Binary(value) if value == "AP8="));
    }

    /// Verifies date and time families use date-time transport strings.
    #[test]
    fn classifies_date_and_time_values() {
        assert_eq!(classify_type("DATE", false), ValueKind::Date);
        assert_eq!(classify_type("TIME", false), ValueKind::Time);
        assert_eq!(classify_type("DATETIME", false), ValueKind::DateTime);
        assert_eq!(classify_type("TIMESTAMP", false), ValueKind::DateTime);
        assert!(matches!(
            temporal_cell(b"0000-00-00 00:00:00.000000"),
            CellValue::DateTime(value) if value == "0000-00-00 00:00:00.000000"
        ));
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
            assert_eq!(classify_type(database_type, true), ValueKind::Text);
        }
        assert!(matches!(text_cell(b"Pipa"), CellValue::Text(value) if value == "Pipa"));
        assert!(matches!(text_cell(&[b'P', 0xff]), CellValue::Text(value) if value == "P�"));
    }

    /// 验证 SQLx 含义不明确的 BOOLEAN 标签仍按整数型 TINYINT 处理。
    #[test]
    fn normalizes_boolean_as_tinyint() {
        assert_eq!(normalize_database_type("BOOLEAN"), "TINYINT");
        assert_eq!(classify_type("BOOLEAN", false), ValueKind::Integer);
    }

    /// Verifies SQL NULL is a dedicated conversion category.
    #[test]
    fn classifies_sql_null() {
        assert_eq!(classify_type("NULL", false), ValueKind::Null);
    }

    /// 验证带 BINARY 标志但拥有文本 collation 的 MySQL 元数据仍按字符串传输。
    #[test]
    fn classifies_binary_flagged_text_metadata_as_text() {
        assert_eq!(classify_type("VARBINARY", true), ValueKind::Text);
        assert_eq!(classify_type("BLOB", true), ValueKind::Text);
        assert_eq!(classify_type("VARBINARY", false), ValueKind::Binary);
        assert_eq!(classify_type("BLOB", false), ValueKind::Binary);
    }
}
