import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkspace, saveWorkspace } from "../../lib/tauriClient";
import { useWorkspacePersistence, type WorkspaceTab } from "./useWorkspacePersistence";

vi.mock("../../lib/tauriClient", () => ({
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
}));

const RESTORED_TAB: WorkspaceTab = {
  id: "tab-1",
  connectionId: "connection-1",
  title: "库存检查",
  sqlText: "SELECT 1;",
  position: 0,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** Creates a controllable promise for deterministic persistence ordering tests. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Settles the startup load promise without advancing the debounce clock. */
async function settleStartupLoad(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Verifies startup restores once and a changed tab is saved only after 500ms. */
async function assertLoadOnceAndDebounce(): Promise<void> {
  const hook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();

  expect(loadWorkspace).toHaveBeenCalledTimes(1);
  expect(loadWorkspace).toHaveBeenCalledWith("main");
  hook.rerender();
  expect(loadWorkspace).toHaveBeenCalledTimes(1);
  expect(hook.result.current.tabs).toEqual([RESTORED_TAB]);

  act(() => hook.result.current.updateTabSql("tab-1", "SELECT 2;"));
  await vi.advanceTimersByTimeAsync(499);
  expect(saveWorkspace).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(saveWorkspace).toHaveBeenCalledTimes(1);
  expect(saveWorkspace).toHaveBeenLastCalledWith("main", [
    { ...RESTORED_TAB, sqlText: "SELECT 2;" },
  ]);
}

/** Verifies a detached window loads and saves only under its own stable native label. */
async function assertDetachedWindowScopesPersistence(): Promise<void> {
  const hook = renderHook(() => useWorkspacePersistence("workspace-query-1"));
  await settleStartupLoad();

  expect(loadWorkspace).toHaveBeenCalledWith("workspace-query-1");
  act(() => hook.result.current.updateTabSql("tab-1", "SELECT 'detached';"));
  await vi.advanceTimersByTimeAsync(500);
  expect(saveWorkspace).toHaveBeenLastCalledWith("workspace-query-1", [
    { ...RESTORED_TAB, sqlText: "SELECT 'detached';" },
  ]);
}

/** Verifies an explicitly closed detached window persists an empty recovery snapshot. */
async function assertDetachedWindowDiscardClearsPersistence(): Promise<void> {
  const hook = renderHook(() => useWorkspacePersistence("workspace-query-1"));
  await settleStartupLoad();

  await act(async () => {
    await hook.result.current.discardWorkspace();
  });
  expect(saveWorkspace).toHaveBeenLastCalledWith("workspace-query-1", []);

  act(() => hook.result.current.updateTabSql("tab-1", "SELECT 'stale';"));
  await vi.advanceTimersByTimeAsync(500);
  expect(saveWorkspace).toHaveBeenCalledTimes(1);
}

/** Verifies hidden and unmount lifecycle boundaries flush the newest editor contents. */
async function assertLifecycleFlushesLatestState(): Promise<void> {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const hiddenHook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();

  act(() => hiddenHook.result.current.updateTabSql("tab-1", "SELECT 'hidden';"));
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  await act(async () => Promise.resolve());
  expect(saveWorkspace).toHaveBeenLastCalledWith("main", [
    { ...RESTORED_TAB, sqlText: "SELECT 'hidden';" },
  ]);
  hiddenHook.unmount();

  vi.mocked(saveWorkspace).mockClear();
  visibility.mockReturnValue("visible");
  const unmountHook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();
  act(() => unmountHook.result.current.updateTabSql("tab-1", "SELECT 'unmount';"));
  unmountHook.unmount();
  await act(async () => Promise.resolve());
  expect(saveWorkspace).toHaveBeenLastCalledWith("main", [
    { ...RESTORED_TAB, sqlText: "SELECT 'unmount';" },
  ]);
}

/** Verifies hidden and unmount requests queue their latest revision behind an active save. */
async function assertLifecycleFlushesSerializeBehindActiveSave(): Promise<void> {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const hiddenFirst = deferred<void>();
  const hiddenLatest = deferred<void>();
  vi.mocked(saveWorkspace)
    .mockReturnValueOnce(hiddenFirst.promise)
    .mockReturnValueOnce(hiddenLatest.promise);
  const hiddenHook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();

  act(() => hiddenHook.result.current.updateTabSql("tab-1", "SELECT 'active';"));
  await vi.advanceTimersByTimeAsync(500);
  act(() => hiddenHook.result.current.updateTabSql("tab-1", "SELECT 'hidden latest';"));
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(saveWorkspace).toHaveBeenCalledTimes(1);

  await act(async () => hiddenFirst.resolve(undefined));
  expect(saveWorkspace).toHaveBeenCalledTimes(2);
  expect(saveWorkspace).toHaveBeenLastCalledWith("main", [
    { ...RESTORED_TAB, sqlText: "SELECT 'hidden latest';" },
  ]);
  await act(async () => hiddenLatest.resolve(undefined));
  hiddenHook.unmount();

  vi.mocked(saveWorkspace).mockReset();
  const unmountFirst = deferred<void>();
  const unmountLatest = deferred<void>();
  vi.mocked(saveWorkspace)
    .mockReturnValueOnce(unmountFirst.promise)
    .mockReturnValueOnce(unmountLatest.promise);
  visibility.mockReturnValue("visible");
  const unmountHook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();
  act(() => unmountHook.result.current.updateTabSql("tab-1", "SELECT 'active';"));
  await vi.advanceTimersByTimeAsync(500);
  act(() => unmountHook.result.current.updateTabSql("tab-1", "SELECT 'unmount latest';"));
  unmountHook.unmount();
  expect(saveWorkspace).toHaveBeenCalledTimes(1);

  await act(async () => unmountFirst.resolve(undefined));
  expect(saveWorkspace).toHaveBeenCalledTimes(2);
  expect(saveWorkspace).toHaveBeenLastCalledWith("main", [
    { ...RESTORED_TAB, sqlText: "SELECT 'unmount latest';" },
  ]);
  await act(async () => unmountLatest.resolve(undefined));
}

/** Verifies save failures preserve memory and serialization excludes transient or secret fields. */
async function assertFailurePreservesSafeInMemoryTabs(): Promise<void> {
  vi.mocked(loadWorkspace).mockResolvedValue([
    {
      ...RESTORED_TAB,
      password: "must-not-save",
      rows: [["must-not-save"]],
      error: "transient",
    } as unknown as WorkspaceTab,
  ]);
  vi.mocked(saveWorkspace).mockRejectedValueOnce(new Error("disk busy"));
  const hook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();

  act(() => hook.result.current.updateTabSql("tab-1", "SELECT 'kept';"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
  });

  expect(hook.result.current.tabs[0].sqlText).toBe("SELECT 'kept';");
  expect(hook.result.current.saveError).toMatch(/编辑内容仍保留/);
  const serialized = JSON.stringify(vi.mocked(saveWorkspace).mock.calls[0][1]);
  expect(serialized).not.toMatch(/password|rows|error|must-not-save|transient/);
  expect(hook.result.current.retrySave).toEqual(expect.any(Function));
}

/** Verifies revisions save serially and the latest failed snapshot owns the final error. */
async function assertSerialLatestWriteAndNewFailure(): Promise<void> {
  const initialFailure = deferred<void>();
  const obsoleteSuccess = deferred<void>();
  const latestFailure = deferred<void>();
  vi.mocked(saveWorkspace)
    .mockReturnValueOnce(initialFailure.promise)
    .mockReturnValueOnce(obsoleteSuccess.promise)
    .mockReturnValueOnce(latestFailure.promise);
  const hook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();

  act(() => hook.result.current.updateTabSql("tab-1", "SELECT 'seed error';"));
  await vi.advanceTimersByTimeAsync(500);
  expect(saveWorkspace).toHaveBeenCalledTimes(1);
  await act(async () => initialFailure.reject(new Error("seed failed")));
  expect(hook.result.current.saveError).toMatch(/编辑内容仍保留/);

  act(() => hook.result.current.updateTabSql("tab-1", "SELECT 'obsolete';"));
  await vi.advanceTimersByTimeAsync(500);
  expect(saveWorkspace).toHaveBeenCalledTimes(2);
  act(() => hook.result.current.updateTabSql("tab-1", "SELECT 'latest';"));
  act(() => {
    void hook.result.current.retrySave();
  });
  expect(saveWorkspace).toHaveBeenCalledTimes(2);

  await act(async () => obsoleteSuccess.resolve(undefined));
  expect(saveWorkspace).toHaveBeenCalledTimes(3);
  expect(hook.result.current.saveError).toMatch(/编辑内容仍保留/);
  expect(saveWorkspace).toHaveBeenLastCalledWith("main", [
    { ...RESTORED_TAB, sqlText: "SELECT 'latest';" },
  ]);

  await act(async () => latestFailure.reject(new Error("latest failed")));
  expect(hook.result.current.saveError).toMatch(/编辑内容仍保留/);
  expect(hook.result.current.tabs[0].sqlText).toBe("SELECT 'latest';");
}

/** Verifies an obsolete failed revision cannot outlive a newer successful save. */
async function assertStaleFailureCannotPolluteLatestSuccess(): Promise<void> {
  const firstSave = deferred<void>();
  const secondSave = deferred<void>();
  vi.mocked(saveWorkspace)
    .mockReturnValueOnce(firstSave.promise)
    .mockReturnValueOnce(secondSave.promise);
  const hook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();

  act(() => hook.result.current.updateTabSql("tab-1", "SELECT 'obsolete';"));
  await vi.advanceTimersByTimeAsync(500);
  act(() => hook.result.current.updateTabSql("tab-1", "SELECT 'latest';"));
  await vi.advanceTimersByTimeAsync(500);

  await act(async () => firstSave.reject(new Error("obsolete failed")));
  expect(saveWorkspace).toHaveBeenCalledTimes(2);
  expect(hook.result.current.saveError).toBeNull();

  await act(async () => secondSave.resolve(undefined));
  expect(hook.result.current.saveError).toBeNull();
  expect(saveWorkspace).toHaveBeenLastCalledWith("main", [
    { ...RESTORED_TAB, sqlText: "SELECT 'latest';" },
  ]);
}

/** Verifies failed recovery blocks destructive replacement until an explicit retry succeeds. */
async function assertRecoveryFailureBlocksWritesUntilRetry(): Promise<void> {
  vi.mocked(loadWorkspace).mockRejectedValueOnce(new Error("locked"));
  const hook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();

  expect(hook.result.current.recoveryBlocked).toBe(true);
  expect(hook.result.current.loadError).toMatch(/无法恢复/);
  expect(hook.result.current.addTab("connection-new", "不可创建")).toBeNull();
  act(() => hook.result.current.updateTabSql("tab-1", "DROP OLD WORKSPACE"));
  await vi.advanceTimersByTimeAsync(500);
  await act(async () => hook.result.current.retrySave());
  expect(saveWorkspace).not.toHaveBeenCalled();

  vi.mocked(loadWorkspace).mockResolvedValueOnce([RESTORED_TAB]);
  await act(async () => hook.result.current.retryLoad());

  expect(loadWorkspace).toHaveBeenCalledTimes(2);
  expect(hook.result.current.recoveryBlocked).toBe(false);
  expect(hook.result.current.loadError).toBeNull();
  expect(hook.result.current.tabs).toEqual([RESTORED_TAB]);
  expect(hook.result.current.activeTab?.connectionId).toBe("connection-1");
}

/**
 * Verifies closing tabs persists order and activates the nearest surviving neighbor.
 * Parameters: none.
 * @returns A promise that resolves after startup restoration settles.
 * Side effects: renders and mutates an isolated workspace hook.
 */
async function assertCloseTabSelectsNearestNeighbor(): Promise<void> {
  const secondTab = { ...RESTORED_TAB, id: "tab-2", title: "第二个", position: 1 };
  const thirdTab = { ...RESTORED_TAB, id: "tab-3", title: "第三个", position: 2 };
  vi.mocked(loadWorkspace).mockResolvedValueOnce([RESTORED_TAB, secondTab, thirdTab]);
  const hook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();

  act(() => hook.result.current.selectTab(secondTab.id));
  act(() => hook.result.current.closeTab(secondTab.id));
  expect(hook.result.current.activeTabId).toBe(thirdTab.id);

  act(() => hook.result.current.closeTab(thirdTab.id));
  expect(hook.result.current.activeTabId).toBe(RESTORED_TAB.id);

  act(() => hook.result.current.closeTab(RESTORED_TAB.id));
  expect(hook.result.current.activeTabId).toBeNull();
  expect(hook.result.current.tabs).toEqual([]);
}

/** Verifies deleting a connection closes all of its tabs in one workspace revision. */
async function assertCloseTabsForConnection(): Promise<void> {
  const deletedSecondTab = { ...RESTORED_TAB, id: "tab-2", title: "待删除 2", position: 1 };
  const retainedTab = {
    ...RESTORED_TAB,
    id: "tab-3",
    connectionId: "connection-2",
    title: "保留",
    position: 2,
  };
  vi.mocked(loadWorkspace).mockResolvedValueOnce([RESTORED_TAB, deletedSecondTab, retainedTab]);
  const hook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();

  act(() => hook.result.current.selectTab(deletedSecondTab.id));
  act(() => hook.result.current.closeTabsForConnection("connection-1"));

  expect(hook.result.current.tabs).toEqual([{ ...retainedTab, position: 0 }]);
  expect(hook.result.current.activeTabId).toBe(retainedTab.id);
  await vi.advanceTimersByTimeAsync(500);
  expect(saveWorkspace).toHaveBeenLastCalledWith("main", [{ ...retainedTab, position: 0 }]);
}

/** Verifies connection renames update generated tab prefixes while preserving custom titles. */
async function assertRenameConnectionTabTitles(): Promise<void> {
  const generatedTab = { ...RESTORED_TAB, title: "旧连接 · 查询 1" };
  const customTab = { ...RESTORED_TAB, id: "tab-custom", title: "月度报表", position: 1 };
  vi.mocked(loadWorkspace).mockResolvedValueOnce([generatedTab, customTab]);
  const hook = renderHook(() => useWorkspacePersistence());
  await settleStartupLoad();

  act(() => hook.result.current.renameConnectionTabTitles("connection-1", "旧连接", "新连接"));
  expect(hook.result.current.tabs.map((tab) => tab.title)).toEqual(["新连接 · 查询 1", "月度报表"]);
  await vi.advanceTimersByTimeAsync(500);
  expect(saveWorkspace).toHaveBeenLastCalledWith("main", [
    { ...generatedTab, title: "新连接 · 查询 1" },
    customTab,
  ]);
}

/** Registers local workspace recovery behavior with deterministic fake timers. */
function registerWorkspacePersistenceTests(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(loadWorkspace).mockResolvedValue([RESTORED_TAB]);
    vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("loads once and saves only after 500ms", assertLoadOnceAndDebounce);
  it("isolates detached-window persistence by native label", assertDetachedWindowScopesPersistence);
  it("clears restart persistence when a detached window is explicitly closed", assertDetachedWindowDiscardClearsPersistence);
  it("flushes the latest SQL when hidden or unmounted", assertLifecycleFlushesLatestState);
  it("serializes hidden and unmount flushes behind an active save", assertLifecycleFlushesSerializeBehindActiveSave);
  it("keeps memory intact and serializes only safe tab fields after failure", assertFailurePreservesSafeInMemoryTabs);
  it("serializes writes and lets the latest failed revision own the error", assertSerialLatestWriteAndNewFailure);
  it("does not retain a stale failure after the latest revision succeeds", assertStaleFailureCannotPolluteLatestSuccess);
  it("blocks replacement after restore failure until retry succeeds", assertRecoveryFailureBlocksWritesUntilRetry);
  it("activates the nearest neighbor when a tab closes", assertCloseTabSelectsNearestNeighbor);
  it("closes every tab bound to a deleted connection", assertCloseTabsForConnection);
  it("renames only generated titles for one connection", assertRenameConnectionTabTitles);
}

describe("useWorkspacePersistence", registerWorkspacePersistenceTests);
