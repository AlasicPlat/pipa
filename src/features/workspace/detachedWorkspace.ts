import { isTauri } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const MAIN_WORKSPACE_WINDOW_LABEL = "main";

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface WindowScreenBounds {
  height: number;
  left: number;
  top: number;
  width: number;
}

export type DetachedWorkspaceLaunch =
  | { kind: "query"; id: string; title: string }
  | {
    kind: "table";
    id: string;
    connectionId: string;
    tableName: string;
    title: string;
  };

export interface WorkspaceWindowContext {
  descriptor: DetachedWorkspaceLaunch | null;
  windowLabel: string;
}

/** Returns whether a screen-space drop point lies outside one native window rectangle. */
export function isScreenPointOutsideWindow(
  point: ScreenPoint,
  bounds: WindowScreenBounds = {
    left: window.screenX,
    top: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight,
  },
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  return point.x < bounds.left
    || point.y < bounds.top
    || point.x > bounds.left + bounds.width
    || point.y > bounds.top + bounds.height;
}

/** Reads and validates the optional detached-workspace descriptor in the current URL. */
export function readDetachedWorkspaceLaunch(
  search = window.location.search,
): DetachedWorkspaceLaunch | null {
  const params = new URLSearchParams(search);
  const kind = params.get("workspaceKind");
  const id = params.get("workspaceId");
  const title = params.get("workspaceTitle");
  if (!id || !title) return null;
  if (kind === "query") return { kind, id, title };
  if (kind === "table") {
    const connectionId = params.get("connectionId");
    const tableName = params.get("tableName");
    return connectionId && tableName
      ? { kind, id, connectionId, tableName, title }
      : null;
  }
  return null;
}

/** Resolves the synchronous window identity and optional launch descriptor for this WebView. */
export function readWorkspaceWindowContext(): WorkspaceWindowContext {
  return {
    descriptor: readDetachedWorkspaceLaunch(),
    windowLabel: isTauri()
      ? getCurrentWebviewWindow().label
      : MAIN_WORKSPACE_WINDOW_LABEL,
  };
}

/** Creates a URL that contains only non-secret workspace routing metadata. */
function detachedWorkspaceUrl(workspace: DetachedWorkspaceLaunch): string {
  const params = new URLSearchParams({
    workspaceKind: workspace.kind,
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
  });
  if (workspace.kind === "table") {
    params.set("connectionId", workspace.connectionId);
    params.set("tableName", workspace.tableName);
  }
  return `/?${params.toString()}`;
}

/** Waits for Tauri to either finish or reject one asynchronous WebView-window creation. */
function waitForWindowCreation(windowHandle: WebviewWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    void windowHandle.once("tauri://created", () => resolve());
    void windowHandle.once<unknown>("tauri://error", (event) => reject(event.payload));
  });
}

/** Opens one detached workspace near its screen-space drop point and returns its stable label. */
export async function createDetachedWorkspaceWindow(
  workspace: DetachedWorkspaceLaunch,
  point: ScreenPoint,
  windowLabel = `workspace-${crypto.randomUUID()}`,
): Promise<string> {
  if (!isTauri()) throw new Error("Detached workspaces require the desktop application");
  const windowHandle = new WebviewWindow(windowLabel, {
    url: detachedWorkspaceUrl(workspace),
    title: `${workspace.title} · Pipa`,
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    x: Math.round(point.x - 80),
    y: Math.round(point.y - 24),
    focus: true,
  });
  await waitForWindowCreation(windowHandle);
  return windowLabel;
}

/**
 * Deletes a detached window's recovery snapshot before honoring its native close request.
 * @param discardWorkspace - Serialized persistence cleanup for the current window label.
 * @param onFailure - Reports cleanup or native destruction failures while the window stays open.
 * @returns An unlisten callback for the native close-request subscription.
 * Side effects: prevents the default close, clears persistence, and destroys the native window.
 */
export function registerDetachedWorkspaceCloseHandler(
  discardWorkspace: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<UnlistenFn> {
  const windowHandle = getCurrentWebviewWindow();
  let closing = false;
  return windowHandle.onCloseRequested(async (event) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      await discardWorkspace();
      await windowHandle.destroy();
    } catch (error: unknown) {
      closing = false;
      onFailure(error);
    }
  });
}

/** Reopens one persisted detached query window unless Tauri already owns that label. */
export async function restoreDetachedQueryWindow(windowLabel: string): Promise<void> {
  if (!isTauri() || await WebviewWindow.getByLabel(windowLabel)) return;
  const windowHandle = new WebviewWindow(windowLabel, {
    url: "/?workspaceKind=query&workspaceId=restored&workspaceTitle=查询工作区",
    title: "查询工作区 · Pipa",
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    center: true,
  });
  await waitForWindowCreation(windowHandle);
}
