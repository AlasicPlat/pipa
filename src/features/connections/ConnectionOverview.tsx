import { ArrowUpRight, Command as CommandIcon, Database, FileClock, Keyboard, Plus, Server, Sparkles } from "lucide-react";

import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { ShortcutActionId } from "../commands/shortcutRegistry";

export interface WorkspaceRecoveryNoticeProps {
  /** Message explaining why the persisted workspace could not be restored. */
  error: string | null;
  /** Whether a retry is currently running, which disables the button. */
  retrying: boolean;
  /** Starts another recovery attempt. */
  onRetry: () => void;
}

/**
 * Explains that the persisted workspace failed to load and offers a retry.
 *
 * This is an alert rather than an empty state: the tabs still exist on disk, so silently showing
 * the get-started screen would suggest the user's work was lost.
 * @param props - Failure message and retry handling.
 * @returns The recovery notice element.
 */
export function WorkspaceRecoveryNotice({
  error,
  retrying,
  onRetry,
}: WorkspaceRecoveryNoticeProps): React.JSX.Element {
  return (
    <section
      className="connection-overview"
      aria-labelledby="workspace-recovery-title"
      role="alert"
    >
      <span className="connection-overview__glow" aria-hidden="true" />
      <span className="connection-overview__icon" aria-hidden="true">
        <Database size={24} strokeWidth={1.6} />
      </span>
      <span className="eyebrow">RECOVERY REQUIRED</span>
      <h2 id="workspace-recovery-title">无法恢复上次工作区</h2>
      <p>{error}</p>
      <div className="connection-overview__actions">
        <button
          className="button button--primary"
          disabled={retrying}
          onClick={onRetry}
          type="button"
        >
          {retrying ? "正在恢复…" : "重新恢复"}
        </button>
      </div>
    </section>
  );
}

export interface ConnectionOverviewProps {
  /**
   * Whether a persisted query tab is active whose connection is gone. Takes priority over
   * `selectedProfile`, because the tab must keep its original connection identity rather than
   * rebinding to whatever the sidebar has in focus.
   */
  orphanedQueryWorkspace: boolean;
  /** Connection the new-query action would target, when one qualifies. */
  newQueryProfile: ConnectionProfile | null;
  /** Connection the navigator has in focus, when any. */
  selectedProfile: ConnectionProfile | null;
  /** Formats one action's current key binding for the inline hints. */
  shortcutLabel: (actionId: ShortcutActionId) => string;
  /** Starts the add-connection flow. */
  onAddConnection: () => void;
  /** Creates a query or Redis workspace on `newQueryProfile`. */
  onCreateQuery: () => void;
  /** Opens the binlog analysis workspace. */
  onOpenBinlog: () => void;
  /** Opens the command palette. */
  onOpenCommandPalette: () => void;
  /** Opens the MCP console. */
  onOpenMcp: () => void;
  /** Opens the shortcut help dialog. */
  onOpenShortcutHelp: () => void;
}

/**
 * Renders the workspace placeholder shown whenever no usable workspace is open.
 *
 * Three states share one layout: a persisted query tab whose connection disappeared, a selected
 * connection waiting for its first workspace, and the first-run screen.
 * @param props - Current connection context and the actions the placeholder offers.
 * @returns The overview element for the current state.
 */
export function ConnectionOverview(props: ConnectionOverviewProps): React.JSX.Element {
  const {
    onAddConnection,
    onOpenCommandPalette,
    orphanedQueryWorkspace,
    selectedProfile,
    shortcutLabel,
  } = props;
  if (orphanedQueryWorkspace) {
    return (
      <section className="connection-overview" aria-labelledby="connection-overview-title">
        <span className="connection-overview__glow" aria-hidden="true" />
        <span className="connection-overview__icon" aria-hidden="true">
          <Database size={24} strokeWidth={1.6} />
        </span>
        <span className="eyebrow">CONNECTION UNAVAILABLE</span>
        <h2 id="connection-overview-title">无法恢复查询连接</h2>
        <p>此标签仍保留原连接标识，不会改绑到当前侧栏连接。</p>
        <div className="connection-overview__hints">
          <button onClick={onAddConnection} type="button">
            <Plus size={13} aria-hidden="true" />
            添加可用连接
          </button>
          <button onClick={onOpenCommandPalette} type="button">
            <CommandIcon size={13} aria-hidden="true" />
            命令面板
            <kbd>{shortcutLabel("commandPalette")}</kbd>
          </button>
        </div>
      </section>
    );
  }
  return selectedProfile
    ? <SelectedConnectionOverview {...props} selectedProfile={selectedProfile} />
    : <GetStartedOverview {...props} />;
}

