import { Play, X } from "lucide-react";
import { useRef } from "react";
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

  /** Retries the latest failed encrypted workspace snapshot without touching editor state. */
  function handleRetryPersistence(): void {
    void onRetryPersistence();
  }

  return (
    <section className="query-workspace" aria-label={`${profile.name} 查询工作区`}>
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
          <span className="query-toolbar__title">查询 1</span>
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
            <span>{session.state.error.message}</span>
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
