import "./tokens.css";
import "./app.css";

/** Composes the persistent Pipa desktop workspace without owning feature state. */
export function App() {
  return (
    <div className="app-shell" role="application" aria-label="Pipa 数据库工作台">
      <aside className="activity-rail" aria-label="主功能">P</aside>
      <nav className="connection-panel" aria-label="数据库连接">
        <h1>Pipa</h1>
      </nav>
      <main className="workspace" aria-label="查询工作区">
        <p>选择或创建一个 MySQL 连接</p>
      </main>
    </div>
  );
}
