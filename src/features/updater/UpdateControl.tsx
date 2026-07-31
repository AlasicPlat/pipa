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
 * 将未知的更新器拒绝原因转换为简洁且不含敏感信息的消息。
 * @param error - Tauri updater 或 process 插件返回的拒绝原因。
 * @param fallback - 拒绝原因没有消息时使用的用户提示。
 * @returns 可安全显示在更新菜单中的错误消息。
 * 副作用：无。
 */
function getUpdateErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

/**
 * 提供更新检查、签名包安装和应用重启控制。
 * 参数：无。
 * @returns 仅桌面端显示的更新控件；普通浏览器预览中返回 `null`。
 * 副作用：挂载后检查 GitHub Releases，并临时注册菜单关闭监听器。
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
   * 检查已配置的发布端点，并在有更新时保留签名更新资源。
   * @returns 菜单状态反映服务器响应后结束的 Promise。
   * 副作用：执行一次 HTTPS 请求，并关闭已被替代的原生更新资源。
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

    /** 指针在控件外按下时关闭更新菜单。 */
    const handlePointerDown = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    /** 按 Escape 关闭更新菜单，并将焦点恢复到触发按钮。 */
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
   * 跟踪签名包下载进度、执行安装，并请求干净地重启应用。
   * @returns 安装完成或错误已显示后结束的 Promise。
   * 副作用：下载并安装验证通过的发布包，成功后重启 Pipa。
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
   * 安装后重试启动应用，不再重复下载更新包。
   * @returns process 插件接受或拒绝重启请求后结束的 Promise。
   * 副作用：成功时重启桌面应用。
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
