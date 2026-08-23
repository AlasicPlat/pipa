import { ChevronDown, ChevronRight, Copy, Eye, EyeOff, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { Engine } from "../../bindings/Engine";
import type { SqlRisk } from "../../bindings/SqlRisk";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isTauri } from "@tauri-apps/api/core";
import { useMcpState } from "./useMcpState";
import type { McpActivityEntry, PendingSqlProposal } from "./types";
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
 * Masks a bearer token, keeping only enough characters to recognise it.
 * @param token - Full MCP bearer token.
 * @returns The first and last four characters joined by a fixed-width ellipsis.
 * Side effects: none.
 */
function maskToken(token: string): string {
  if (token.length <= 10) {
    return "•".repeat(token.length);
  }
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
}

/**
 * Formats an ISO timestamp into a compact local clock for activity rows.
 * @param iso - Activity entry timestamp from the backend.
 * @returns Local `HH:MM:SS` text, or the original string when parsing fails.
 * Side effects: none.
 */
function formatActivityTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Main-window MCP console for server controls, pending SQL confirmation, and activity.
 */
export function McpPanel({ open, onClose, profiles }: McpPanelProps) {
  const mcp = useMcpState(open);
  const [expanded, setExpanded] = useState(false);
  const [targetsExpanded, setTargetsExpanded] = useState(true);
  const [expandedActivityIds, setExpandedActivityIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [portDraft, setPortDraft] = useState("");
  const [portError, setPortError] = useState<string | null>(null);
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    /** Closes the console on Escape, matching every other Pipa dialog. */
    function handleEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [onClose, open]);

  // Move focus into the dialog so keyboard users are not left behind in the workspace.
  useEffect(() => {
    if (open) {
      window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    }
  }, [open]);

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
  const selectedTargetSummary = [
    ...targetProfiles.map((profile) => connectionOptionLabel(profile)),
    ...unavailableTargetIds.map((connectionId) => `连接已不可用 · ${connectionId}`),
  ];

  // A regenerated token must never stay visible from a previous reveal.
  useEffect(() => {
    setTokenRevealed(false);
  }, [status.token]);

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

  /**
   * Validates the port draft and reports why it was rejected instead of doing nothing.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: shows a validation message, or asks the backend to rebind the port.
   */
  function handleApplyPort(): void {
    const port = Number(portDraft.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortError("端口需为 1 到 65535 之间的整数。");
      return;
    }
    if (port === status.port) {
      setPortError(null);
      setPortDraft("");
      return;
    }
    setPortError(null);
    void mcp.setPort(port).then(() => setPortDraft(""));
  }

  /** Toggles one activity row without forcing sibling rows open or closed. */
  function toggleActivityEntry(entryId: string): void {
    setExpandedActivityIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  }

  return (
    <div
      className="mcp-panel-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
    <div
      className={`mcp-panel${expanded ? " mcp-panel--expanded" : ""}${
        pending.length > 0 ? " mcp-panel--has-pending" : ""
      }`}
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
          <button
            aria-label="关闭 MCP 控制台"
            onClick={onClose}
            ref={closeButtonRef}
            title="关闭（Escape）"
            type="button"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="mcp-panel__body">
        <div className="mcp-panel__column mcp-panel__column--primary">
        <section
          className="mcp-panel__section mcp-panel__section--status"
          aria-labelledby="mcp-status-title"
        >
          <div className="mcp-panel__section-header">
            <h3 id="mcp-status-title">服务状态</h3>
            <span className={`mcp-panel__badge ${status.running ? "mcp-panel__badge--on" : ""}`}>
              {status.running ? "运行中" : "已停止"}
            </span>
          </div>
          <div className="mcp-panel__status-row">
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

          <div className="mcp-panel__port-control">
            <label htmlFor="mcp-port">端口</label>
            <input
              aria-describedby={portError ? "mcp-port-error" : undefined}
              aria-invalid={portError ? true : undefined}
              id="mcp-port"
              inputMode="numeric"
              max={65535}
              min={1}
              onChange={(event) => {
                setPortDraft(event.target.value);
                setPortError(null);
              }}
              type="number"
              value={effectivePort}
            />
            <button
              className="button"
              disabled={mcp.busy || portDraft.trim() === ""}
              onClick={handleApplyPort}
              title={status.running ? "应用后会以新端口重启 MCP" : undefined}
              type="button"
            >
              应用
            </button>
          </div>
          {portError ? (
            <p className="mcp-panel__error" id="mcp-port-error" role="alert">{portError}</p>
          ) : status.running && portDraft.trim() !== "" ? (
            <p className="mcp-panel__hint">应用新端口会重启 MCP，客户端需要更新配置。</p>
          ) : null}

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
            <div className="mcp-panel__field">
              <span>Token</span>
              <span className="mcp-panel__inline">
                {/* Masked by default: this is a bearer credential for a live local server. */}
                <code className="mcp-panel__token">
                  {tokenRevealed ? status.token : maskToken(status.token)}
                </code>
                <button
                  aria-label={tokenRevealed ? "隐藏 Token" : "显示 Token"}
                  aria-pressed={tokenRevealed}
                  className="button"
                  onClick={() => setTokenRevealed((current) => !current)}
                  title={tokenRevealed ? "隐藏 Token" : "显示完整 Token"}
                  type="button"
                >
                  {tokenRevealed
                    ? <EyeOff size={14} aria-hidden="true" />
                    : <Eye size={14} aria-hidden="true" />}
                </button>
                <button
                  aria-label="复制 Token"
                  className="button"
                  onClick={() => void copyText(" Token", status.token ?? "")}
                  title="复制完整 Token"
                  type="button"
                >
                  <Copy size={14} aria-hidden="true" />
                </button>
              </span>
            </div>
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
          className="mcp-panel__section mcp-panel__section--targets"
          aria-labelledby="mcp-targets-title"
        >
          <div className="mcp-panel__scope-heading">
            <span>
              <strong>是否指定连接</strong>
              <small>
                {status.targetConnectionIds.length === 0
                  ? "请先在下方勾选至少一个目标连接，才能限定访问范围。"
                  : status.restrictToConnection
                    ? `MCP 仅能发现和访问已选中的 ${status.targetConnectionIds.length} 个连接。`
                    : "当前 MCP 可发现全部已保存连接。"}
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
                title={status.targetConnectionIds.length === 0
                  ? "请先勾选目标连接"
                  : undefined}
                type="checkbox"
              />
              <span aria-hidden="true" />
            </label>
          </div>
          {!status.restrictToConnection && profiles.length > 0 ? (
            <p className="mcp-panel__warning">
              未限定范围时，MCP 可以访问全部 {profiles.length} 个已保存连接，包括生产环境。
            </p>
          ) : null}

          <div className="mcp-panel__disclosure-block">
            <button
              aria-controls="mcp-target-connections"
              aria-expanded={targetsExpanded}
              className="mcp-panel__disclosure"
              id="mcp-targets-title"
              onClick={() => setTargetsExpanded((current) => !current)}
              type="button"
            >
              {targetsExpanded
                ? <ChevronDown size={15} aria-hidden="true" />
                : <ChevronRight size={15} aria-hidden="true" />}
              <span>
                <strong>MCP 目标连接</strong>
                <small>已选 {status.targetConnectionIds.length} 个</small>
              </span>
            </button>
            {!targetsExpanded ? (
              <div className="mcp-panel__collapsed-summary">
                {selectedTargetSummary.length === 0 ? (
                  <span className="mcp-panel__collapsed-empty">未选择目标连接</span>
                ) : (
                  <ul className="mcp-panel__selected-chips">
                    {selectedTargetSummary.slice(0, 3).map((label) => (
                      <li key={label} title={label}>{label}</li>
                    ))}
                    {selectedTargetSummary.length > 3 ? (
                      <li className="mcp-panel__selected-chips-more">
                        +{selectedTargetSummary.length - 3}
                      </li>
                    ) : null}
                  </ul>
                )}
              </div>
            ) : null}
            <div
              aria-label="MCP 目标连接"
              className="mcp-panel__connection-options"
              hidden={!targetsExpanded}
              id="mcp-target-connections"
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
        </section>
        </div>

        <div className="mcp-panel__column mcp-panel__column--secondary">
        <section
          className="mcp-panel__section mcp-panel__section--pending"
          aria-labelledby="mcp-pending-title"
        >
          <div className="mcp-panel__section-header">
            <h3 id="mcp-pending-title">待确认 SQL</h3>
            <span className="mcp-panel__count">{pending.length}</span>
          </div>
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
          className="mcp-panel__section mcp-panel__section--activity"
          aria-labelledby="mcp-activity-title"
        >
          <div className="mcp-panel__section-header">
            <h3 id="mcp-activity-title">活动日志</h3>
            <span className="mcp-panel__count">{mcp.snapshot.activity.length}</span>
          </div>
          {mcp.snapshot.activity.length === 0 ? (
            <p className="mcp-panel__hint">尚无 MCP 活动。</p>
          ) : (
            <ul className="mcp-panel__activity">
              {mcp.snapshot.activity.map((entry) => (
                <ActivityEntryRow
                  entry={entry}
                  expanded={expandedActivityIds.has(entry.id)}
                  key={entry.id}
                  onToggle={() => toggleActivityEntry(entry.id)}
                  profiles={profiles}
                />
              ))}
            </ul>
          )}
        </section>
        </div>

      </div>
    </div>
    </div>
  );
}

