import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_STORAGE_KEY = "pipa.theme-preference";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Validates a persisted theme preference.
 * @param value - Unknown value read from local storage.
 * @returns Whether the value is a supported theme preference.
 */
function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Reads the saved preference without allowing restricted storage to block startup.
 * @returns The persisted preference, or `system` when unavailable or invalid.
 * Side effects: logs a warning when local storage cannot be read.
 */
export function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }

  try {
    const savedPreference = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(savedPreference) ? savedPreference : "system";
  } catch (error) {
    console.warn("读取主题偏好失败，将跟随系统主题。", error);
    return "system";
  }
}

/**
 * Persists the preference while keeping theme changes usable when storage is unavailable.
 * @param preference - Explicit user appearance choice.
 * @returns Nothing (`void`).
 * Side effects: writes local storage or logs a warning if the write fails.
 */
function persistThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch (error) {
    console.warn("保存主题偏好失败，本次主题切换仍然有效。", error);
  }
}

/**
 * Resolves a user preference against the current operating-system color scheme.
 * @param preference - Stored user preference.
 * @param systemPrefersDark - Whether the operating system currently requests dark mode.
 * @returns The effective light or dark theme.
 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
}

/**
 * Gets the live operating-system color-scheme query when supported.
 * @returns The media query, or `null` in unsupported runtimes.
 */
function getSystemThemeQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(SYSTEM_DARK_QUERY);
}

/**
 * Applies a resolved theme to the root element.
 * @param preference - Stored user preference.
 * @param systemThemeQuery - Optional live system appearance query.
 * @returns The effective light or dark theme.
 * Side effects: updates `data-theme` and `color-scheme` on the document root.
 */
export function applyThemePreference(
  preference: ThemePreference,
  systemThemeQuery: MediaQueryList | null = getSystemThemeQuery(),
): ResolvedTheme {
  const resolvedTheme = resolveTheme(preference, systemThemeQuery?.matches ?? false);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }
  return resolvedTheme;
}

/**
 * Applies the persisted theme before React renders to prevent a startup color flash.
 * @returns The persisted preference that was applied.
 * Side effects: reads local storage and updates the document root.
 */
export function initializeThemePreference(): ThemePreference {
  const preference = readThemePreference();
  applyThemePreference(preference);
  return preference;
}

export interface ThemePreferenceState {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

/**
 * Owns the theme preference and follows system changes while in system mode.
 * @returns Reactive preference state and its stable setter.
 * Side effects: persists changes, updates the document root, and subscribes to system appearance.
 */
export function useThemePreference(): ThemePreferenceState {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => applyThemePreference(preference));

  useEffect(() => {
    const systemThemeQuery = getSystemThemeQuery();
    const updateResolvedTheme = (): void => {
      setResolvedTheme(applyThemePreference(preference, systemThemeQuery));
    };

    persistThemePreference(preference);
    updateResolvedTheme();

    if (preference !== "system" || !systemThemeQuery) {
      return undefined;
    }

    // Older webviews expose addListener instead of the modern EventTarget API.
    if (typeof systemThemeQuery.addEventListener === "function") {
      systemThemeQuery.addEventListener("change", updateResolvedTheme);
      return () => systemThemeQuery.removeEventListener("change", updateResolvedTheme);
    }
    systemThemeQuery.addListener(updateResolvedTheme);
    return () => systemThemeQuery.removeListener(updateResolvedTheme);
  }, [preference]);

  /**
   * Updates the local preference; the effect applies and persists the new value.
   * @param nextPreference - Newly selected appearance preference.
   * @returns Nothing (`void`).
   */
  const setPreference = useCallback((nextPreference: ThemePreference): void => {
    setPreferenceState(nextPreference);
  }, []);

  return { preference, resolvedTheme, setPreference };
}
