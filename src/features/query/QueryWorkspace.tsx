import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Download, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppError } from "../../bindings/AppError";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { getShortcutKeyLabels, matchesShortcut, useShortcutSettings } from "../commands/shortcutRegistry";
import type { ResolvedTheme } from "../preferences/theme";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { ResultGrid } from "./ResultGrid";
import { downloadCsv, serializeResultAsCsv, serializeResultAsTsv } from "./resultExport";
import { useQuerySession } from "./useQuerySession";
import type { WorkspaceTab } from "./useWorkspacePersistence";

interface QueryWorkspaceProps {
  profile: ConnectionProfile;
  tab: WorkspaceTab;
  theme: ResolvedTheme;
  persistenceError: string | null;
  onRetryPersistence: () => Promise<void>;
  onRunningChange: (tabId: string, running: boolean) => void;
  onSqlChange: (tabId: string, sqlText: string) => void;
}

/**
 * Returns the compact environment label shared with the query's immutable context strip.
 * @param environment - Stored connection environment.
 * @returns A short Chinese environment label.
 * Side effects: none.
 */
function environmentLabel(environment: ConnectionProfile["environment"]): string {
  return { production: "生产", development: "开发", unspecified: "未指定" }[environment];
}

/**
 * Maps a safe error category and retryability into one concise recovery action.
 * @param error - Redacted application error returned by the Rust boundary.
 * @returns A short next step that does not repeat diagnostic details.
 * Side effects: none.
 */
function queryErrorAdvice(error: AppError): string {
  switch (error.code) {
    case "validation":
      return "请检查查询内容和当前连接后再执行。";
    case "connection":
      return error.retryable
        ? "请检查网络和连接状态，然后重试。"
        : "请检查主机、端口和连接配置。";
    case "authentication":
      return "请检查用户名和凭据后重新连接。";
    case "permission":
      return "请确认当前账号具备执行此查询的权限。";
    case "timeout":
      return error.retryable
        ? "请缩小查询范围或稍后重试。"
        : "请缩小查询范围并检查超时配置。";
    case "query":
      return "请检查 SQL 语法、对象名称和当前数据库。";
    case "storage":
      return error.retryable
        ? "请检查本地存储状态，然后重试。"
        : "请检查本地存储权限和可用空间。";
    case "not_found":
      return "请重新选择连接并发起查询。";
    case "canceled":
      return "查询已取消，可调整后重新执行。";
    case "internal":
      return error.retryable
        ? "请稍后重试；若持续失败，可展开诊断信息。"
        : "请展开诊断信息并检查当前配置。";
  }
}

/**
 * Composes one connection-bound MySQL editor, minimal run controls, and streamed results.
 * @param props - Active persisted tab, its fixed non-secret profile, and tab actions.
 * @returns The usable query workspace for that fixed connection.
 * Side effects: reports controlled SQL edits and invokes query-session commands after user actions.
 */
