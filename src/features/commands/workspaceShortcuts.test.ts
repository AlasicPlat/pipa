import { describe, expect, it } from "vitest";

import { getDefaultShortcutBindings, type KeyboardShortcutEvent } from "./shortcutRegistry";
import { resolveWorkspaceShortcut } from "./workspaceShortcuts";

const bindings = getDefaultShortcutBindings();

function keyEvent(overrides: Partial<KeyboardShortcutEvent>): KeyboardShortcutEvent {
  return {
    key: "a",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("resolveWorkspaceShortcut", () => {
  it("resolves each configured binding", () => {
    const resolve = (binding: string): string | undefined => {
      const tokens = binding.split("+");
      const modifiers = tokens.slice(0, -1);
      const key = tokens[tokens.length - 1] ?? "";
      return resolveWorkspaceShortcut(keyEvent({
        key,
        altKey: modifiers.includes("Alt"),
        metaKey: modifiers.includes("Mod") || modifiers.includes("Meta"),
        shiftKey: modifiers.includes("Shift"),
      }), bindings)?.kind;
    };
    expect(resolve(bindings.commandPalette)).toBe("openCommandPalette");
    expect(resolve(bindings.shortcutHelp)).toBe("openShortcutHelp");
    expect(resolve(bindings.toggleSidebar)).toBe("toggleSidebar");
    expect(resolve(bindings.newQuery)).toBe("newQuery");
    expect(resolve(bindings.closeWorkspace)).toBe("closeWorkspace");
  });

  it("reads positional jumps off the raw modifiers", () => {
    expect(resolveWorkspaceShortcut(keyEvent({ key: "3", metaKey: true }), bindings))
      .toEqual({ kind: "jumpToTab", position: 3 });
    expect(resolveWorkspaceShortcut(keyEvent({ key: "9", ctrlKey: true }), bindings))
      .toEqual({ kind: "jumpToTab", position: 9 });
  });

  it("ignores a positional digit combined with Alt or Shift", () => {
    expect(resolveWorkspaceShortcut(keyEvent({ key: "3", metaKey: true, altKey: true }), bindings))
      .toBeNull();
    expect(resolveWorkspaceShortcut(keyEvent({ key: "3", metaKey: true, shiftKey: true }), bindings))
      .toBeNull();
  });

  it("ignores a bare digit with no modifier", () => {
    expect(resolveWorkspaceShortcut(keyEvent({ key: "3" }), bindings)).toBeNull();
    expect(resolveWorkspaceShortcut(keyEvent({ key: "0", metaKey: true }), bindings)).toBeNull();
  });

  it("resolves tab cycling in both directions", () => {
    const next = resolveWorkspaceShortcut(
      keyEvent({ key: "]", metaKey: true, shiftKey: true }),
      { ...bindings, nextWorkspace: "Mod+Shift+]" },
    );
    expect(next).toEqual({ kind: "cycleTabs", reverse: false });
    const previous = resolveWorkspaceShortcut(
      keyEvent({ key: "[", metaKey: true, shiftKey: true }),
      { ...bindings, previousWorkspace: "Mod+Shift+[" },
    );
    expect(previous).toEqual({ kind: "cycleTabs", reverse: true });
  });

  it("returns nothing for an unrelated press", () => {
    expect(resolveWorkspaceShortcut(keyEvent({ key: "q" }), bindings)).toBeNull();
  });
});
