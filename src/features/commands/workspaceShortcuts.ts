import {
  matchesShortcut,
  type KeyboardShortcutEvent,
  type ShortcutBindings,
} from "./shortcutRegistry";

/** What one global key press asks the shell to do. */
export type WorkspaceShortcutIntent =
  | { kind: "openCommandPalette" }
  | { kind: "openShortcutHelp" }
  | { kind: "toggleSidebar" }
  | { kind: "newQuery" }
  | { kind: "closeWorkspace" }
  | { kind: "jumpToTab"; position: number }
  | { kind: "cycleTabs"; reverse: boolean };

/**
 * Decides which global workspace action one key press requests.
 *
 * Positional jumps (Mod+1…9) are checked against the raw modifiers rather than a binding, because
 * they are deliberately fixed rather than rebindable, matching platform tab strips. Order matters:
 * a user-configured binding wins over the positional digits.
 * @param event - The key press to interpret.
 * @param bindings - Current user key bindings.
 * @returns The requested action, or `null` when the press is not a workspace shortcut.
 */
export function resolveWorkspaceShortcut(
  event: KeyboardShortcutEvent,
  bindings: ShortcutBindings,
): WorkspaceShortcutIntent | null {
  if (matchesShortcut(event, bindings.commandPalette)) {
    return { kind: "openCommandPalette" };
  }
  if (matchesShortcut(event, bindings.shortcutHelp)) {
    return { kind: "openShortcutHelp" };
  }
  if (matchesShortcut(event, bindings.toggleSidebar)) {
    return { kind: "toggleSidebar" };
  }
  if (matchesShortcut(event, bindings.newQuery)) {
    return { kind: "newQuery" };
  }
  if (matchesShortcut(event, bindings.closeWorkspace)) {
    return { kind: "closeWorkspace" };
  }
  if (
    (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey
    && /^[1-9]$/u.test(event.key)
  ) {
    return { kind: "jumpToTab", position: Number.parseInt(event.key, 10) };
  }
  if (matchesShortcut(event, bindings.nextWorkspace)) {
    return { kind: "cycleTabs", reverse: false };
  }
  if (matchesShortcut(event, bindings.previousWorkspace)) {
    return { kind: "cycleTabs", reverse: true };
  }
  return null;
}
