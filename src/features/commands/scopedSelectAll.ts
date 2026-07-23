/**
 * Returns whether the event target already owns native text select-all.
 * @param target - Keyboard event target or current active element.
 * @returns `true` for inputs, textareas, contenteditable nodes, and Monaco.
 * Side effects: none.
 */
export function isNativeTextSelectTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.closest(".monaco-editor")) {
    return true;
  }
  return target.matches("input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='reset']), textarea, [contenteditable='true']");
}

/**
 * Returns whether a focused control already implements app-scoped Mod+A.
 * @param target - Keyboard event target or current active element.
 * @returns `true` for table data grids and query result grids.
 * Side effects: none.
 */
export function isAppSelectAllRegion(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest(".editable-grid, .result-grid"));
}

/**
 * Finds the nearest declarative selectable text block for scoped Mod+A.
 * @param target - Keyboard event target or current active element.
 * @returns The selectable surface element, or `null` when none applies.
 * Side effects: none.
 */
export function findSelectableTextSurface(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const block = target.closest<HTMLElement>("[data-selectable-block]");
  if (!block) {
    return null;
  }
  if (block.matches("[data-selectable-surface], textarea, pre")) {
    return block;
  }
  return block.querySelector<HTMLElement>("[data-selectable-surface], textarea, pre");
}

/**
 * Selects every character inside a text surface without involving the document chrome.
 * @param surface - Focusable textarea or static text element marked as selectable.
 * @returns Nothing (`void`).
 * Side effects: focuses the surface and updates the browser selection or textarea selection.
 */
export function selectTextSurfaceContents(surface: HTMLElement): void {
  if (surface instanceof HTMLTextAreaElement || surface instanceof HTMLInputElement) {
    surface.focus();
    surface.select();
    return;
  }
  surface.focus();
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(surface);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Handles Mod+A by scoping selection to the focused region instead of the whole page.
 * @param event - Captured document keyboard event.
 * @param matchesSelectAll - Predicate for the current select-all binding (usually Mod+A).
 * @returns `true` when this helper consumed the event.
 * Side effects: may prevent the browser default and rewrite the current selection.
 */
export function handleScopedSelectAll(
  event: KeyboardEvent,
  matchesSelectAll: (event: KeyboardEvent) => boolean,
): boolean {
  if (!matchesSelectAll(event) || event.defaultPrevented) {
    return false;
  }
  if (document.querySelector("[aria-modal='true']")) {
    return false;
  }

  const focusTarget = event.target instanceof Element ? event.target : document.activeElement;
  if (isNativeTextSelectTarget(focusTarget)) {
    // Inputs, textareas, and Monaco keep the browser's in-control select-all.
    return false;
  }
  if (isAppSelectAllRegion(focusTarget)) {
    // Grids own Mod+A on bubble; still block document-wide selection here.
    event.preventDefault();
    return true;
  }

  const surface = findSelectableTextSurface(focusTarget);
  if (surface) {
    event.preventDefault();
    selectTextSurfaceContents(surface);
    return true;
  }

  // Keep desktop chrome from being selected when focus is outside a text region.
  event.preventDefault();
  return true;
}
