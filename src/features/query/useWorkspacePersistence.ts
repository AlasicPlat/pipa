import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadWorkspace,
  saveWorkspace,
  type WorkspaceTabPayload,
} from "../../lib/tauriClient";

export type WorkspaceTab = WorkspaceTabPayload;

interface WorkspacePersistenceController {
  tabs: WorkspaceTab[];
  activeTab: WorkspaceTab | null;
  activeTabId: string | null;
  loading: boolean;
  error: string | null;
  addTab: (connectionId: string, title: string) => WorkspaceTab;
  selectTab: (tabId: string) => void;
  updateTabSql: (tabId: string, sqlText: string) => void;
  retrySave: () => Promise<void>;
}

const SAVE_DEBOUNCE_MS = 500;

/**
 * Copies only the five fields allowed in encrypted workspace persistence.
 * @param tabs - Ordered transport tabs that may originate at an IPC boundary.
 * @returns Position-ordered tabs stripped of every unknown or transient property.
 * Side effects: none.
 */
function sanitizeWorkspaceTabs(tabs: WorkspaceTabPayload[]): WorkspaceTab[] {
  return tabs
    .map(({ id, connectionId, title, sqlText, position }) => ({
      id,
      connectionId,
      title,
      sqlText,
      position,
    }))
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

/**
 * Restores ordered query tabs once and persists safe tab state after quiet editor periods.
 * Parameters: none.
 * @returns Ordered tabs, the active immutable context, and explicit tab/save actions.
 * Side effects: invokes local Tauri workspace commands and flushes pending state when hidden/unmounted.
 */
export function useWorkspacePersistence(): WorkspacePersistenceController {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tabsRef = useRef<WorkspaceTab[]>([]);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadStartedRef = useRef(false);
  const mountedRef = useRef(true);

  /** Persists the latest dirty snapshot immediately while preserving it after failure. */
  const flushWorkspace = useCallback(async (): Promise<void> => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) {
      return;
    }

    const snapshot = sanitizeWorkspaceTabs(tabsRef.current);
    dirtyRef.current = false;
    try {
      await saveWorkspace(snapshot);
      if (mountedRef.current) {
        setError(null);
      }
    } catch {
      dirtyRef.current = true;
      if (mountedRef.current) {
        setError("无法保存工作区。编辑内容仍保留在本机内存中，请重试。");
      }
    }
  }, []);

  /** Replaces in-memory tabs and schedules the single 500ms persistence boundary. */
  const updateTabs = useCallback(
    (nextTabs: WorkspaceTab[]): void => {
      const safeTabs = sanitizeWorkspaceTabs(nextTabs).map((tab, position) => ({
        ...tab,
        position,
      }));
      tabsRef.current = safeTabs;
      setTabs(safeTabs);
      dirtyRef.current = true;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flushWorkspace();
      }, SAVE_DEBOUNCE_MS);
    },
    [flushWorkspace],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (loadStartedRef.current) {
      return;
    }
    loadStartedRef.current = true;
    void loadWorkspace()
      .then((restoredTabs) => {
        const safeTabs = sanitizeWorkspaceTabs(restoredTabs);
        tabsRef.current = safeTabs;
        if (mountedRef.current) {
          setTabs(safeTabs);
          setActiveTabId((currentId) => currentId ?? safeTabs[0]?.id ?? null);
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setError("无法恢复上次工作区。新编辑内容仍会保留在当前会话中。");
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    /** Flushes pending SQL before the WebView can be suspended in the background. */
    function handleVisibilityChange(): void {
      if (document.visibilityState === "hidden") {
        void flushWorkspace();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void flushWorkspace();
    };
  }, [flushWorkspace]);

  /** Creates a new tab whose connection context cannot be changed by later navigation. */
  const addTab = useCallback(
    (connectionId: string, title: string): WorkspaceTab => {
      const tab: WorkspaceTab = {
        id: crypto.randomUUID(),
        connectionId,
        title,
        sqlText: "SELECT 1;",
        position: tabsRef.current.length,
      };
      updateTabs([...tabsRef.current, tab]);
      setActiveTabId(tab.id);
      return tab;
    },
    [updateTabs],
  );

  /** Selects an existing tab without changing its stored connection identifier. */
  const selectTab = useCallback((tabId: string): void => {
    if (tabsRef.current.some((tab) => tab.id === tabId)) {
      setActiveTabId(tabId);
    }
  }, []);

  /** Updates only editor text for one tab and retains every immutable context field. */
  const updateTabSql = useCallback(
    (tabId: string, sqlText: string): void => {
      const nextTabs = tabsRef.current.map((tab) =>
        tab.id === tabId ? { ...tab, sqlText } : tab,
      );
      updateTabs(nextTabs);
    },
    [updateTabs],
  );

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );

  return {
    tabs,
    activeTab,
    activeTabId,
    loading,
    error,
    addTab,
    selectTab,
    updateTabSql,
    retrySave: flushWorkspace,
  };
}
