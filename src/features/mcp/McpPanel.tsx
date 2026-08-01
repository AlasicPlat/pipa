import { Copy, Maximize2, Minimize2, Play, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { Engine } from "../../bindings/Engine";
import type { SqlRisk } from "../../bindings/SqlRisk";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isTauri } from "@tauri-apps/api/core";
import { useMcpState } from "./useMcpState";
import type { PendingSqlProposal } from "./types";
import "./mcp.css";

interface McpPanelProps {
  open: boolean;
  onClose: () => void;
  profiles: ConnectionProfile[];
}

const RISK_LABELS: Record<SqlRisk, string> = {
  read: "只读",
  write_data: "DML",
  schema_change: "DDL",
  unknown: "未知",
};

const ENGINE_LABELS: Record<Engine, string> = {
  my_sql: "MySQL",
  postgre_sql: "PostgreSQL",
  mongo_db: "MongoDB",
  redis: "Redis",
};

/**
 * Formats a connection option with an engine prefix and optional database name.
 * @param profile - Non-secret saved connection metadata.
 * @returns A disambiguated label suitable for a native select option.
 * Side effects: none.
 */
function connectionOptionLabel(profile: ConnectionProfile): string {
  const database = profile.database ? ` · ${profile.database}` : "";
  return `${ENGINE_LABELS[profile.engine]} · ${profile.name}${database}`;
}

/**
 * Main-window MCP console: server controls, pending SQL confirmation, activity, manual SQL.
 */
