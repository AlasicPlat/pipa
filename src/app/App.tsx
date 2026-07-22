import { useState } from "react";
import { Database, PanelLeft, Plus, RotateCw } from "lucide-react";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import { ConnectionForm } from "../features/connections/ConnectionForm";
import { ConnectionSidebar } from "../features/connections/ConnectionSidebar";
import { useConnections } from "../features/connections/useConnections";
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
  const [isAddingConnection, setIsAddingConnection] = useState(false);
  const selectedProfile = connections.profiles.find(
    (profile) => profile.id === connections.selectedConnectionId,
  );

  /**
   * Adds and selects the saved profile before returning to the connection overview.
   * @param profile - Backend-confirmed non-secret profile.
   * @returns Nothing (`void`).
   * Side effects: updates connection state and closes the add form.
   */
  function handleConnectionSaved(profile: ConnectionProfile): void {
    connections.addProfile(profile);
    setIsAddingConnection(false);
  }

  /**
   * Opens the MySQL connection form from either workspace entry point.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: updates local form visibility state.
   */
  function handleAddConnection(): void {
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
          onSelectConnection={connections.selectConnection}
          profiles={connections.profiles}
          selectedConnectionId={connections.selectedConnectionId}
        />
      </nav>
      <main className="workspace" aria-label="查询工作区">
        <header className="workspace__topbar">
          <span>连接工作区</span>
          <span className="workspace__scope">本地会话</span>
        </header>

        <div className="workspace__content">
          {isAddingConnection ? (
            <ConnectionForm
              onCancel={handleCancelConnection}
              onSaved={handleConnectionSaved}
            />
          ) : (
            <section className="connection-overview" aria-labelledby="connection-overview-title">
              <span className="connection-overview__icon" aria-hidden="true">
                <Database size={24} strokeWidth={1.6} />
              </span>
              <span className="eyebrow">{selectedProfile ? "MYSQL SELECTED" : "GET STARTED"}</span>
              <h2 id="connection-overview-title">
                {selectedProfile?.name ?? "选择或创建一个 MySQL 连接"}
              </h2>
              <p>
                {selectedProfile
                  ? `${selectedProfile.host}:${selectedProfile.port} · ${selectedProfile.database ?? "未指定数据库"}`
                  : "连接会按数据库引擎独立整理。当前版本仅支持创建 MySQL 连接。"}
              </p>
              {!selectedProfile ? (
                <button className="button button--primary" onClick={handleAddConnection} type="button">
                  <Plus size={16} aria-hidden="true" />
                  添加 MySQL 连接
                </button>
              ) : null}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
