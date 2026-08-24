import type { Engine } from "../../bindings/Engine";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "pipa.sidebar-collapsed.v1";
const SIDEBAR_WIDTH_STORAGE_KEY = "pipa.sidebar-width.v1";
const ENGINE_SECTION_COLLAPSE_STORAGE_KEY = "pipa.engine-section-collapse.v1";
const EXPANDED_CONNECTIONS_STORAGE_KEY = "pipa.expanded-connections.v1";
const KNOWN_ENGINES: readonly Engine[] = ["my_sql", "postgre_sql", "mongo_db", "redis"];

/** Caps persisted expansion so a long-lived profile list cannot grow storage without bound. */
const MAX_PERSISTED_EXPANDED_CONNECTIONS = 50;

/** Sidebar width bounds; kept in sync with `--sidebar-width-*` in `tokens.css`. */
export const SIDEBAR_WIDTH_DEFAULT = 316;
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 560;

/**
 * Constrains any candidate width to the supported sidebar range.
 * @param width - Candidate pixel width from a drag, keyboard step, or storage.
 * @returns An integer width within the inclusive supported bounds.
 * Side effects: none.
 */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return SIDEBAR_WIDTH_DEFAULT;
  }
  return Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width)));
}

/**
 * Loads the user's saved connection-sidebar width.
 * Parameters: none.
 * @returns The persisted width, or the default when unset, invalid, or unreadable.
 * Side effects: reads `localStorage` when available.
 */
export function loadSidebarWidth(): number {
  if (typeof window === "undefined") {
    return SIDEBAR_WIDTH_DEFAULT;
  }
  try {
    const serialized = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!serialized) {
      return SIDEBAR_WIDTH_DEFAULT;
    }
    const parsed = Number.parseInt(serialized, 10);
    return Number.isNaN(parsed) ? SIDEBAR_WIDTH_DEFAULT : clampSidebarWidth(parsed);
  } catch (error) {
    console.warn("[sidebar] Failed to load width; using the default.", { error });
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

/**
 * Persists the connection-sidebar width for the next session.
 * @param width - Width chosen by dragging or keyboard adjustment.
 * @returns Nothing (`void`).
 * Side effects: writes `localStorage` when available.
 */
export function persistSidebarWidth(width: number): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch (error) {
    console.warn("[sidebar] Failed to persist width.", { error });
  }
}

/**
 * Loads whether the connection sidebar should start collapsed.
 * Parameters: none.
 * @returns `true` when the user last left the sidebar collapsed.
 * Side effects: reads `localStorage` when available.
 */
export function loadSidebarCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch (error) {
    console.warn("[sidebar] Failed to load collapsed state; defaulting to expanded.", { error });
    return false;
  }
}

/**
 * Persists the connection sidebar collapsed flag for the next session.
 * @param collapsed - Whether the sidebar is currently collapsed.
 * @returns Nothing (`void`).
 * Side effects: writes `localStorage` when available.
 */
export function persistSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch (error) {
    console.warn("[sidebar] Failed to persist collapsed state.", { error });
  }
}

/**
 * Loads per-engine section collapse overrides chosen by the user.
 * Parameters: none.
 * @returns A map of engine → collapsed; empty when the user has never toggled a section.
 * Side effects: reads `localStorage` when available.
 */
export function loadEngineSectionCollapseOverrides(): Map<Engine, boolean> {
  if (typeof window === "undefined") {
    return new Map();
  }
  try {
    const serialized = window.localStorage.getItem(ENGINE_SECTION_COLLAPSE_STORAGE_KEY);
    if (!serialized) {
      return new Map();
    }
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return new Map();
    }
    const overrides = new Map<Engine, boolean>();
    for (const engine of KNOWN_ENGINES) {
      const value = (parsed as Record<string, unknown>)[engine];
      if (typeof value === "boolean") {
        overrides.set(engine, value);
      }
    }
    return overrides;
  } catch (error) {
    console.warn("[sidebar] Failed to load engine-section collapse overrides.", { error });
    return new Map();
  }
}

/**
 * Persists per-engine section collapse overrides for the next session.
 * @param overrides - Explicit collapsed/expanded choices keyed by engine.
 * @returns Nothing (`void`).
 * Side effects: writes `localStorage` when available.
 */
export function persistEngineSectionCollapseOverrides(overrides: ReadonlyMap<Engine, boolean>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const payload = Object.fromEntries(overrides.entries());
    window.localStorage.setItem(ENGINE_SECTION_COLLAPSE_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("[sidebar] Failed to persist engine-section collapse overrides.", { error });
  }
}

/**
 * Loads the connection ids whose object drawers were left open.
 * Parameters: none.
 * @returns Saved connection ids; empty when unset or unreadable.
 * Side effects: reads `localStorage` when available.
 */
export function loadExpandedConnectionIds(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const serialized = window.localStorage.getItem(EXPANDED_CONNECTIONS_STORAGE_KEY);
    if (!serialized) {
      return new Set();
    }
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id !== ""));
  } catch (error) {
    console.warn("[sidebar] Failed to load expanded connections.", { error });
    return new Set();
  }
}

/**
 * Persists which connection drawers are open so a reload restores the user's place.
 * @param connectionIds - Currently expanded connection ids.
 * @returns Nothing (`void`).
 * Side effects: writes `localStorage` when available.
 */
export function persistExpandedConnectionIds(connectionIds: ReadonlySet<string>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const payload = [...connectionIds].slice(0, MAX_PERSISTED_EXPANDED_CONNECTIONS);
    window.localStorage.setItem(EXPANDED_CONNECTIONS_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("[sidebar] Failed to persist expanded connections.", { error });
  }
}
