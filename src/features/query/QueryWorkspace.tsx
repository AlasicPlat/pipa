import { Play, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { AppError } from "../../bindings/AppError";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { ResultGrid } from "./ResultGrid";
import { useQuerySession } from "./useQuerySession";
import type { WorkspaceTab } from "./useWorkspacePersistence";

interface QueryWorkspaceProps {
  profile: ConnectionProfile;
  tab: WorkspaceTab;
  tabs: WorkspaceTab[];
  persistenceError: string | null;
  newQueryConnectionName: string | null;
  onCreateQuery: () => void;
  onRetryPersistence: () => Promise<void>;
  onSelectTab: (tabId: string) => void;
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
  tabs,
  persistenceError,
  newQueryConnectionName,
  onCreateQuery,
  onRetryPersistence,
  onSelectTab,
  onSqlChange,
}: QueryWorkspaceProps) {
  const session = useQuerySession(profile.id);
  const queryEditorRef = useRef<QueryEditorHandle>(null);

  /**
   * Executes editor-selected SQL while the current workspace is idle.
   * @param sqlToRun - Selection-first SQL returned by the editor.
   * @returns Nothing (`void`).
   * Side effects: starts the asynchronous query session.
   */
  function handleExecute(sqlToRun: string): void {
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

  /**
   * Creates one query for the navigator-selected MySQL connection when no query is running.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: invokes the workspace-owned creation callback.
   */
  const handleCreateQuery = useCallback((): void => {
    if (session.state.running || newQueryConnectionName === null) {
      return;
    }
    onCreateQuery();
  }, [newQueryConnectionName, onCreateQuery, session.state.running]);

  useEffect(() => {
    /** Captures the desktop new-query shortcut before the WebView handles a browser tab action. */
    function handleNewQueryShortcut(event: KeyboardEvent): void {
      const isNewQuery =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "t";
      if (!isNewQuery) {
        return;
      }
      event.preventDefault();
      handleCreateQuery();
    }

    document.addEventListener("keydown", handleNewQueryShortcut, true);
    return () => document.removeEventListener("keydown", handleNewQueryShortcut, true);
  }, [handleCreateQuery]);

  /** Retries the latest failed encrypted workspace snapshot without touching editor state. */
  function handleRetryPersistence(): void {
    void onRetryPersistence();
  }

  return (
    <section className="query-workspace" aria-label={`${profile.name} 查询工作区`}>
      <div className="query-tabs-bar">
        <div className="query-tabs" role="tablist" aria-label="已恢复查询标签">
          {tabs.map((workspaceTab) => {
            const isActive = workspaceTab.id === tab.id;
            return (
              <button
                aria-selected={isActive}
                className={`query-tab${isActive ? " is-active" : ""}`}
                disabled={session.state.running && !isActive}
                key={workspaceTab.id}
                onClick={() => onSelectTab(workspaceTab.id)}
                role="tab"
                type="button"
              >
                <span>{workspaceTab.title}</span>
              </button>
            );
          })}
        </div>
        <button
          aria-label={
            newQueryConnectionName
              ? `在当前已选 MySQL 连接 ${newQueryConnectionName} 中新建查询`
              : "请选择 MySQL 连接后新建查询"
          }
          className="query-new-button"
          disabled={session.state.running || newQueryConnectionName === null}
          onClick={handleCreateQuery}
          title={newQueryConnectionName ? `新建查询 · ${newQueryConnectionName}` : undefined}
          type="button"
        >
          <Plus size={13} aria-hidden="true" />
          <span>新建查询</span>
          <kbd>Ctrl/Cmd + T</kbd>
        </button>
      </div>
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
            type="button"
          >
            <Play size={13} fill="currentColor" aria-hidden="true" />
            执行
            <kbd>Ctrl/Cmd + R</kbd>
          </button>
        </div>
        <QueryEditor
          ref={queryEditorRef}
          sql={tab.sqlText}
          onSqlChange={(sqlText) => onSqlChange(tab.id, sqlText)}
          onExecute={handleExecute}
        />
      </div>

      <section className="query-results" aria-label="结果区域">
        <header className="query-results__header">
          <span>结果</span>
          {session.state.running ? (
            <span className="query-loading" role="status">
              <span className="loading-spinner" aria-hidden="true" />
              查询中…
              <button
                disabled={session.state.cancelRequested}
                onClick={handleCancel}
                type="button"
              >
                <X size={12} aria-hidden="true" />
                取消
              </button>
            </span>
          ) : null}
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
          />
        ) : null}

        {!session.state.running &&
        !session.state.error &&
        session.state.columns.length === 0 &&
        session.state.affectedRows === null ? (
          <div className="query-results__empty">执行查询后，结果会显示在这里。</div>
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
