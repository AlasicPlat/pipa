const PINNED_TABLES_STORAGE_KEY = "pipa:pinned-tables";

/**
 * Loads persisted table identities while tolerating unavailable or malformed local storage.
 * Parameters: none.
 * @returns A mutable set for React state initialization.
 * Side effects: reads browser-local preferences.
 */
export function loadPinnedTables(): Set<string> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PINNED_TABLES_STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Persists the exact ordered set of pinned connection/table identities.
 * @param pinnedTables - Current connection-bound table keys.
 * @returns Nothing (`void`).
 * Side effects: updates browser-local preferences when storage is available.
 */
export function persistPinnedTables(pinnedTables: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(PINNED_TABLES_STORAGE_KEY, JSON.stringify([...pinnedTables]));
  } catch {
    // Pinning remains available for this session when browser storage is unavailable.
  }
}
