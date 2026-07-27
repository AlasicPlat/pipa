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
  loadError: string | null;
  saveError: string | null;
  recoveryBlocked: boolean;
  addTab: (connectionId: string, title: string, initialText?: string) => WorkspaceTab | null;
  closeTab: (tabId: string) => void;
  closeTabsForConnection: (connectionId: string) => void;
  renameConnectionTabTitles: (connectionId: string, previousName: string, nextName: string) => void;
  selectTab: (tabId: string) => void;
  updateTabSql: (tabId: string, sqlText: string) => void;
  retryLoad: () => Promise<void>;
  retrySave: () => Promise<void>;
}

interface QueuedWorkspaceSave {
  revision: number;
  snapshot: WorkspaceTab[];
}

const SAVE_DEBOUNCE_MS = 500;
const SAVE_ERROR = "无法保存工作区。编辑内容仍保留在本机内存中，请重试。";
const LOAD_ERROR = "无法恢复上次工作区。为避免覆盖原数据，请重新恢复后再编辑。";

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
 * Restores ordered tabs and serializes revisioned workspace snapshots after quiet editor periods.
 * Parameters: none.
 * @returns Ordered tabs, immutable active context, recovery state, and explicit tab/save actions.
 * Side effects: invokes local Tauri commands and queues pending state when hidden or unmounted.
 */