export function QueryWorkspace({
  profile,
  tab,
  theme,
  persistenceError,
  onRetryPersistence,
  onRunningChange,
  onSqlChange,
}: QueryWorkspaceProps) {
  const shortcuts = useShortcutSettings();
  const session = useQuerySession(profile.id);
  const queryEditorRef = useRef<QueryEditorHandle>(null);
  const [resultActionFeedback, setResultActionFeedback] = useState<string | null>(null);
  const hasResultRows = session.state.columns.length > 0 && session.state.rows.length > 0;

  /**
   * Executes editor-selected SQL while the current workspace is idle.
   * @param sqlToRun - Selection-first SQL returned by the editor.
   * @returns Nothing (`void`).
   * Side effects: starts the asynchronous query session.
   */
  function handleExecute(sqlToRun: string): void {
    if (session.state.running) {
      return;
    }
    void session.run(sqlToRun);
  }

  /**
   * Delegates the visible execute control to Monaco's shared selection/cursor path.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: asks the mounted editor to execute its current scope.
   */
  function handleToolbarExecute(): void {
    queryEditorRef.current?.executeCurrent();
  }

  /**
   * Sends the session's one permitted cancellation request.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: asks the Rust backend to cancel the active query.
   */
  function handleCancel(): void {
    void session.cancel();
  }

  useEffect(() => {
    /** Cancels only this mounted, active query before the WebView consumes the primary shortcut. */
    function handleCancelShortcut(event: KeyboardEvent): void {
      if (document.querySelector("[aria-modal='true']")) {
        return;
      }
      const isCancelShortcut = matchesShortcut(event, shortcuts.bindings.cancelQuery);
      if (!isCancelShortcut || !session.state.running) {
        return;
      }
      event.preventDefault();
      void session.cancel();
    }

    document.addEventListener("keydown", handleCancelShortcut, true);
    return () => document.removeEventListener("keydown", handleCancelShortcut, true);
  }, [session.cancel, session.state.running, shortcuts.bindings.cancelQuery]);

  useEffect(() => {
    onRunningChange(tab.id, session.state.running);
    return () => onRunningChange(tab.id, false);
  }, [onRunningChange, session.state.running, tab.id]);

  /** Retries the latest failed encrypted workspace snapshot without touching editor state. */
  function handleRetryPersistence(): void {
    void onRetryPersistence();
  }

  /**
   * Copies every loaded result row to the system clipboard as TSV with headers.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: writes clipboard text through the Tauri clipboard plugin.
   */
  function handleCopyAllResults(): void {
    if (!hasResultRows) {
      return;
    }
    const tsv = serializeResultAsTsv(session.state.columns, session.state.rows);
    void writeText(tsv)
      .then(() => {
        setResultActionFeedback(`已复制 ${session.state.rows.length} 行`);
      })
      .catch((error: unknown) => {
        console.error(
          "Pipa failed to copy query results",
          error instanceof Error ? error.message : "unknown clipboard error",
        );
        setResultActionFeedback("复制失败");
      });
  }

  /**
   * Downloads every loaded result row as a CSV file.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: triggers a local CSV download in the desktop webview.
   */
  function handleExportCsv(): void {
    if (!hasResultRows) {
      return;
    }
    const csv = serializeResultAsCsv(session.state.columns, session.state.rows);
    const safeTitle = tab.title.replace(/[^\w\u4e00-\u9fff.-]+/gu, "_").slice(0, 48) || "query";
    downloadCsv(csv, `${safeTitle}-results.csv`);
    setResultActionFeedback(`已导出 ${session.state.rows.length} 行`);
  }

  useEffect(() => {
    if (!resultActionFeedback) {
      return;
    }
    const timer = window.setTimeout(() => setResultActionFeedback(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [resultActionFeedback]);

  return (
    <section className="query-workspace" aria-label={`${profile.name} 查询工作区`}>
      <header className="query-context">
        <span className="query-context__engine">MySQL</span>
        <strong>{profile.name}</strong>
        <span className="query-context__target">
          {profile.host}:{profile.port} · {profile.database ?? "未指定数据库"}
        </span>
        <span className={`environment-badge environment-badge--${profile.environment}`}>
          {environmentLabel(profile.environment)}
        </span>
        {persistenceError ? (
          <span className="workspace-save-error" role="status">
            未保存到本地
            <button onClick={handleRetryPersistence} type="button">
              重试
            </button>
          </span>
        ) : null}
      </header>

      <div className="query-editor-panel">
        <div className="query-toolbar">
          <span className="query-toolbar__title">{tab.title}</span>
          <button
            className="query-run-button"
            disabled={session.state.running}
            onClick={handleToolbarExecute}
            title={`执行选中 SQL 或当前语句（${getShortcutKeyLabels(shortcuts.bindings.executeQuery).join(" + ")}）`}
            type="button"
          >
            <Play size={13} fill="currentColor" aria-hidden="true" />
            执行
            <kbd>{getShortcutKeyLabels(shortcuts.bindings.executeQuery).join(" + ")}</kbd>
          </button>
        </div>
        <QueryEditor
          ref={queryEditorRef}
          sql={tab.sqlText}
          onSqlChange={(sqlText) => onSqlChange(tab.id, sqlText)}
          onExecute={handleExecute}
          theme={theme}
        />
      </div>

      <section className="query-results" aria-label="结果区域">
        <header className="query-results__header">
          <span>
            结果
            {session.state.rows.length > 0 ? ` · ${session.state.rows.length} 行` : ""}
            {session.state.incomplete ? " · 不完整" : ""}
          </span>
          <span className="query-results__actions">
            {resultActionFeedback ? (
              <span className="query-results__feedback" role="status">{resultActionFeedback}</span>
            ) : null}
            {hasResultRows ? (
              <>
                <button
                  onClick={handleCopyAllResults}
                  title="复制全部结果（含表头，TSV）"
                  type="button"
                >
                  <Copy size={12} aria-hidden="true" />
                  复制全部
                </button>
                <button
                  onClick={handleExportCsv}
                  title="导出全部结果为 CSV"
                  type="button"
                >
                  <Download size={12} aria-hidden="true" />
                  导出 CSV
                </button>
              </>
            ) : null}
            {session.state.running ? (
              <span className="query-loading" role="status">
                <span className="loading-spinner" aria-hidden="true" />
                查询中…
                <button
                  disabled={session.state.cancelRequested}
                  onClick={handleCancel}
                  title={`取消当前查询（${getShortcutKeyLabels(shortcuts.bindings.cancelQuery).join(" + ")}）`}
                  type="button"
                >
                  <X size={12} aria-hidden="true" />
                  取消
                  <kbd>{getShortcutKeyLabels(shortcuts.bindings.cancelQuery).join(" + ")}</kbd>
                </button>
              </span>
            ) : null}
          </span>
        </header>

        {session.state.error && !session.state.running ? (
          <div className="query-error" role="alert">
            <strong>查询失败</strong>
            <span className="query-error__summary">{session.state.error.message}</span>
            <span className="query-error__advice">{queryErrorAdvice(session.state.error)}</span>
            {session.state.error.technicalDetails ? (
              <details className="query-error__details">
                <summary>诊断详情</summary>
                <pre>{session.state.error.technicalDetails}</pre>
              </details>
            ) : null}
          </div>
        ) : null}

        {session.state.columns.length > 0 ? (
          <ResultGrid
            columns={session.state.columns}
            rows={session.state.rows}
            running={session.state.running}
            incomplete={session.state.incomplete}
            onCopyAll={handleCopyAllResults}
          />
        ) : null}

        {!session.state.running &&
        !session.state.error &&
        session.state.columns.length === 0 &&
        session.state.affectedRows === null ? (
          <div className="query-results__empty">
            {session.state.incomplete ? "查询已取消" : "执行查询后，结果会显示在这里。"}
          </div>
        ) : null}

        {!session.state.running &&
        !session.state.error &&
        session.state.columns.length === 0 &&
        session.state.affectedRows !== null ? (
          <div className="query-results__empty">执行完成</div>
        ) : null}
      </section>
    </section>
  );
}
