import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { CircleCheck, Download, RefreshCw } from "lucide-react";
import "./updater.css";

type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "restart-required"
  | "error";

interface UpdateViewState {
  phase: UpdatePhase;
  downloadedBytes: number;
  totalBytes?: number;
  error?: string;
}

const INITIAL_STATE: UpdateViewState = {
  phase: "idle",
  downloadedBytes: 0,
};

/**
 * Converts an unknown updater rejection into a concise, non-sensitive message.
 * @param error - Rejection returned by the Tauri updater or process plugin.
 * @param fallback - User-facing message used when the rejection has no message.
 * @returns A safe error message for the update menu.
 * Side effects: none.
 */
function getUpdateErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

/**
 * Provides update checks, signed package installation, and application relaunch controls.
 * Parameters: none.
 * @returns The desktop-only update control, or `null` in a normal browser preview.
 * Side effects: checks GitHub Releases after mount and temporarily registers dismissal listeners.
 */
export function UpdateControl() {
  const runningInTauri = isTauri();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<UpdateViewState>(INITIAL_STATE);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const updateRef = useRef<Update | null>(null);
  const checkInFlightRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Checks the configured release endpoint and retains the signed update resource when available.
   * @returns A promise that settles after the menu state reflects the server response.
   * Side effects: performs one HTTPS request and closes any superseded native update resource.
   */
  const checkForUpdate = useCallback(async (): Promise<void> => {
    if (!runningInTauri || checkInFlightRef.current) {
      return;
    }

    checkInFlightRef.current = true;
    setState({ phase: "checking", downloadedBytes: 0 });
    try {
      const previousUpdate = updateRef.current;
      updateRef.current = null;
      setAvailableUpdate(null);
      if (previousUpdate) {
        await previousUpdate.close();
      }

      const nextUpdate = await check({ timeout: 15_000 });
      updateRef.current = nextUpdate;
      setAvailableUpdate(nextUpdate);
      setState({
        phase: nextUpdate ? "available" : "up-to-date",
        downloadedBytes: 0,
      });
    } catch (error) {
      setState({
        phase: "error",
        downloadedBytes: 0,
        error: getUpdateErrorMessage(error, "暂时无法检查更新，请稍后重试。"),
      });
    } finally {
      checkInFlightRef.current = false;
    }
  }, [runningInTauri]);

  useEffect(() => {
    if (!runningInTauri) {
      return undefined;
    }

    void checkForUpdate();
    return () => {
      const activeUpdate = updateRef.current;
      updateRef.current = null;
      if (activeUpdate) {
        void activeUpdate.close().catch((error: unknown) => {
          console.warn("Pipa updater resource cleanup failed", error);
        });
      }
    };
  }, [checkForUpdate, runningInTauri]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    /** Closes the update menu when pointer input moves outside the control. */
    const handlePointerDown = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    /** Closes the update menu with Escape and restores focus to its trigger. */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  /**
   * Tracks signed package download progress, installs it, and requests a clean application relaunch.
   * @returns A promise that settles after installation or a surfaced failure.
   * Side effects: downloads and installs a verified release package, then restarts Pipa on success.
   */
  const installUpdate = async (): Promise<void> => {
    if (!availableUpdate || state.phase !== "available") {
      return;
    }

    setState({ phase: "downloading", downloadedBytes: 0 });
    try {
      let downloadedBytes = 0;
      await availableUpdate.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          downloadedBytes = 0;
          setState({
            phase: "downloading",
            downloadedBytes,
            totalBytes: event.data.contentLength,
          });
          return;
        }
        if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setState((currentState) => ({
            phase: "downloading",
            downloadedBytes,
            totalBytes: currentState.totalBytes,
          }));
          return;
        }
        setState((currentState) => ({
          ...currentState,
          phase: "installing",
        }));
      });
      setState({ phase: "restart-required", downloadedBytes });
    } catch (error) {
      setState({
        phase: "error",
        downloadedBytes: 0,
        error: getUpdateErrorMessage(error, "更新下载或安装失败，当前版本未被替换。"),
      });
      return;
    }

    try {
      await relaunch();
    } catch (error) {
      setState({
        phase: "restart-required",
        downloadedBytes: 0,
        error: getUpdateErrorMessage(error, "更新已安装，请手动重新启动 Pipa。"),
      });
    }
  };

  /**
   * Retries the post-install relaunch without downloading the package again.
   * @returns A promise that settles when the process plugin accepts or rejects the restart.
   * Side effects: restarts the desktop application on success.
   */
  const restartApplication = async (): Promise<void> => {
    try {
      await relaunch();
    } catch (error) {
      setState((currentState) => ({
        ...currentState,
        error: getUpdateErrorMessage(error, "请手动重新启动 Pipa 以完成更新。"),
      }));
    }
  };

  if (!runningInTauri) {
    return null;
  }

  const progress = state.totalBytes
    ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
    : null;
  const updateLabel = state.phase === "available" && availableUpdate
    ? `更新 v${availableUpdate.version}`
    : state.phase === "checking"
      ? "检查中"
      : state.phase === "downloading"
        ? progress === null ? "下载中" : `${progress}%`
        : state.phase === "installing"
          ? "安装中"
          : "更新";

  return (
    <div className="update-control" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={state.phase === "available" && availableUpdate
          ? `软件更新：发现 v${availableUpdate.version}`
          : "软件更新"}
        className={state.phase === "available" ? "is-active" : undefined}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        ref={triggerRef}
        title="检查并安装 Pipa 更新"
        type="button"
      >
        <Download aria-hidden="true" size={14} />
        {updateLabel}
      </button>
      {open ? (
        <section aria-label="软件更新" className="update-menu" role="dialog">
          <span className="update-menu__eyebrow">PIPA UPDATE</span>
          <strong>软件更新</strong>
          {state.phase === "checking" ? <p role="status">正在检查 GitHub Releases…</p> : null}
          {state.phase === "up-to-date" ? (
            <p className="update-menu__success"><CircleCheck aria-hidden="true" size={14} /> 已是最新版本</p>
          ) : null}
          {state.phase === "available" && availableUpdate ? (
            <>
              <p>发现 v{availableUpdate.version}（当前 v{availableUpdate.currentVersion}）</p>
              {availableUpdate.body ? <p className="update-menu__notes">{availableUpdate.body}</p> : null}
            </>
          ) : null}
          {state.phase === "downloading" ? (
            <p role="status">正在下载已签名更新{progress === null ? "…" : `：${progress}%`}</p>
          ) : null}
          {state.phase === "installing" ? <p role="status">正在验证并安装更新…</p> : null}
          {state.phase === "restart-required" ? (
            <p className="update-menu__success"><CircleCheck aria-hidden="true" size={14} /> 更新已安装</p>
          ) : null}
          {state.error ? <p className="update-menu__error" role="alert">{state.error}</p> : null}
          <span className="update-menu__actions">
            {state.phase === "available" ? (
              <button className="update-menu__primary" onClick={() => void installUpdate()} type="button">
                下载、安装并重启
              </button>
            ) : state.phase === "restart-required" ? (
              <button className="update-menu__primary" onClick={() => void restartApplication()} type="button">
                重新启动 Pipa
              </button>
            ) : state.phase !== "checking" && state.phase !== "downloading" && state.phase !== "installing" ? (
              <button onClick={() => void checkForUpdate()} type="button">
                <RefreshCw aria-hidden="true" size={13} /> 再次检查
              </button>
            ) : null}
          </span>
        </section>
      ) : null}
    </div>
  );
}