export function useWorkspacePersistence(): WorkspacePersistenceController {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const tabsRef = useRef<WorkspaceTab[]>([]);
  const latestRevisionRef = useRef(0);
  const persistedRevisionRef = useRef(0);
  const queuedSaveRef = useRef<QueuedWorkspaceSave | null>(null);
  const inFlightRevisionRef = useRef<number | null>(null);
  const drainPromiseRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadStartedRef = useRef(false);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const recoveryBlockedRef = useRef(false);
  const mountedRef = useRef(true);

  /** Runs queued saves one at a time and gates visible outcomes by the latest revision. */
  const drainSaveQueue = useCallback(async (): Promise<void> => {
    while (queuedSaveRef.current !== null) {
      const queuedSave = queuedSaveRef.current;
      queuedSaveRef.current = null;
      inFlightRevisionRef.current = queuedSave.revision;
      try {
        await saveWorkspace(queuedSave.snapshot);
        persistedRevisionRef.current = Math.max(
          persistedRevisionRef.current,
          queuedSave.revision,
        );
        if (queuedSave.revision === latestRevisionRef.current && mountedRef.current) {
          setSaveError(null);
        }
      } catch {
        if (queuedSave.revision === latestRevisionRef.current && mountedRef.current) {
          setSaveError(SAVE_ERROR);
        }
      } finally {
        if (inFlightRevisionRef.current === queuedSave.revision) {
          inFlightRevisionRef.current = null;
        }
      }
    }
  }, []);

  /** Starts the one drain loop and restarts it if a request lands during finalization. */
  const beginSaveDrain = useCallback((): Promise<void> => {
    if (drainPromiseRef.current !== null) {
      return drainPromiseRef.current;
    }

    const drain = drainSaveQueue();
    const trackedDrain = drain.finally(() => {
      if (drainPromiseRef.current === trackedDrain) {
        drainPromiseRef.current = null;
      }
      if (queuedSaveRef.current !== null) {
        void beginSaveDrain();
      }
    });
    drainPromiseRef.current = trackedDrain;
    return trackedDrain;
  }, [drainSaveQueue]);

  /** Queues only the latest dirty revision and never overlaps backend replacements. */
  const flushWorkspace = useCallback((): Promise<void> => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (recoveryBlockedRef.current) {
      return Promise.resolve();
    }

    const revision = latestRevisionRef.current;
    if (
      revision <= persistedRevisionRef.current ||
      revision === inFlightRevisionRef.current
    ) {
      return drainPromiseRef.current ?? Promise.resolve();
    }

    queuedSaveRef.current = {
      revision,
      snapshot: sanitizeWorkspaceTabs(tabsRef.current),
    };
    return beginSaveDrain();
  }, [beginSaveDrain]);

  /** Loads a clean baseline and blocks every write after failure until explicit retry succeeds. */
  const restoreWorkspace = useCallback((): Promise<void> => {
    if (loadPromiseRef.current !== null) {
      return loadPromiseRef.current;
    }
    if (mountedRef.current) {
      setLoading(true);
    }

    const load = loadWorkspace()
      .then((restoredTabs) => {
        const safeTabs = sanitizeWorkspaceTabs(restoredTabs);
        tabsRef.current = safeTabs;
        latestRevisionRef.current = 0;
        persistedRevisionRef.current = 0;
        queuedSaveRef.current = null;
        recoveryBlockedRef.current = false;
        if (mountedRef.current) {
          setTabs(safeTabs);
          setActiveTabId(safeTabs[0]?.id ?? null);
          setLoadError(null);
          setSaveError(null);
          setRecoveryBlocked(false);
        }
      })
      .catch(() => {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        queuedSaveRef.current = null;
        recoveryBlockedRef.current = true;
        if (mountedRef.current) {
          setLoadError(LOAD_ERROR);
          setRecoveryBlocked(true);
        }
      })
      .finally(() => {
        loadPromiseRef.current = null;
        if (mountedRef.current) {
          setLoading(false);
        }
      });
    loadPromiseRef.current = load;
    return load;
  }, []);

  /** Replaces in-memory tabs and schedules the single 500ms persistence boundary. */
  const updateTabs = useCallback(
    (nextTabs: WorkspaceTab[]): void => {
      if (recoveryBlockedRef.current) {
        return;
      }
      const safeTabs = sanitizeWorkspaceTabs(nextTabs).map((tab, position) => ({
        ...tab,
        position,
      }));
      tabsRef.current = safeTabs;
      latestRevisionRef.current += 1;
      setTabs(safeTabs);
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
    void restoreWorkspace();
  }, [restoreWorkspace]);

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

  /** Creates a tab only after storage recovery established a safe baseline. */
  const addTab = useCallback(
    (connectionId: string, title: string, initialText = "SELECT 1;"): WorkspaceTab | null => {
      if (recoveryBlockedRef.current) {
        return null;
      }
      const tab: WorkspaceTab = {
        id: crypto.randomUUID(),
        connectionId,
        title,
        sqlText: initialText,
        position: tabsRef.current.length,
      };
      updateTabs([...tabsRef.current, tab]);
      setActiveTabId(tab.id);
      return tab;
    },
    [updateTabs],
  );

  /**
   * Removes one tab and keeps the nearest remaining tab active.
   * @param tabId - Existing persisted workspace tab identifier.
   * @returns Nothing (`void`).
   * Side effects: updates in-memory tab state and schedules encrypted persistence.
   */
  const closeTab = useCallback(
    (tabId: string): void => {
      if (recoveryBlockedRef.current) {
        return;
      }
      const closingIndex = tabsRef.current.findIndex((tab) => tab.id === tabId);
      if (closingIndex === -1) {
        return;
      }
      const nextTabs = tabsRef.current.filter((tab) => tab.id !== tabId);
      updateTabs(nextTabs);
      setActiveTabId((currentActiveTabId) => {
        if (currentActiveTabId !== tabId) {
          return currentActiveTabId;
        }
        return nextTabs[closingIndex]?.id ?? nextTabs[closingIndex - 1]?.id ?? null;
      });
    },
    [updateTabs],
  );

  /**
   * Removes every query tab bound to one deleted connection in one persisted revision.
   * @param connectionId - Deleted connection whose query tabs can no longer execute.
   * @returns Nothing (`void`).
   * Side effects: updates active tab state and schedules encrypted workspace persistence.
   */
  const closeTabsForConnection = useCallback(
    (connectionId: string): void => {
      if (recoveryBlockedRef.current) {
        return;
      }
      const currentTabs = tabsRef.current;
      const nextTabs = currentTabs.filter((tab) => tab.connectionId !== connectionId);
      if (nextTabs.length === currentTabs.length) {
        return;
      }
      updateTabs(nextTabs);
      setActiveTabId((currentActiveTabId) => {
        const activeIndex = currentTabs.findIndex((tab) => tab.id === currentActiveTabId);
        if (activeIndex === -1 || currentTabs[activeIndex]?.connectionId !== connectionId) {
          return currentActiveTabId;
        }
        return nextTabs[Math.min(activeIndex, nextTabs.length - 1)]?.id ?? null;
      });
    },
    [updateTabs],
  );

  /** Renames only generated query-title prefixes for one connection, preserving custom titles. */
  const renameConnectionTabTitles = useCallback(
    (connectionId: string, previousName: string, nextName: string): void => {
      if (recoveryBlockedRef.current || previousName === nextName) {
        return;
      }
      const previousPrefix = `${previousName} · `;
      const nextTabs = tabsRef.current.map((tab) => (
        tab.connectionId === connectionId && tab.title.startsWith(previousPrefix)
          ? { ...tab, title: `${nextName} · ${tab.title.slice(previousPrefix.length)}` }
          : tab
      ));
      if (nextTabs.some((tab, index) => tab !== tabsRef.current[index])) {
        updateTabs(nextTabs);
      }
    },
    [updateTabs],
  );

  /** Selects an existing tab without changing its stored connection identifier. */
  const selectTab = useCallback((tabId: string): void => {
    if (tabsRef.current.some((tab) => tab.id === tabId)) {
      setActiveTabId(tabId);
    }
  }, []);

  /** Updates only editor text after recovery and retains every immutable context field. */
  const updateTabSql = useCallback(
    (tabId: string, sqlText: string): void => {
      if (recoveryBlockedRef.current) {
        return;
      }
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
    loadError,
    saveError,
    recoveryBlocked,
    addTab,
    closeTab,
    closeTabsForConnection,
    renameConnectionTabTitles,
    selectTab,
    updateTabSql,
    retryLoad: restoreWorkspace,
    retrySave: flushWorkspace,
  };
}