/** Overview for a focused connection that has no workspace open yet. */
function SelectedConnectionOverview({
  newQueryProfile,
  onAddConnection,
  onCreateQuery,
  onOpenCommandPalette,
  selectedProfile,
  shortcutLabel,
}: ConnectionOverviewProps & { selectedProfile: ConnectionProfile }): React.JSX.Element {
  const isRedis = selectedProfile.engine === "redis";
  return (
    <section className="connection-overview" aria-labelledby="connection-overview-title">
      <span className="connection-overview__glow" aria-hidden="true" />
      <span className="connection-overview__icon" aria-hidden="true">
        <Database size={24} strokeWidth={1.6} />
      </span>
      <span className="eyebrow">CONNECTION SELECTED</span>
      <h2 id="connection-overview-title">{selectedProfile.name}</h2>
      <p>
        {isRedis
          ? "已选中 Redis 连接。创建命令工作区，或在侧栏展开浏览键。"
          : selectedProfile.engine === "my_sql"
            ? "已选中 MySQL 连接。创建查询工作区，或展开侧栏打开数据表。"
            : "此引擎界面位置已预留，当前请改用 MySQL 或 Redis 连接继续。"}
      </p>
      {newQueryProfile ? (
        <div className="connection-overview__actions">
          <button className="button button--primary" onClick={onCreateQuery} type="button">
            <Plus size={16} aria-hidden="true" />
            {newQueryProfile.engine === "redis" ? "新建 Redis 工作区" : "新建 SQL 查询"}
          </button>
          <button className="button button--secondary" onClick={onOpenCommandPalette} type="button">
            <CommandIcon size={14} aria-hidden="true" />
            命令面板
            <kbd>{shortcutLabel("commandPalette")}</kbd>
          </button>
        </div>
      ) : (
        <div className="connection-overview__actions">
          <button className="button button--primary" onClick={onAddConnection} type="button">
            <Plus size={16} aria-hidden="true" />
            添加连接
          </button>
        </div>
      )}
      {newQueryProfile ? (
        <ol className="connection-overview__guide">
          <li>
            <span className="connection-overview__guide-index" aria-hidden="true">1</span>
            <span>
              <strong>在侧栏展开连接</strong>
              <span>
                {isRedis
                  ? "浏览逻辑库与键，点击键即可打开检查工作区。"
                  : "展开后加载数据表，点击即可进入表工作区。"}
              </span>
            </span>
            <kbd>{shortcutLabel("toggleSidebar")}</kbd>
          </li>
          <li>
            <span className="connection-overview__guide-index" aria-hidden="true">2</span>
            <span>
              <strong>{isRedis ? "执行 Redis 命令" : "编写并执行 SQL"}</strong>
              <span>在工作区编辑器中运行语句，结果会流式展示在下方。</span>
            </span>
            <kbd>{shortcutLabel("executeQuery")}</kbd>
          </li>
        </ol>
      ) : null}
    </section>
  );
}

/** First-run overview shown before any connection is selected. */
function GetStartedOverview({
  onAddConnection,
  onOpenBinlog,
  onOpenCommandPalette,
  onOpenMcp,
  onOpenShortcutHelp,
  shortcutLabel,
}: ConnectionOverviewProps): React.JSX.Element {
  return (
    <section className="connection-overview" aria-labelledby="connection-overview-title">
      <span className="connection-overview__glow" aria-hidden="true" />
      <span className="connection-overview__icon" aria-hidden="true">
        <Sparkles size={24} strokeWidth={1.6} />
      </span>
      <span className="eyebrow">GET STARTED</span>
      <h2 id="connection-overview-title">选择或创建一个数据库连接</h2>
      <p>连接按引擎整理，凭据仅保存在本机。当前支持 MySQL 与 Redis。</p>
      <div className="connection-overview__actions">
        <button className="button button--primary" onClick={onAddConnection} type="button">
          <Plus size={16} aria-hidden="true" />
          添加连接
        </button>
        <button className="button button--secondary" onClick={onOpenCommandPalette} type="button">
          <CommandIcon size={14} aria-hidden="true" />
          命令面板
          <kbd>{shortcutLabel("commandPalette")}</kbd>
        </button>
      </div>
      <ol className="connection-overview__guide">
        <li>
          <span className="connection-overview__guide-index" aria-hidden="true">1</span>
          <span>
            <strong>添加本机连接</strong>
            <span>选择 MySQL 或 Redis，测试通过后保存到本地加密存储。</span>
          </span>
        </li>
        <li>
          <span className="connection-overview__guide-index" aria-hidden="true">2</span>
          <span>
            <strong>打开工作区</strong>
            <span>新建查询、浏览数据表 / 键，或导入 Binlog 做离线分析。</span>
          </span>
        </li>
        <li>
          <span className="connection-overview__guide-index" aria-hidden="true">3</span>
          <span>
            <strong>用命令面板加速</strong>
            <span>搜索连接、表、工作区与常用操作，无需离开键盘。</span>
          </span>
          <kbd>{shortcutLabel("commandPalette")}</kbd>
        </li>
      </ol>
      <div className="connection-overview__tools" aria-label="探索工作台">
        <button onClick={onOpenBinlog} type="button">
          <FileClock size={18} aria-hidden="true" />
          <strong>Binlog 分析</strong>
          <small>离线查看事务与变更</small>
          <ArrowUpRight className="connection-overview__tool-arrow" size={14} aria-hidden="true" />
        </button>
        <button onClick={onOpenMcp} type="button">
          <Server size={18} aria-hidden="true" />
          <strong>MCP 控制台</strong>
          <small>管理 AI 访问与 SQL 审批</small>
          <ArrowUpRight className="connection-overview__tool-arrow" size={14} aria-hidden="true" />
        </button>
        <button onClick={onOpenShortcutHelp} type="button">
          <Keyboard size={18} aria-hidden="true" />
          <strong>快捷键</strong>
          <small>熟悉操作，保持专注</small>
          <ArrowUpRight className="connection-overview__tool-arrow" size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
