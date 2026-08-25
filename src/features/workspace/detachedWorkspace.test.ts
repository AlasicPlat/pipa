import { afterEach, describe, expect, it, vi } from "vitest";

const nativeWindowState = vi.hoisted(() => ({
  actions: [] as string[],
  closeHandler: null as null | ((event: { preventDefault: () => void }) => Promise<void> | void),
  constructed: [] as Array<{ label: string; options: Record<string, unknown> }>,
  currentLabel: "workspace-current",
  existingLabel: null as string | null,
  tauri: true,
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => nativeWindowState.tauri,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => {
  class MockWebviewWindow {
    static async getByLabel(label: string): Promise<MockWebviewWindow | null> {
      return nativeWindowState.existingLabel === label
        ? new MockWebviewWindow(label, { skipRecord: true })
        : null;
    }

    label: string;

    constructor(label: string, options: Record<string, unknown>) {
      this.label = label;
      if (!options.skipRecord) nativeWindowState.constructed.push({ label, options });
    }

    async once(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void> {
      if (event === "tauri://created") queueMicrotask(() => handler({ payload: null }));
      return () => undefined;
    }
  }

  return {
    getCurrentWebviewWindow: () => ({
      label: nativeWindowState.currentLabel,
      destroy: async () => {
        nativeWindowState.actions.push("destroy");
      },
      onCloseRequested: async (
        handler: (event: { preventDefault: () => void }) => Promise<void> | void,
      ) => {
        nativeWindowState.closeHandler = handler;
        return () => {
          nativeWindowState.actions.push("unlisten");
        };
      },
    }),
    WebviewWindow: MockWebviewWindow,
  };
});

import {
  createDetachedWorkspaceWindow,
  isScreenPointOutsideWindow,
  readDetachedWorkspaceLaunch,
  readWorkspaceWindowContext,
  registerDetachedWorkspaceCloseHandler,
  restoreDetachedQueryWindow,
} from "./detachedWorkspace";

/** Verifies screen-space geometry distinguishes in-window and out-of-window drops. */
function assertWindowBoundaryDetection(): void {
  const bounds = { left: 100, top: 80, width: 900, height: 600 };
  expect(isScreenPointOutsideWindow({ x: 500, y: 300 }, bounds)).toBe(false);
  expect(isScreenPointOutsideWindow({ x: 1_001, y: 300 }, bounds)).toBe(true);
  expect(isScreenPointOutsideWindow({ x: Number.NaN, y: 300 }, bounds)).toBe(false);
}

/** Verifies routing metadata round-trips without embedding editor contents in the URL. */
function assertDetachedRouteParsing(): void {
  expect(readDetachedWorkspaceLaunch(
    "?workspaceKind=table&workspaceId=table-1&workspaceTitle=%E8%AE%A2%E5%8D%95&connectionId=connection-1&database=shop&tableName=orders",
  )).toEqual({
    kind: "table",
    id: "table-1",
    title: "订单",
    connectionId: "connection-1",
    database: "shop",
    tableName: "orders",
  });
  // A table route without its schema is ambiguous, so it is refused rather than guessed.
  expect(readDetachedWorkspaceLaunch(
    "?workspaceKind=table&workspaceId=table-1&workspaceTitle=%E8%AE%A2%E5%8D%95&connectionId=connection-1&tableName=orders",
  )).toBeNull();
  expect(readDetachedWorkspaceLaunch("?workspaceKind=table&workspaceId=broken&workspaceTitle=Broken"))
    .toBeNull();
  expect(readWorkspaceWindowContext()).toEqual({
    descriptor: null,
    windowLabel: nativeWindowState.currentLabel,
  });
}

/** Verifies native creation uses the drop point, constrained label, and metadata-only route. */
async function assertNativeWindowCreation(): Promise<void> {
  await expect(createDetachedWorkspaceWindow(
    { kind: "query", id: "query-1", title: "库存检查" },
    { x: 420, y: 260 },
    "workspace-query-1",
  )).resolves.toBe("workspace-query-1");

  expect(nativeWindowState.constructed).toHaveLength(1);
  expect(nativeWindowState.constructed[0]).toEqual({
    label: "workspace-query-1",
    options: expect.objectContaining({
      title: "库存检查 · Pipa",
      url: "/?workspaceKind=query&workspaceId=query-1&workspaceTitle=%E5%BA%93%E5%AD%98%E6%A3%80%E6%9F%A5",
      x: 340,
      y: 236,
    }),
  });
  expect(JSON.stringify(nativeWindowState.constructed[0])).not.toContain("sqlText");
}

/** Verifies startup restoration does not create a second window for an existing label. */
async function assertRestoreReusesExistingWindow(): Promise<void> {
  nativeWindowState.existingLabel = "workspace-existing";
  await restoreDetachedQueryWindow("workspace-existing");
  expect(nativeWindowState.constructed).toHaveLength(0);
}

/** Verifies a manual detached-window close clears recovery state before native destruction. */
async function assertCloseDiscardsBeforeDestroy(): Promise<void> {
  const onFailure = vi.fn();
  const discardWorkspace = vi.fn(async () => {
    nativeWindowState.actions.push("discard");
  });
  const unlisten = await registerDetachedWorkspaceCloseHandler(discardWorkspace, onFailure);
  const preventDefault = vi.fn();

  await nativeWindowState.closeHandler?.({ preventDefault });

  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(discardWorkspace).toHaveBeenCalledTimes(1);
  expect(nativeWindowState.actions).toEqual(["discard", "destroy"]);
  expect(onFailure).not.toHaveBeenCalled();
  unlisten();
  expect(nativeWindowState.actions).toEqual(["discard", "destroy", "unlisten"]);
}

describe("detached workspace windows", () => {
  afterEach(() => {
    nativeWindowState.actions.length = 0;
    nativeWindowState.closeHandler = null;
    nativeWindowState.constructed.length = 0;
    nativeWindowState.currentLabel = "workspace-current";
    nativeWindowState.existingLabel = null;
    nativeWindowState.tauri = true;
  });
  it("detects drops outside the current window", assertWindowBoundaryDetection);
  it("parses validated detached workspace routes", assertDetachedRouteParsing);
  it("creates a native window near the drop point", assertNativeWindowCreation);
  it("reuses an existing restored window", assertRestoreReusesExistingWindow);
  it("discards restart state before honoring a manual close", assertCloseDiscardsBeforeDestroy);
});
