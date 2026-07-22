import { useState } from "react";
import { Database, PanelLeft, Plus, RotateCw } from "lucide-react";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import { ConnectionForm } from "../features/connections/ConnectionForm";
import { ConnectionSidebar } from "../features/connections/ConnectionSidebar";
import { useConnections } from "../features/connections/useConnections";
import { QueryWorkspace } from "../features/query/QueryWorkspace";
import { useWorkspacePersistence } from "../features/query/useWorkspacePersistence";
import "./tokens.css";
import "./app.css";

/**
 * Composes the connection-management shell around feature-owned connection state.
 * Parameters: none.
 * @returns The React element for the persistent Pipa workspace.
 * Side effects: loads non-secret connection profiles through `useConnections` after mounting.
 */
export function App() {
  const connections = useConnections();
  const queryWorkspace = useWorkspacePersistence();
  const [isAddingConnection, setIsAddingConnection] = useState(false);
  const selectedProfile = connections.profiles.find(
    (profile) => profile.id === connections.selectedConnectionId,
  );
  const activeQueryProfile = connections.profiles.find(
    (profile) => profile.id === queryWorkspace.activeTab?.connectionId,
  );

  /**
   * Adds and selects the saved profile before returning to the connection overview.
   * @param profile - Backend-confirmed non-secret profile.
   * @returns Nothing (`void`).
   * Side effects: updates connection state and closes the add form.
   */
  function handleConnectionSaved(profile: ConnectionProfile): void {
    connections.addProfile(profile);
    if (
      !queryWorkspace.loading &&
      !queryWorkspace.recoveryBlocked &&
      queryWorkspace.tabs.length === 0
    ) {
      queryWorkspace.addTab(profile.id, "查询 1");
    }
    setIsAddingConnection(false);
  }

  /**
   * Changes only navigator selection and creates a fixed tab solely when no workspace exists.
   * @param connectionId - Connection selected in the left navigation.
   * @returns Nothing (`void`).
   * Side effects: updates sidebar state and may create the first immutable MySQL query tab.
   */
  function handleSelectConnection(connectionId: string): void {
    connections.selectConnection(connectionId);
    const profile = connections.profiles.find((item) => item.id === connectionId);
    if (
      profile?.engine === "my_sql" &&
      !queryWorkspace.loading &&
      !queryWorkspace.recoveryBlocked &&
      queryWorkspace.tabs.length === 0
    ) {
      queryWorkspace.addTab(profile.id, "查询 1");
    }
  }

  /**
   * Opens the MySQL connection form from either workspace entry point.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: updates local form visibility state.
   */
  function handleAddConnection(): void {
    if (queryWorkspace.recoveryBlocked) {
      return;
    }
    setIsAddingConnection(true);
  }

  /**
   * Closes the MySQL connection form without persisting its ephemeral state.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: unmounts the form and its password state.
   */
  function handleCancelConnection(): void {
    setIsAddingConnection(false);
  }

  /**
   * Retries loading local profiles after an actionable load error.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: invokes the hook's asynchronous Tauri reload command.
   */
  function handleReloadConnections(): void {
    void connections.reload();
  }

  /** Retries the blocked startup restore before allowing any workspace mutation. */
  function handleRetryWorkspaceRecovery(): void {
    setIsAddingConnection(false);
    void queryWorkspace.retryLoad();
  }

  return (
    <div className="app-shell" role="application" aria-label="Pipa 数据库工作台">
      <aside className="activity-rail" aria-label="主功能">
        <span className="product-mark" aria-label="Pipa">P</span>
        <span className="activity-rail__active" aria-label="连接">
          <PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
        </span>
      </aside>
      <nav className="connection-panel" aria-label="数据库连接">
        <header className="connection-panel__header">
          <span>
            <span className="eyebrow">LOCAL DATABASE TOOL</span>
            <h1>Pipa</h1>
          </span>
          <span className="connection-panel__status" title="所有配置均保存在本机">本机</span>
        </header>

        {connections.loading ? <p className="panel-status">正在读取本地连接…</p> : null}
        {connections.error ? (
          <div className="panel-error" role="alert">
            <p>{connections.error}</p>
            <button type="button" onClick={handleReloadConnections}>
              <RotateCw size={13} aria-hidden="true" />
              重试
            </button>
          </div>
        ) : null}
        <ConnectionSidebar
          onAddConnection={handleAddConnection}
          onSelectConnection={handleSelectConnection}
          profiles={connections.profiles}
          selectedConnectionId={connections.selectedConnectionId}
        />
      </nav>
      <main className="workspace" aria-label="查询工作区">
        <header className="workspace__topbar">
          <span>连接工作区</span>
          <span className="workspace__scope">本地会话</span>
        </header>

        <div
          className={`workspace__content${
            activeQueryProfile?.engine === "my_sql" && !isAddingConnection
              ? " workspace__content--query"
              : ""
          }`}
        >
          {queryWorkspace.recoveryBlocked ? (
            <section
              className="connection-overview"
              aria-labelledby="workspace-recovery-title"
              role="alert"
            >
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">RECOVERY REQUIRED</span>
              <h2 id="workspace-recovery-title">无法恢复上次工作区</h2>
              <p>{queryWorkspace.loadError}</p>
              <button
                className="button button--primary"
                disabled={queryWorkspace.loading}
                onClick={handleRetryWorkspaceRecovery}
                type="button"
              >
                {queryWorkspace.loading ? "正在恢复…" : "重新恢复"}
              </button>
            </section>
          ) : isAddingConnection ? (
            <ConnectionForm
              onCancel={handleCancelConnection}
              onSaved={handleConnectionSaved}
            />
          ) : queryWorkspace.loading ? (
            <p className="panel-status" role="status">
              正在恢复本地工作区…
            </p>
          ) : queryWorkspace.activeTab && activeQueryProfile?.engine === "my_sql" ? (
            <QueryWorkspace
              key={queryWorkspace.activeTab.id}
              onRetryPersistence={queryWorkspace.retrySave}
              onSelectTab={queryWorkspace.selectTab}
              onSqlChange={queryWorkspace.updateTabSql}
              persistenceError={queryWorkspace.saveError}
              profile={activeQueryProfile}
              tab={queryWorkspace.activeTab}
              tabs={queryWorkspace.tabs}
            />
          ) : queryWorkspace.activeTab ? (
            <section className="connection-overview" aria-labelledby="connection-overview-title">
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">CONNECTION UNAVAILABLE</span>
              <h2 id="connection-overview-title">无法恢复查询连接</h2>
              <p>此标签仍保留原连接标识，不会改绑到当前侧栏连接。</p>
            </section>
          ) : selectedProfile ? (
            <section className="connection-overview" aria-labelledby="connection-overview-title">
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">CONNECTION SELECTED</span>
              <h2 id="connection-overview-title">{selectedProfile.name}</h2>
              <p>当前里程碑仅开放 MySQL 查询。请选择一个 MySQL 连接继续。</p>
            </section>
          ) : (
            <section className="connection-overview" aria-labelledby="connection-overview-title">
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">GET STARTED</span>
              <h2 id="connection-overview-title">选择或创建一个 MySQL 连接</h2>
              <p>连接会按数据库引擎独立整理。当前版本仅支持创建 MySQL 连接。</p>
              <button className="button button--primary" onClick={handleAddConnection} type="button">
                <Plus size={16} aria-hidden="true" />
                添加 MySQL 连接
              </button>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
