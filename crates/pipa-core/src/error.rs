use serde::{Deserialize, Serialize};
use std::{error::Error, fmt};
use ts_rs::TS;

/// Stable categories used by all Pipa domain errors.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AppErrorCode {
    /// User input failed validation.
    Validation,
    /// A database connection could not be established.
    Connection,
    /// Database authentication failed.
    Authentication,
    /// The operation was denied by permissions.
    Permission,
    /// The operation exceeded its allowed duration.
    Timeout,
    /// Query execution failed.
    Query,
    /// Local persistence or credential storage failed.
    Storage,
    /// The requested resource does not exist.
    NotFound,
    /// The operation was canceled.
    Canceled,
    /// An unexpected internal failure occurred.
    Internal,
}

/// Stable, user-facing error returned across application boundaries.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppError {
    /// Machine-readable error category.
    pub code: AppErrorCode,
    /// Safe message intended for display to the user.
    pub message: String,
    /// Optional redacted diagnostic context for local troubleshooting.
    pub technical_details: Option<String>,
    /// Whether retrying the same operation may succeed.
    pub retryable: bool,
}

impl fmt::Display for AppError {
    /// Displays only the safe user-facing message.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for AppError {}

#[cfg(test)]
mod tests {
    use super::{AppError, AppErrorCode};
    use serde_json::json;
    use ts_rs::{Config, TS};

    /// Verifies stable error JSON, including camelCase technical details.
    #[test]
    fn app_error_uses_stable_camel_case_json() {
        let error = AppError {
            code: AppErrorCode::Authentication,
            message: "Could not authenticate".into(),
            technical_details: Some("redacted driver context".into()),
            retryable: false,
        };

        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({
                "code": "authentication",
                "message": "Could not authenticate",
                "technicalDetails": "redacted driver context",
                "retryable": false
            })
        );
    }

    /// Verifies that displaying an error does not expose technical details.
    #[test]
    fn app_error_display_uses_only_user_message() {
        let error = AppError {
            code: AppErrorCode::Internal,
            message: "Something went wrong".into(),
            technical_details: Some("sensitive context".into()),
            retryable: false,
        };

        assert_eq!(error.to_string(), "Something went wrong");
        assert!(!error.to_string().contains("sensitive context"));
    }

    /// Verifies the TypeScript contract uses camelCase fields and snake_case codes.
    #[test]
    fn app_error_typescript_contract_matches_json() {
        let config = Config::default();

        assert!(AppError::decl(&config).contains("technicalDetails"));
        assert!(AppErrorCode::decl(&config).contains("\"not_found\""));
    }
}
