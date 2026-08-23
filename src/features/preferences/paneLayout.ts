const EDITOR_SPLIT_STORAGE_KEY = "pipa.query-editor-split.v1";

/**
 * Editor pane bounds, expressed as a percentage of the workspace's usable height.
 *
 * A ratio is stored rather than a pixel height so the split keeps its
 * proportions when the window is resized or the app reopens on another display.
 */
export const EDITOR_SPLIT_DEFAULT = 44;
export const EDITOR_SPLIT_MIN = 20;
export const EDITOR_SPLIT_MAX = 80;

/**
 * Constrains any candidate ratio to the supported editor-pane range.
 * @param ratio - Candidate percentage from a drag, keyboard step, or storage.
 * @returns An integer percentage within the inclusive supported bounds.
 * Side effects: none.
 */
export function clampEditorSplit(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return EDITOR_SPLIT_DEFAULT;
  }
  return Math.round(Math.min(EDITOR_SPLIT_MAX, Math.max(EDITOR_SPLIT_MIN, ratio)));
}

/**
 * Loads the user's saved editor/results split ratio.
 * Parameters: none.
 * @returns The persisted percentage, or the default when unset, invalid, or unreadable.
 * Side effects: reads `localStorage` when available.
 */
export function loadEditorSplit(): number {
  if (typeof window === "undefined") {
    return EDITOR_SPLIT_DEFAULT;
  }
  try {
    const serialized = window.localStorage.getItem(EDITOR_SPLIT_STORAGE_KEY);
    if (!serialized) {
      return EDITOR_SPLIT_DEFAULT;
    }
    const parsed = Number.parseInt(serialized, 10);
    return Number.isNaN(parsed) ? EDITOR_SPLIT_DEFAULT : clampEditorSplit(parsed);
  } catch (error) {
    console.warn("[panes] Failed to load the editor split; using the default.", { error });
    return EDITOR_SPLIT_DEFAULT;
  }
}

/**
 * Persists the editor/results split ratio for the next session.
 * @param ratio - Percentage chosen by dragging or keyboard adjustment.
 * @returns Nothing (`void`).
 * Side effects: writes `localStorage` when available.
 */
export function persistEditorSplit(ratio: number): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(EDITOR_SPLIT_STORAGE_KEY, String(clampEditorSplit(ratio)));
  } catch (error) {
    console.warn("[panes] Failed to persist the editor split.", { error });
  }
}
