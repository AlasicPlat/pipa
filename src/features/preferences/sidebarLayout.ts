import type { Engine } from "../../bindings/Engine";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "pipa.sidebar-collapsed.v1";
const ENGINE_SECTION_COLLAPSE_STORAGE_KEY = "pipa.engine-section-collapse.v1";
const KNOWN_ENGINES: readonly Engine[] = ["my_sql", "postgre_sql", "mongo_db", "redis"];

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