interface ActivityEntryRowProps {
  entry: McpActivityEntry;
  expanded: boolean;
  onToggle: () => void;
  profiles: ConnectionProfile[];
}

/**
 * Renders one activity log row with a compact summary and optional detail pane.
 * @param props - Entry data, expand state, toggle handler, and connection labels.
 * @returns A list item for the MCP activity feed.
 * Side effects: invokes `onToggle` after explicit button interaction.
 */
function ActivityEntryRow({ entry, expanded, onToggle, profiles }: ActivityEntryRowProps) {
  const connectionName = entry.connectionId
    ? profiles.find((profile) => profile.id === entry.connectionId)?.name ?? entry.connectionId
    : null;
  const detailId = `mcp-activity-detail-${entry.id}`;

  return (
    <li className={`mcp-panel__activity-item${expanded ? " is-expanded" : ""}${entry.ok ? "" : " is-error"}`}>
      <button
        aria-controls={detailId}
        aria-expanded={expanded}
        className="mcp-panel__activity-toggle"
        onClick={onToggle}
        type="button"
      >
        <span className={entry.ok ? "mcp-panel__ok" : "mcp-panel__fail"}>
          {entry.ok ? "OK" : "ERR"}
        </span>
        <span className="mcp-panel__activity-main">
          <strong>{entry.tool}</strong>
          <code className={expanded ? undefined : "is-truncated"}>{entry.summary}</code>
        </span>
        <time dateTime={entry.createdAt}>{formatActivityTime(entry.createdAt)}</time>
        {expanded
          ? <ChevronDown size={14} aria-hidden="true" />
          : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      <div className="mcp-panel__activity-detail" hidden={!expanded} id={detailId}>
        {connectionName ? <p>连接 · {connectionName}</p> : null}
        <code>{entry.summary}</code>
        {entry.detail ? <pre>{entry.detail}</pre> : <small>无额外详情</small>}
      </div>
    </li>
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
