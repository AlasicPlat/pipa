const FOCUSED_CONNECTION_STORAGE_KEY = "pipa.focused-connection.v1";
const FOCUSED_DATABASES_STORAGE_KEY = "pipa.focused-databases.v1";

/** Caps stored per-connection schema choices so a long-lived profile list cannot grow storage. */
const MAX_PERSISTED_FOCUSED_DATABASES = 100;

/**
 * Loads the connection the workspace was focused on when it last closed.
 *
 * The navigator now shows one connection at a time, so this is the single piece of state that
 * decides what the user sees on launch.
 * Parameters: none.
 * @returns The saved connection id, or null when unset or unreadable.
 * Side effects: reads `localStorage` when available.
 */
export function loadFocusedConnectionId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const stored = window.localStorage.getItem(FOCUSED_CONNECTION_STORAGE_KEY);
    return stored && stored !== "" ? stored : null;
  } catch (error) {
    console.warn("[workspace] Failed to load the focused connection.", { error });
    return null;
  }
}

/**
 * Persists the focused connection so the next session opens in the same place.
 * @param connectionId - Connection now in focus, or null to forget the previous one.
 * @returns Nothing (`void`).
 * Side effects: writes `localStorage` when available.
 */
export function persistFocusedConnectionId(connectionId: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (connectionId) {
      window.localStorage.setItem(FOCUSED_CONNECTION_STORAGE_KEY, connectionId);
    } else {
      window.localStorage.removeItem(FOCUSED_CONNECTION_STORAGE_KEY);
    }
  } catch (error) {
    console.warn("[workspace] Failed to persist the focused connection.", { error });
  }
}

/**
 * Loads the schema each connection was last browsing.
 *
 * Recording this per connection means switching away and back returns to the same schema rather
 * than resetting to the profile default.
 * Parameters: none.
 * @returns Connection id → schema name; empty when unset or unreadable.
 * Side effects: reads `localStorage` when available.
 */
export function loadFocusedDatabases(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const serialized = window.localStorage.getItem(FOCUSED_DATABASES_STORAGE_KEY);
    if (!serialized) {
      return {};
    }
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => (
        entry[0] !== "" && typeof entry[1] === "string" && entry[1] !== ""
      ));
    return Object.fromEntries(entries);
  } catch (error) {
    console.warn("[workspace] Failed to load per-connection schema choices.", { error });
    return {};
  }
}

/**
 * Persists the schema each connection is browsing.
 * @param databases - Connection id → schema name.
 * @returns Nothing (`void`).
 * Side effects: writes `localStorage` when available.
 */
export function persistFocusedDatabases(databases: Readonly<Record<string, string>>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const payload = Object.fromEntries(
      Object.entries(databases).slice(0, MAX_PERSISTED_FOCUSED_DATABASES),
    );
    window.localStorage.setItem(FOCUSED_DATABASES_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("[workspace] Failed to persist per-connection schema choices.", { error });
  }
}
