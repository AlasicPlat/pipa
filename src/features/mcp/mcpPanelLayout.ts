const MCP_PANEL_WIDE_STORAGE_KEY = "pipa.mcp-panel-wide.v1";

/**
 * Loads whether the MCP console should open in its wide review layout.
 *
 * Reviewing SQL is the panel's most demanding task, so a user who widened the panel once should not
 * have to widen it again on every approval.
 * Parameters: none.
 * @returns `true` when the user last left the console wide.
 * Side effects: reads `localStorage` when available.
 */
export function loadMcpPanelWide(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(MCP_PANEL_WIDE_STORAGE_KEY) === "1";
  } catch (error) {
    console.warn("[mcp] Failed to load panel width; defaulting to compact.", { error });
    return false;
  }
}

/**
 * Persists the MCP console layout choice for the next session.
 * @param wide - Whether the console is currently in its wide layout.
 * @returns Nothing (`void`).
 * Side effects: writes `localStorage` when available.
 */
export function persistMcpPanelWide(wide: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(MCP_PANEL_WIDE_STORAGE_KEY, wide ? "1" : "0");
  } catch (error) {
    console.warn("[mcp] Failed to persist panel width.", { error });
  }
}
