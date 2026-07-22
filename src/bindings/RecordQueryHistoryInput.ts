// Explicit transport mirror of pipa_core::RecordQueryHistoryInput.

/**
 * Stable query context recorded after its matching backend execution starts.
 */
export type RecordQueryHistoryInput = {
/**
 * Query identifier reused as the idempotent history-entry identifier.
 */
queryId: string,
/**
 * Immutable connection associated with the executing query tab.
 */
connectionId: string,
/**
 * Exact selected statement or editor selection sent for execution.
 */
sql: string, };
