import { useCallback, useRef, useState } from "react";

import {
  loadSidebarCollapsed,
  loadSidebarWidth,
  persistSidebarCollapsed,
  persistSidebarWidth,
} from "./sidebarLayout";

/** Collapsed state, width, and focus handling for the connection sidebar. */
export interface SidebarLayout {
  /** Whether the connection panel is collapsed out of view (it stays mounted). */
  collapsed: boolean;
  /** Ref for the activity-rail toggle, used to catch focus when the panel collapses. */
  toggleRef: React.RefObject<HTMLButtonElement | null>;
  /** Current sidebar width in pixels, driven live by the resizer. */
  width: number;
  /** Expands the sidebar when it is collapsed, for navigation that depends on it. */
  ensureExpanded: () => void;
  /** Reports a width while dragging; the value is not persisted until commit. */
  setWidth: (width: number) => void;
  /** Toggles visibility, or applies `nextCollapsed` when given. */
  toggle: (nextCollapsed?: boolean) => void;
  /** Persists the width once a drag ends. */
  commitWidth: (width: number) => void;
}

/**
 * Owns the connection sidebar's collapsed state and width, including persistence.
 *
 * Collapsing hides the panel with `inert` rather than unmounting it, so focus can still sit inside
 * a hidden subtree; the toggle therefore pulls focus back to the rail button whenever it collapses
 * while the panel owns the active element.
 * @returns Sidebar layout state and the handlers that mutate it.
 */
export function useSidebarLayout(): SidebarLayout {
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed);
  const [width, setWidth] = useState(loadSidebarWidth);
  const toggleRef = useRef<HTMLButtonElement>(null);
  /*
   * Mirrors `collapsed` so the handlers below stay referentially stable across renders while still
   * reading the latest value. Persisting and moving focus are side effects, so they must run here
   * rather than inside a state updater, which StrictMode invokes twice.
   */
  const collapsedRef = useRef(collapsed);

  const toggle = useCallback((nextCollapsed?: boolean): void => {
    const next = nextCollapsed ?? !collapsedRef.current;
    collapsedRef.current = next;
    setCollapsed(next);
    persistSidebarCollapsed(next);
    if (next) {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && activeElement.closest(".connection-panel")) {
        toggleRef.current?.focus();
      }
    }
  }, []);

  const ensureExpanded = useCallback((): void => {
    if (collapsedRef.current) {
      toggle(false);
    }
  }, [toggle]);

  return {
    collapsed,
    toggleRef,
    width,
    ensureExpanded,
    setWidth,
    toggle,
    commitWidth: persistSidebarWidth,
  };
}
