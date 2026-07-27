import { type FormEvent, useState } from "react";
import { Database, LoaderCircle, ShieldCheck } from "lucide-react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { Environment } from "../../bindings/Environment";
import type { Engine } from "../../bindings/Engine";
import type { SaveConnectionInput } from "../../bindings/SaveConnectionInput";
import type { TlsMode } from "../../bindings/TlsMode";
import {
  saveMySqlConnection,
  saveRedisConnection,
  testMySqlConnection,
  testRedisConnection,
} from "../../lib/tauriClient";

interface ConnectionFormProps {
  engine: Extract<Engine, "my_sql" | "redis">;
  onSaved: (profile: ConnectionProfile) => void;
  onCancel: () => void;
}

/**
 * Extracts a safe message from a typed IPC rejection without trusting unknown fields.
 * @param error - Unknown rejection received from the Tauri boundary.
 * @returns A user-facing message with a stable fallback.
 * Side effects: none.
 */
function getSubmissionErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return "无法连接。请检查地址、凭据和 TLS 设置后重试。";
}

/**
 * Renders a MySQL or Redis test-and-save flow while keeping the password in memory only.
 * @param props - Engine, completion, and cancellation callbacks owned by the workspace.
 * @returns The accessible engine-specific connection form.
 * Side effects: tests and saves through typed Tauri commands after form submission.
 */
export function ConnectionForm({ engine, onSaved, onCancel }: ConnectionFormProps) {
  const isRedis = engine === "redis";
  const [name, setName] = useState("");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(isRedis ? "6379" : "3306");
  const [username, setUsername] = useState("");
  const [database, setDatabase] = useState("");
  const [password, setPassword] = useState("");
  const [environment, setEnvironment] = useState<Environment>("unspecified");
  const [tlsMode, setTlsMode] = useState<TlsMode>(isRedis ? "disabled" : "preferred");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Tests connectivity before saving and always erases the password from React state.
   * @param event - Browser form submission event.
   * @returns A promise that settles after the ordered IPC workflow completes.
   * Side effects: invokes two Tauri commands, updates form state, and notifies the parent on success.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const profile: ConnectionProfile = {
      id: crypto.randomUUID(),
      name: name.trim(),
      engine,
      environment,
      host: host.trim(),
      port: Number(port),
      username: username.trim(),
      database: database.trim() || null,
      tlsMode,
    };
    const input: SaveConnectionInput = { profile, password };

    try {
      if (isRedis) {
        await testRedisConnection(input);
      } else {
        await testMySqlConnection(input);
      }
      const savedProfile = isRedis
        ? await saveRedisConnection(input)
        : await saveMySqlConnection(input);
      onSaved(savedProfile);
    } catch (submissionError: unknown) {
      setError(getSubmissionErrorMessage(submissionError));
    } finally {
      setPassword("");
      setIsSubmitting(false);
    }
  }

  return (
    <section className="connection-form-card" aria-labelledby="connection-form-title">
      <header className="connection-form-card__header">
        <span className="connection-form-card__icon" aria-hidden="true">
          <Database size={18} strokeWidth={1.8} />
        </span>
        <span>
          <span className="eyebrow">{isRedis ? "REDIS CONNECTION" : "MYSQL CONNECTION"}</span>
          <h2 id="connection-form-title">添加 {isRedis ? "Redis" : "MySQL"} 连接</h2>
          <p>先验证连接，再将配置保存在本机。密码仅写入本机加密数据库。</p>
        </span>
      </header>

      <form className="connection-form" onSubmit={handleSubmit}>
        <div className="form-grid">
          <label className="field field--wide">
            <span>连接名称</span>
            <input
              autoFocus
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder={isRedis ? "例如：本地缓存" : "例如：订单生产库"}
              required
              value={name}
            />
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
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
              required={!isRedis}
              spellCheck={false}
              value={username}
            />
          </label>

          <label className="field">
            <span>密码 {isRedis ? <small>可选</small> : null}</span>
            <input
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
              required={!isRedis}
              type="password"
              value={password}
            />
          </label>

          <label className="field field--wide">
            <span>
              默认数据库{" "}
              <small>{isRedis ? "可选；连接后可切换" : "可选"}</small>
            </span>
            <input
              aria-label="默认数据库"
              autoCapitalize="none"
              onChange={(event) => setDatabase(event.target.value)}
              inputMode={isRedis ? "numeric" : undefined}
              min={isRedis ? 0 : undefined}
              spellCheck={false}
              type={isRedis ? "number" : "text"}
              value={database}
            />
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
            <select disabled={isRedis} onChange={(event) => setTlsMode(event.target.value as TlsMode)} value={tlsMode}>
              {isRedis ? <option value="disabled">当前版本仅支持非 TLS Redis</option> : null}
              {!isRedis ? <>
              <option value="preferred">优先</option>
              <option value="required">必须</option>
              <option value="disabled">关闭</option>
              </> : null}
            </select>
          </label>
        </div>

        <div className="credential-note">
          <ShieldCheck size={16} strokeWidth={1.8} aria-hidden="true" />
          密码不会出现在连接列表或浏览器存储中。
        </div>

        {error ? <p className="form-error" role="alert">{error}</p> : null}

        <footer className="form-actions">
          <button className="button button--secondary" disabled={isSubmitting} onClick={onCancel} type="button">
            取消
          </button>
          <button className="button button--primary" disabled={isSubmitting} type="submit">
            {isSubmitting ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
            {isSubmitting ? "正在测试…" : "测试并保存"}
          </button>
        </footer>
      </form>
    </section>
  );
}
