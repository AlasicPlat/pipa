import {
  AlertTriangle,
  Check,
  Database,
  DatabasePlus,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { Environment } from "../../bindings/Environment";
import type { TlsMode } from "../../bindings/TlsMode";
import { reconnectConnection, updateConnectionProfile } from "../../lib/tauriClient";
import { listMySqlDatabases, type MySqlDatabaseInfo } from "./mysqlDatabases";

interface ConnectionManagerProps {
  profiles: readonly ConnectionProfile[];
  selectedConnectionId: string | null;
  onAddConnection: () => void;
  onProfileUpdated: (profile: ConnectionProfile) => void;
  onRequestCreateDatabase: (profile: ConnectionProfile) => void;
  onRequestDeleteDatabase: (profile: ConnectionProfile, database: string) => void;
  onRequestDeleteConnection: (profile: ConnectionProfile) => void;
  onSelectConnection: (connectionId: string) => void;
  /** Bumped by the workspace after a schema is created or dropped, to refresh the list. */
  databaseRefreshVersion?: number;
  /** Which view to land on when the manager is opened from a shortcut. */
  requestedView?: "profile" | "databases" | null;
  /** Identity of the latest open request, so repeat requests re-apply the view. */
  requestToken?: number;
}

type ManagerView = "profile" | "databases";

/** Reads a display message from an unknown IPC rejection without trusting unknown fields. */
function errorMessage(error: unknown, fallback: string): string {
  return typeof error === "object"
    && error !== null
    && "message" in error
    && typeof error.message === "string"
    ? error.message
    : fallback;
}

/** Returns the compact engine label used across the manager. */
function engineLabel(engine: ConnectionProfile["engine"]): string {
  return { my_sql: "MySQL", redis: "Redis", postgre_sql: "PostgreSQL", mongo_db: "MongoDB" }[engine];
}

/** Returns the Chinese environment label for one profile. */
function environmentLabel(environment: Environment): string {
  return { production: "生产", development: "开发", unspecified: "未指定" }[environment];
}

interface ProfileEditorProps {
  profile: ConnectionProfile;
  databases: readonly MySqlDatabaseInfo[];
  onProfileUpdated: (profile: ConnectionProfile) => void;
}

/**
 * Edits one saved connection's non-secret fields without asking for its password again.
 *
 * The credential stays untouched in encrypted storage, so changing a host or default database is a
 * metadata edit rather than a re-authentication.
 * @param props - Profile being edited, its visible schemas, and the completion callback.
 * @returns One connection settings form.
 * Side effects: updates the saved profile and may re-test connectivity through Tauri.
 */
function ProfileEditor({ profile, databases, onProfileUpdated }: ProfileEditorProps) {
  const isRedis = profile.engine === "redis";
  const [name, setName] = useState(profile.name);
  const [host, setHost] = useState(profile.host);
  const [port, setPort] = useState(String(profile.port));
  const [username, setUsername] = useState(profile.username);
  const [database, setDatabase] = useState(profile.database ?? "");
  const [environment, setEnvironment] = useState<Environment>(profile.environment);
  const [tlsMode, setTlsMode] = useState<TlsMode>(profile.tlsMode);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Selecting another connection must reset the draft rather than leak the previous one's edits.
  useEffect(() => {
    setName(profile.name);
    setHost(profile.host);
    setPort(String(profile.port));
    setUsername(profile.username);
    setDatabase(profile.database ?? "");
    setEnvironment(profile.environment);
    setTlsMode(profile.tlsMode);
    setError(null);
    setNotice(null);
  }, [profile]);

  const dirty = name !== profile.name
    || host !== profile.host
    || port !== String(profile.port)
    || username !== profile.username
    || database !== (profile.database ?? "")
    || environment !== profile.environment
    || tlsMode !== profile.tlsMode;

  /** Saves the edited non-secret fields and reports the backend-confirmed result. */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await updateConnectionProfile({
        ...profile,
        name: name.trim(),
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        database: database.trim() || null,
        environment,
        tlsMode,
      });
      onProfileUpdated(saved);
      setNotice("已保存连接配置。密码未改动。");
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, "无法保存连接配置，请检查各字段后重试。"));
    } finally {
      setSaving(false);
    }
  }

  /** Re-tests the saved connection using the credential only the backend can read. */
  async function handleTest(): Promise<void> {
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      await reconnectConnection(profile.id);
      setNotice("连接正常。");
    } catch (testError: unknown) {
      setError(errorMessage(testError, "无法连接，请检查地址与凭据。"));
    } finally {
      setTesting(false);
    }
  }

  return (
    <form className="connection-manager__form" onSubmit={handleSubmit}>
      <div className="form-grid">
        <label className="field field--wide">
          <span>连接名称</span>
          <input maxLength={80} onChange={(event) => setName(event.target.value)} required value={name} />
        </label>

        <label className="field field--host">
          <span>主机</span>
          <input
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(event) => setHost(event.target.value)}
            required
            spellCheck={false}
            value={host}
          />
        </label>

        <label className="field field--port">
          <span>端口</span>
          <input
            inputMode="numeric"
            max={65535}
            min={1}
            onChange={(event) => setPort(event.target.value)}
            required
            type="number"
            value={port}
          />
        </label>

        <label className="field">
          <span>用户名</span>
          <input
            autoCapitalize="none"
            onChange={(event) => setUsername(event.target.value)}
            required={!isRedis}
            spellCheck={false}
            value={username}
          />
        </label>

        <label className="field">
          <span>默认数据库 <small>{isRedis ? "逻辑库编号" : "打开连接时默认浏览"}</small></span>
          {isRedis || databases.length === 0 ? (
            <input
              autoCapitalize="none"
              inputMode={isRedis ? "numeric" : undefined}
              onChange={(event) => setDatabase(event.target.value)}
              spellCheck={false}
              type={isRedis ? "number" : "text"}
              value={database}
            />
          ) : (
            /* Choosing from the server's own list avoids typos that only fail later. */
            <select onChange={(event) => setDatabase(event.target.value)} value={database}>
              <option value="">未指定</option>
              {databases.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}{item.system ? "（系统库）" : ""}
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="field">
          <span>环境</span>
          <select
            onChange={(event) => setEnvironment(event.target.value as Environment)}
            value={environment}
          >
            <option value="unspecified">未指定</option>
            <option value="development">开发</option>
            <option value="production">生产</option>
          </select>
        </label>

        <label className="field">
          <span>TLS</span>
          <select
            disabled={isRedis}
            onChange={(event) => setTlsMode(event.target.value as TlsMode)}
            value={tlsMode}
          >
            {isRedis ? <option value="disabled">当前版本仅支持非 TLS Redis</option> : (
              <>
                <option value="preferred">优先</option>
                <option value="required">必须</option>
                <option value="disabled">关闭</option>
              </>
            )}
          </select>
        </label>
      </div>

      <div className="credential-note">
        <ShieldCheck size={16} strokeWidth={1.8} aria-hidden="true" />
        修改这些字段不需要重新输入密码；已保存的凭据不会被读取或改写。
      </div>

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="connection-manager__notice" role="status">{notice}</p> : null}

      <footer className="form-actions">
        <button
          className="button button--secondary"
          disabled={testing || saving}
          onClick={() => void handleTest()}
          type="button"
        >
          {testing ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
          {testing ? "正在测试…" : "测试连接"}
        </button>
        <button className="button button--primary" disabled={!dirty || saving} type="submit">
          {saving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
          {saving ? "正在保存…" : "保存配置"}
        </button>
      </footer>
    </form>
  );
}

/**
 * Renders the full-tab surface for managing connections and their databases.
 *
 * Configuration lives here rather than in the navigator: the navigator answers "which table am I
 * looking at", while this page answers "which servers and schemas exist". Browsing therefore stops
 * at the database level here, and tables never appear.
 * @param props - Saved profiles, selection, and the workspace callbacks for each action.
 * @returns The connection manager workspace.
 * Side effects: reads schema lists and updates saved profiles through Tauri.
 */
export function ConnectionManager({
  profiles,
  selectedConnectionId,
  onAddConnection,
  onProfileUpdated,
  onRequestCreateDatabase,
  onRequestDeleteDatabase,
  onRequestDeleteConnection,
  onSelectConnection,
  databaseRefreshVersion = 0,
  requestedView = null,
  requestToken = 0,
}: ConnectionManagerProps) {
  const [view, setView] = useState<ManagerView>("profile");

  // Each open request re-applies its view, so "manage databases" always lands on that tab.
  useEffect(() => {
    if (requestedView) {
      setView(requestedView);
    }
  }, [requestToken, requestedView]);
  const [databases, setDatabases] = useState<MySqlDatabaseInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeProfile = profiles.find((profile) => profile.id === selectedConnectionId)
    ?? profiles[0]
    ?? null;
  const isMySql = activeProfile?.engine === "my_sql";

  /** Loads the visible schema list for the active MySQL connection. */
  const loadDatabases = useCallback(async (connectionId: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setDatabases(await listMySqlDatabases(connectionId));
    } catch (loadError: unknown) {
      setDatabases([]);
      setError(errorMessage(loadError, "无法读取数据库列表。"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeProfile || activeProfile.engine !== "my_sql") {
      setDatabases([]);
      setError(null);
      return;
    }
    void loadDatabases(activeProfile.id);
  }, [activeProfile, databaseRefreshVersion, loadDatabases]);

  return (
    <section className="connection-manager" aria-label="连接管理">
      <div className="connection-manager__list">
        <header>
          <span>连接 <small>{profiles.length}</small></span>
          <button aria-label="新建连接" onClick={onAddConnection} title="新建连接" type="button">
            <Plus size={13} aria-hidden="true" />
          </button>
        </header>
        {profiles.length === 0 ? (
          <p className="connection-manager__empty">还没有保存任何连接。</p>
        ) : (
          <div role="listbox" aria-label="已保存的连接">
            {profiles.map((profile) => (
              <button
                aria-selected={profile.id === activeProfile?.id}
                className="connection-manager__item"
                key={profile.id}
                onClick={() => onSelectConnection(profile.id)}
                role="option"
                type="button"
              >
                <Server size={13} aria-hidden="true" />
                <span>
                  <strong>{profile.name}</strong>
                  <small>{engineLabel(profile.engine)} · {profile.host}:{profile.port}</small>
                </span>
                {profile.id === activeProfile?.id ? <Check size={12} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeProfile ? (
        <div className="connection-manager__detail">
          <header className="connection-manager__detail-header">
            <span>
              <h2>{activeProfile.name}</h2>
              <small>
                {engineLabel(activeProfile.engine)} · {environmentLabel(activeProfile.environment)}
                {" · "}{activeProfile.host}:{activeProfile.port}
              </small>
            </span>
            <button
              className="connection-manager__danger"
              onClick={() => onRequestDeleteConnection(activeProfile)}
              type="button"
            >
              <Trash2 size={13} aria-hidden="true" />
              删除连接…
            </button>
          </header>

          <div className="connection-manager__tabs" role="tablist" aria-label="连接管理视图">
            <button
              aria-selected={view === "profile"}
              onClick={() => setView("profile")}
              role="tab"
              type="button"
            >
              连接信息
            </button>
            <button
              aria-selected={view === "databases"}
              disabled={!isMySql}
              onClick={() => setView("databases")}
              role="tab"
              title={isMySql ? undefined : "仅 MySQL 连接支持数据库管理"}
              type="button"
            >
              数据库{isMySql && databases.length > 0 ? ` (${databases.length})` : ""}
            </button>
          </div>

          {view === "profile" ? (
            <ProfileEditor
              databases={databases}
              key={activeProfile.id}
              onProfileUpdated={onProfileUpdated}
              profile={activeProfile}
            />
          ) : (
            <div className="connection-manager__databases">
              <header>
                <span>此连接可见的数据库</span>
                <span className="connection-manager__database-actions">
                  <button
                    aria-label="刷新数据库列表"
                    disabled={loading}
                    onClick={() => void loadDatabases(activeProfile.id)}
                    title="刷新"
                    type="button"
                  >
                    {loading
                      ? <LoaderCircle className="spin" size={13} aria-hidden="true" />
                      : <RefreshCw size={13} aria-hidden="true" />}
                  </button>
                  <button
                    className="button button--primary"
                    onClick={() => onRequestCreateDatabase(activeProfile)}
                    type="button"
                  >
                    <DatabasePlus size={13} aria-hidden="true" />
                    新建数据库
                  </button>
                </span>
              </header>
              {error ? <p className="form-error" role="alert">{error}</p> : null}
              {loading && databases.length === 0 ? (
                <p className="connection-manager__empty">正在读取数据库…</p>
              ) : databases.length === 0 && !error ? (
                <p className="connection-manager__empty">此连接没有可见的数据库。</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th scope="col">数据库</th>
                      <th scope="col">字符集</th>
                      <th scope="col">排序规则</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {databases.map((item) => (
                      <tr key={item.name}>
                        <th scope="row">
                          <Database size={12} aria-hidden="true" />
                          {item.name}
                          {item.name === activeProfile.database ? <em>默认</em> : null}
                          {item.system ? <b>系统库</b> : null}
                        </th>
                        <td>{item.charset}</td>
                        <td>{item.collation}</td>
                        <td>
                          {/* Server-managed schemas cannot be dropped, so no action is offered. */}
                          {item.system ? (
                            <span className="connection-manager__locked">
                              <AlertTriangle size={11} aria-hidden="true" />
                              受服务器保护
                            </span>
                          ) : (
                            <button
                              className="connection-manager__danger"
                              onClick={() => onRequestDeleteDatabase(activeProfile, item.name)}
                              type="button"
                            >
                              <Trash2 size={12} aria-hidden="true" />
                              删除…
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="connection-manager__detail connection-manager__detail--empty">
          <p>先添加一个连接，然后在这里管理它的配置与数据库。</p>
          <button className="button button--primary" onClick={onAddConnection} type="button">
            <Plus size={13} aria-hidden="true" />
            新建连接
          </button>
        </div>
      )}
    </section>
  );
}
