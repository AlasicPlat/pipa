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
  hook.rerender();
  expect(loadWorkspace).toHaveBeenCalledTimes(1);
  expect(hook.result.current.tabs).toEqual([RESTORED_TAB]);

  act(() => hook.result.current.updateTabSql("tab-1", "SELECT 2;"));
  await vi.advanceTimersByTimeAsync(499);
  expect(saveWorkspace).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(saveWorkspace).toHaveBeenCalledTimes(1);
  expect(saveWorkspace).toHaveBeenLastCalledWith([
    { ...RESTORED_TAB, sqlText: "SELECT 2;" },
  ]);
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
  expect(saveWorkspace).toHaveBeenLastCalledWith([
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
  expect(saveWorkspace).toHaveBeenLastCalledWith([
    { ...RESTORED_TAB, sqlText: "SELECT 'unmount';" },
  ]);
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
  expect(hook.result.current.error).toMatch(/编辑内容仍保留/);
  const serialized = JSON.stringify(vi.mocked(saveWorkspace).mock.calls[0][0]);
  expect(serialized).not.toMatch(/password|rows|error|must-not-save|transient/);
  expect(hook.result.current.retrySave).toEqual(expect.any(Function));
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
  it("flushes the latest SQL when hidden or unmounted", assertLifecycleFlushesLatestState);
  it("keeps memory intact and serializes only safe tab fields after failure", assertFailurePreservesSafeInMemoryTabs);
}

describe("useWorkspacePersistence", registerWorkspacePersistenceTests);
