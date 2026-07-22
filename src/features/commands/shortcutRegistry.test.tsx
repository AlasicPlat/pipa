import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findShortcutConflicts,
  getDefaultShortcutBindings,
  getShortcutBindings,
  getShortcutKeyLabels,
  isSafeShortcutBinding,
  matchesShortcut,
  normalizeShortcut,
  reloadShortcutBindings,
  resetAllShortcutBindings,
  resetShortcutBinding,
  shortcutFromKeyboardEvent,
  toTauriAccelerator,
  updateShortcutBinding,
  useShortcutSettings,
} from "./shortcutRegistry";

/** Creates the keyboard-event subset accepted by registry helpers. */
function keyboardEvent(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {},
): Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"> {
  return {
    altKey: false,
    ctrlKey: false,
    key,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

describe("shortcutRegistry", () => {
  beforeEach(() => {
    window.localStorage.clear();
    reloadShortcutBindings();
  });

  afterEach(() => {
    cleanup();
    resetAllShortcutBindings();
    vi.restoreAllMocks();
  });

  it("normalizes bindings and renders portable key caps", () => {
    expect(normalizeShortcut(" control + shift + p ")).toBe("Ctrl+Shift+P");
    expect(normalizeShortcut("cmd+option+f")).toBe("Mod+Alt+F");
    expect(normalizeShortcut("Shift")).toBeNull();
    expect(getShortcutKeyLabels("Mod+Shift+ArrowUp")).toEqual(["Ctrl/Cmd", "Shift", "↑"]);
  });

  it("captures and exactly matches browser keyboard events", () => {
    expect(shortcutFromKeyboardEvent(keyboardEvent("p", { metaKey: true, shiftKey: true }))).toBe("Mod+Shift+P");
    expect(shortcutFromKeyboardEvent(keyboardEvent("Meta", { metaKey: true }))).toBeNull();
    expect(matchesShortcut(keyboardEvent("p", { metaKey: true, shiftKey: true }), "Mod+Shift+P")).toBe(true);
    expect(matchesShortcut(keyboardEvent("p", { ctrlKey: true, shiftKey: true }), "Mod+Shift+P")).toBe(true);
    expect(matchesShortcut(keyboardEvent("p", { altKey: true, metaKey: true, shiftKey: true }), "Mod+Shift+P")).toBe(false);
  });

  it("rejects unsafe bare typing keys while allowing function keys", () => {
    expect(isSafeShortcutBinding("K")).toBe(false);
    expect(isSafeShortcutBinding("Shift+K")).toBe(false);
    expect(isSafeShortcutBinding("F8")).toBe(true);
    expect(isSafeShortcutBinding("Mod+K")).toBe(true);
    expect(updateShortcutBinding("newQuery", "K")).toBe(false);
  });

  it("prevents duplicate bindings across every action scope", () => {
    expect(updateShortcutBinding("executeQuery", "Mod+T")).toBe(false);
    expect(updateShortcutBinding("executeQuery", "Mod+Alt+Enter")).toBe(true);
    expect(findShortcutConflicts(getShortcutBindings())).toEqual([]);
  });

  it("does not restore a default claimed by another customized action", () => {
    expect(updateShortcutBinding("newQuery", "Alt+N")).toBe(true);
    expect(updateShortcutBinding("closeWorkspace", "Mod+T")).toBe(true);
    expect(resetShortcutBinding("newQuery")).toBe(false);
    expect(getShortcutBindings().newQuery).toBe("Alt+N");
  });

  it("persists updates and restores them through the shared React store", () => {
    const { result } = renderHook(useShortcutSettings);
    act(() => {
      expect(result.current.setBinding("newQuery", "Mod+Shift+N")).toBe(true);
    });
    expect(result.current.bindings.newQuery).toBe("Mod+Shift+N");

    reloadShortcutBindings();
    expect(getShortcutBindings().newQuery).toBe("Mod+Shift+N");
    act(() => result.current.resetBinding("newQuery"));
    expect(result.current.bindings.newQuery).toBe(getDefaultShortcutBindings().newQuery);
  });

  it("falls back to defaults when persisted data is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    window.localStorage.setItem("pipa.shortcut-bindings.v1", "{not-json");
    reloadShortcutBindings();
    expect(getShortcutBindings()).toEqual(getDefaultShortcutBindings());
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load shortcut settings"),
      expect.objectContaining({ error: expect.anything() }),
    );
  });

  it("converts portable bindings into Tauri menu accelerators", () => {
    expect(toTauriAccelerator("Mod+Shift+P")).toBe("CmdOrCtrl+Shift+P");
    expect(toTauriAccelerator("Mod+.")).toBe("CmdOrCtrl+Period");
    expect(toTauriAccelerator("Ctrl+Tab")).toBe("Ctrl+Tab");
    expect(toTauriAccelerator("Shift")).toBeNull();
  });
});
