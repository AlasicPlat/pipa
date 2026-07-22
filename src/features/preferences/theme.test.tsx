import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemePreference,
  initializeThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  useThemePreference,
} from "./theme";

/** Creates a controllable color-scheme query for hook tests. */
function createSystemThemeQuery(initiallyDark: boolean) {
  let matches = initiallyDark;
  const listeners = new Set<() => void>();
  return {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
    addListener: (listener: () => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: () => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => true,
    /** Changes the simulated system theme and notifies subscribers. */
    setDark(nextMatches: boolean) {
      matches = nextMatches;
      listeners.forEach((listener) => listener());
    },
    /** Returns the active listener count for cleanup assertions. */
    listenerCount() {
      return listeners.size;
    },
  } as unknown as MediaQueryList & { setDark: (nextMatches: boolean) => void; listenerCount: () => number };
}

describe("theme preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("color-scheme");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves explicit and system preferences", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("applies the persisted preference before render", () => {
    const systemThemeQuery = createSystemThemeQuery(false);
    vi.stubGlobal("matchMedia", vi.fn(() => systemThemeQuery));
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    expect(initializeThemePreference()).toBe("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("falls back to system for invalid persisted values", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(applyThemePreference(initializeThemePreference(), createSystemThemeQuery(true))).toBe("dark");
  });

  it("persists explicit changes and updates the root element", () => {
    const systemThemeQuery = createSystemThemeQuery(false);
    vi.stubGlobal("matchMedia", vi.fn(() => systemThemeQuery));
    const hook = renderHook(() => useThemePreference());

    act(() => hook.result.current.setPreference("dark"));

    expect(hook.result.current.preference).toBe("dark");
    expect(hook.result.current.resolvedTheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("tracks system changes only while following the system preference", () => {
    const systemThemeQuery = createSystemThemeQuery(false);
    vi.stubGlobal("matchMedia", vi.fn(() => systemThemeQuery));
    const hook = renderHook(() => useThemePreference());

    expect(hook.result.current.resolvedTheme).toBe("light");
    act(() => systemThemeQuery.setDark(true));
    expect(hook.result.current.resolvedTheme).toBe("dark");

    act(() => hook.result.current.setPreference("light"));
    expect(systemThemeQuery.listenerCount()).toBe(0);
    act(() => systemThemeQuery.setDark(false));
    expect(hook.result.current.resolvedTheme).toBe("light");
  });
});