export function McpPanel({ open, onClose, profiles }: McpPanelProps) {
  const mcp = useMcpState(open);
  const [expanded, setExpanded] = useState(false);
  const [portDraft, setPortDraft] = useState("");
  const [manualConnectionId, setManualConnectionId] = useState("");
  const [manualSql, setManualSql] = useState("");
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const mysqlProfiles = useMemo(
    () => profiles.filter((profile) => profile.engine === "my_sql"),
    [profiles],
  );
  const pending = mcp.snapshot.proposals.filter((item) => item.status === "pending");
  const status = mcp.snapshot.status;
  const effectivePort = portDraft || String(status.port);
  const targetProfiles = profiles.filter((profile) =>
    status.targetConnectionIds.includes(profile.id)
  );
  const unavailableTargetIds = status.targetConnectionIds.filter(
    (connectionId) => !profiles.some((profile) => profile.id === connectionId),
  );

  if (!open) {
    return null;
  }

  const cursorConfig = status.running && status.url && status.token
    ? JSON.stringify(
      {
        mcpServers: {
          pipa: {
            url: status.url,
            headers: {
              Authorization: `Bearer ${status.token}`,
            },
          },
        },
      },
      null,
      2,
    )
    : null;

  async function copyText(label: string, value: string): Promise<void> {
    try {
      if (isTauri()) {
        await writeText(value);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(value);
      }
      setCopyNotice(`已复制${label}`);
      window.setTimeout(() => setCopyNotice(null), 1600);
    } catch {
      setCopyNotice(`复制${label}失败`);
    }
  }

  return (
    <div
      className={`mcp-panel${expanded ? " mcp-panel--expanded" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-panel-title"
    >
      <header className="mcp-panel__header">
        <div>
          <p className="eyebrow">MCP</p>
          <h2 id="mcp-panel-title">MCP 控制台</h2>
        </div>
        <div className="mcp-panel__header-actions">
          <button
            aria-label={expanded ? "收缩 MCP 控制台" : "展开 MCP 控制台"}
            aria-pressed={expanded}
            onClick={() => setExpanded((current) => !current)}
            title={expanded ? "切换为紧凑面板" : "切换为宽屏面板"}
            type="button"
          >
            {expanded
              ? <Minimize2 size={16} aria-hidden="true" />
              : <Maximize2 size={16} aria-hidden="true" />}
          </button>
          <button aria-label="关闭 MCP 控制台" onClick={onClose} type="button">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="mcp-panel__body">
        <section
          className="mcp-panel__section mcp-panel__section--status"
          aria-labelledby="mcp-status-title"
        >
          <h3 id="mcp-status-title">服务状态</h3>
          <div className="mcp-panel__status-row">
            <span className={`mcp-panel__badge ${status.running ? "mcp-panel__badge--on" : ""}`}>
              {status.running ? "运行中" : "已停止"}
            </span>
            <button
              className="button button--primary"
              disabled={mcp.busy}
              onClick={() => void (status.running ? mcp.stop() : mcp.start())}
              type="button"
            >
              {status.running ? "停止" : "启动"}
            </button>
            <button
              className="button"
              disabled={mcp.busy || !status.running}
              onClick={() => void mcp.regenerateToken()}
              type="button"
            >
              <RefreshCw size={14} aria-hidden="true" />
              重新生成 Token
            </button>
          </div>

          <div className="mcp-panel__scope">
            <div className="mcp-panel__scope-heading">
              <span>
                <strong>是否指定连接</strong>
                <small>
                  {status.restrictToConnection
                    ? `MCP 仅能发现和访问已选中的 ${status.targetConnectionIds.length} 个连接。`
                    : "关闭时，MCP 可发现全部已保存连接。"}
                </small>
              </span>
              <label className="mcp-panel__switch">
                <input
                  aria-label="是否指定 MCP 连接"
                  checked={status.restrictToConnection}
                  disabled={mcp.busy || status.targetConnectionIds.length === 0}
                  onChange={(event) =>
                    void mcp.setConnectionScope(
                      event.target.checked,
                      status.targetConnectionIds,
                    )}
                  role="switch"
                  type="checkbox"
                />
                <span aria-hidden="true" />
              </label>
            </div>
            <div className="mcp-panel__field mcp-panel__field--flush">
              <span>
                MCP 目标连接 · 已选 {status.targetConnectionIds.length} 个
              </span>
              <div
                aria-label="MCP 目标连接"
                className="mcp-panel__connection-options"
                role="group"
              >
                {profiles.length === 0 && unavailableTargetIds.length === 0 ? (
                  <span className="mcp-panel__connection-empty">暂无已保存连接</span>
                ) : null}
                {unavailableTargetIds.map((connectionId) => (
                  <label className="mcp-panel__connection-option" key={connectionId}>
                    <input
                      checked
                      disabled={mcp.busy}
                      onChange={() => {
                        const targetConnectionIds = status.targetConnectionIds.filter(
                          (targetId) => targetId !== connectionId,
                        );
                        void mcp.setConnectionScope(
                          status.restrictToConnection && targetConnectionIds.length > 0,
                          targetConnectionIds,
                        );
                      }}
                      type="checkbox"
                    />
                    <span>连接已不可用 · {connectionId}</span>
                  </label>
                ))}
                {profiles.map((profile) => {
                  const checked = status.targetConnectionIds.includes(profile.id);
                  return (
                    <label className="mcp-panel__connection-option" key={profile.id}>
                      <input
                        checked={checked}
                        disabled={mcp.busy}
                        onChange={(event) => {
                          const targetConnectionIds = event.target.checked
                            ? [...status.targetConnectionIds, profile.id]
                            : status.targetConnectionIds.filter(
                              (connectionId) => connectionId !== profile.id,
                            );
                          void mcp.setConnectionScope(
                            status.restrictToConnection && targetConnectionIds.length > 0,
                            targetConnectionIds,
                          );
                        }}
                        type="checkbox"
                      />
                      <span>{connectionOptionLabel(profile)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <p className="mcp-panel__hint">
              <code>list_connections</code> 返回值包含 <code>engine</code> 字段，用于区分
              MySQL、PostgreSQL、MongoDB 和 Redis。
            </p>
            {targetProfiles.some((profile) => profile.engine !== "my_sql") ? (
              <p className="mcp-panel__warning">
                所选连接中包含非 MySQL 连接；当前版本的 MCP 表结构与 SQL 查询工具仅支持
                MySQL。
              </p>
            ) : null}
          </div>

          <label className="mcp-panel__field">
            <span>端口</span>
            <span className="mcp-panel__inline">
              <input
                inputMode="numeric"
                onChange={(event) => setPortDraft(event.target.value)}
                value={effectivePort}
              />
              <button
                className="button"
                disabled={mcp.busy}
                onClick={() => {
                  const port = Number(effectivePort);
                  if (!Number.isInteger(port) || port < 1 || port > 65535) {
                    return;
                  }
                  void mcp.setPort(port).then(() => setPortDraft(""));
                }}
                type="button"
              >
                应用
              </button>
            </span>
          </label>

          {status.url ? (
            <label className="mcp-panel__field">
              <span>URL</span>
              <span className="mcp-panel__inline">
                <code>{status.url}</code>
                <button
                  aria-label="复制 URL"
                  className="button"
                  onClick={() => void copyText(" URL", status.url ?? "")}
                  type="button"
                >
                  <Copy size={14} aria-hidden="true" />
                </button>
              </span>
            </label>
          ) : null}

          {status.token ? (
            <label className="mcp-panel__field">
              <span>Token</span>
              <span className="mcp-panel__inline">
                <code className="mcp-panel__token">{status.token}</code>
                <button
                  aria-label="复制 Token"
                  className="button"
                  onClick={() => void copyText(" Token", status.token ?? "")}
                  type="button"
                >
                  <Copy size={14} aria-hidden="true" />
                </button>
              </span>
            </label>
          ) : null}

          {cursorConfig ? (
            <div className="mcp-panel__field">
              <span>Cursor 配置片段</span>
              <pre className="mcp-panel__config">{cursorConfig}</pre>
              <button
                className="button"
                onClick={() => void copyText("配置", cursorConfig)}
                type="button"
              >
                <Copy size={14} aria-hidden="true" />
                复制配置
              </button>
            </div>
          ) : (
            <p className="mcp-panel__hint">启动 MCP 后可复制带 Token 的 Cursor 配置。</p>
          )}

          {status.lastError ? <p className="mcp-panel__error" role="alert">{status.lastError}</p> : null}
          {mcp.error ? <p className="mcp-panel__error" role="alert">{mcp.error}</p> : null}
          {copyNotice ? <p className="mcp-panel__notice" role="status">{copyNotice}</p> : null}
          {mcp.loading ? <p className="panel-status" role="status">正在加载…</p> : null}
        </section>

        <section
          className="mcp-panel__section mcp-panel__section--pending"
          aria-labelledby="mcp-pending-title"
        >
          <h3 id="mcp-pending-title">待确认 SQL ({pending.length})</h3>
          {pending.length === 0 ? (
            <p className="mcp-panel__hint">MCP 提出的 DML/DDL 会显示在这里，确认后才会执行。</p>
          ) : (
            <ul className="mcp-panel__list">
              {pending.map((proposal) => (
                <ProposalCard
                  busy={mcp.busy}
                  key={proposal.id}
                  onDismiss={() => void mcp.dismissProposal(proposal.id)}
                  onExecute={() => void mcp.executeProposal(proposal.id)}
                  profiles={mysqlProfiles}
                  proposal={proposal}
                />
              ))}
            </ul>
          )}
        </section>

        <section
          className="mcp-panel__section mcp-panel__section--manual"
          aria-labelledby="mcp-manual-title"
        >
          <h3 id="mcp-manual-title">手动 SQL</h3>
          <p className="mcp-panel__hint">在此可执行 DML/DDL；与工作台相同，不走 MCP 只读限制。</p>
          <label className="mcp-panel__field">
            <span>连接</span>
            <select
              onChange={(event) => setManualConnectionId(event.target.value)}
              value={manualConnectionId}
            >
              <option value="">选择 MySQL 连接</option>
              {mysqlProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {connectionOptionLabel(profile)}
                  {profile.environment === "production" ? " · 生产" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="mcp-panel__field">
            <span>SQL</span>
            <textarea
              onChange={(event) => setManualSql(event.target.value)}
              placeholder="INSERT / UPDATE / ALTER …"
              rows={5}
              value={manualSql}
            />
          </label>
          <button
            className="button button--primary"
            disabled={mcp.busy || !manualConnectionId || !manualSql.trim()}
            onClick={() => void mcp.runManualSql(manualConnectionId, manualSql)}
            type="button"
          >
            <Play size={14} aria-hidden="true" />
            执行
          </button>
        </section>

        <section
          className="mcp-panel__section mcp-panel__section--activity"
          aria-labelledby="mcp-activity-title"
        >
          <h3 id="mcp-activity-title">活动日志</h3>
          {mcp.snapshot.activity.length === 0 ? (
            <p className="mcp-panel__hint">尚无 MCP 活动。</p>
          ) : (
            <ul className="mcp-panel__activity">
              {mcp.snapshot.activity.map((entry) => (
                <li key={entry.id}>
                  <span className={entry.ok ? "mcp-panel__ok" : "mcp-panel__fail"}>
                    {entry.ok ? "OK" : "ERR"}
                  </span>
                  <strong>{entry.tool}</strong>
                  <code>{entry.summary}</code>
                  {entry.detail ? <small>{entry.detail}</small> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

interface ProposalCardProps {
  proposal: PendingSqlProposal;
  profiles: ConnectionProfile[];
  busy: boolean;
  onExecute: () => void;
  onDismiss: () => void;
}

function ProposalCard({ proposal, profiles, busy, onExecute, onDismiss }: ProposalCardProps) {
  const profile = profiles.find((item) => item.id === proposal.connectionId);
  const production = profile?.environment === "production";
  return (
    <li className={`mcp-panel__proposal${production ? " mcp-panel__proposal--production" : ""}`}>
      <div className="mcp-panel__proposal-meta">
        <span className={`mcp-panel__risk mcp-panel__risk--${proposal.risk}`}>
          {RISK_LABELS[proposal.risk]}
        </span>
        <strong>{profile?.name ?? proposal.connectionId}</strong>
        {production ? <span className="mcp-panel__prod">生产</span> : null}
        <small>{proposal.sourceTool}</small>
      </div>
      <pre>{proposal.sql}</pre>
      <div className="mcp-panel__proposal-actions">
        <button className="button button--primary" disabled={busy} onClick={onExecute} type="button">
          确认执行
        </button>
        <button className="button" disabled={busy} onClick={onDismiss} type="button">
          忽略
        </button>
      </div>
    </li>
  );
}
