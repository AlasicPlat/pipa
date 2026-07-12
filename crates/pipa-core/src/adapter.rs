use crate::{AppError, ConnectionProfile, Engine, QueryEvent, QueryRequest};
use secrecy::SecretString;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Framework-free boundary implemented by each supported database engine.
#[async_trait::async_trait]
pub trait DatabaseAdapter: Send + Sync {
    /// Returns the database engine implemented by this adapter.
    fn engine(&self) -> Engine;

    /// Tests whether a profile and password can establish a database connection.
    ///
    /// The password is borrowed and must not be retained or logged.
    async fn test_connection(
        &self,
        profile: &ConnectionProfile,
        password: &SecretString,
    ) -> Result<(), AppError>;

    /// Executes a query and sends ordered events until completion, cancellation, or failure.
    ///
    /// The owned password must not be retained or logged. Implementations observe `cancellation`
    /// and send events through `events`; channel sends are the only intended side effect.
    async fn query(
        &self,
        profile: &ConnectionProfile,
        password: SecretString,
        request: QueryRequest,
        events: mpsc::Sender<QueryEvent>,
        cancellation: CancellationToken,
    ) -> Result<(), AppError>;
}
