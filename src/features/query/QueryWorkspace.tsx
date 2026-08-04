import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AlertTriangle, Bookmark, Copy, Download, Play, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AppError } from "../../bindings/AppError";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { getShortcutKeyLabels, matchesShortcut, useShortcutSettings } from "../commands/shortcutRegistry";
import type { ResolvedTheme } from "../preferences/theme";
import { SqlLibraryDialog } from "../sql-library/SqlLibraryDialog";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { ResultGrid } from "./ResultGrid";
import {
  downloadTextFile,
  resolveExportTableName,
  serializeResultAsCsv,
  serializeResultAsTsv,
  serializeRowsAsInsert,
  serializeSelectionAsJson,
  serializeSelectionAsMarkdown,
} from "./resultExport";
import { useQuerySession } from "./useQuerySession";
import type { WorkspaceTab } from "./useWorkspacePersistence";

interface QueryWorkspaceProps {
  active?: boolean;
  profile: ConnectionProfile;
  tab: WorkspaceTab;
  theme: ResolvedTheme;
  persistenceError: string | null;
  onRetryPersistence: () => Promise<void>;
  onRunningChange: (tabId: string, running: boolean) => void;
  onSqlChange: (tabId: string, sqlText: string) => void;
}

const REDIS_COMMAND_PRESETS = [
  { label: "浏览键", command: 'SCAN 0 MATCH "*" COUNT 200' },
  { label: "String", command: "GET key" },
  { label: "Hash", command: "HGETALL key" },
  { label: "List", command: "LRANGE key 0 -1" },
  { label: "Set", command: "SMEMBERS key" },
  { label: "ZSet", command: "ZRANGE key 0 -1 WITHSCORES" },
  { label: "Stream", command: "XRANGE key - + COUNT 100" },
  { label: "诊断", command: "INFO" },
] as const;

const REDIS_READ_ONLY_COMMANDS = new Set([
  "BITCOUNT",
  "BITFIELD_RO",
  "BITPOS",
  "COMMAND",
  "DBSIZE",
  "DUMP",
  "ECHO",
  "EXISTS",
  "EXPIRETIME",
  "GEODIST",
  "GEOHASH",
  "GEOPOS",
  "GEOSEARCH",
  "GET",
  "GETBIT",
  "GETRANGE",
  "HEXISTS",
  "HGET",
  "HGETALL",
  "HKEYS",
  "HLEN",
  "HMGET",
  "HRANDFIELD",
  "HSCAN",
  "HSTRLEN",
  "HVALS",
  "INFO",
  "KEYS",
  "LCS",
  "LINDEX",
  "LLEN",
  "LOLWUT",
  "LPOS",
  "LRANGE",
  "MGET",
  "OBJECT",
  "PEXPIRETIME",
  "PFCOUNT",
  "PING",
  "PTTL",
  "PUBSUB",
  "RANDOMKEY",
  "SCAN",
  "SCARD",
  "SDIFF",
  "SINTER",
  "SINTERCARD",
  "SISMEMBER",
  "SMEMBERS",
  "SMISMEMBER",
  "SORT_RO",
  "SRANDMEMBER",
  "SSCAN",
  "STRLEN",
  "SUNION",
  "TIME",
  "TTL",
  "TYPE",
  "XINFO",
  "XLEN",
  "XPENDING",
  "XRANGE",
  "XREAD",
  "XREVRANGE",
  "ZCARD",
  "ZCOUNT",
  "ZDIFF",
  "ZINTER",
  "ZINTERCARD",
  "ZLEXCOUNT",
  "ZMSCORE",
  "ZRANDMEMBER",
  "ZRANGE",
  "ZRANGEBYLEX",
  "ZRANGEBYSCORE",
  "ZRANK",
  "ZREVRANGE",
  "ZREVRANGEBYLEX",
  "ZREVRANGEBYSCORE",
  "ZREVRANK",
  "ZSCAN",
  "ZSCORE",
  "ZUNION",
]);

/**
 * Treats unknown or state-changing Redis commands as writes for production confirmation.
 * @param command - Exact command selected in the Redis editor.
 * @returns `true` when the command must be explicitly confirmed before execution.
 * Side effects: none.
 */
function redisCommandNeedsProductionConfirmation(command: string): boolean {
  const [commandName = "", subcommand = ""] = command
    .trim()
    .split(/\s+/u, 2)
    .map((token) => token.toUpperCase());
  if (commandName === "MEMORY") {
    return !["DOCTOR", "MALLOC-STATS", "STATS", "USAGE"].includes(subcommand);
  }
  if (commandName === "SCRIPT") {
    return subcommand !== "EXISTS";
  }
  if (commandName === "CONFIG") {
    return subcommand !== "GET";
  }
  return !REDIS_READ_ONLY_COMMANDS.has(commandName);
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
function queryErrorAdvice(error: AppError, isRedis: boolean): string {
  switch (error.code) {
    case "validation":
      return `请检查${isRedis ? "命令" : "查询"}内容和当前连接后再执行。`;
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
      return isRedis
        ? "请检查 Redis 命令、参数和键的数据类型。"
        : "请检查 SQL 语法、对象名称和当前数据库。";
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
 * Composes one connection-bound native editor, run controls, and streamed results.
 * @param props - Active persisted tab, its fixed non-secret profile, and tab actions.
 * @returns The usable query workspace for that fixed connection.
 * Side effects: reports controlled SQL edits and invokes query-session commands after user actions.
 */
export function QueryWorkspace({
  active = true,
  profile,
  tab,
  theme,
  persistenceError,
  onRetryPersistence,
  onRunningChange,
  onSqlChange,
}: QueryWorkspaceProps) {
  const shortcuts = useShortcutSettings();
  const isRedis = profile.engine === "redis";
  const session = useQuerySession(profile.id, {
    database: isRedis ? profile.database : null,
  });
  const queryEditorRef = useRef<QueryEditorHandle>(null);
  const resultSearchInputRef = useRef<HTMLInputElement>(null);
  const [resultActionFeedback, setResultActionFeedback] = useState<string | null>(null);
  const [selectionStatus, setSelectionStatus] = useState<string | null>(null);
  const [resultSearch, setResultSearch] = useState("");
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [sqlLibraryOpen, setSqlLibraryOpen] = useState(false);
  const [pendingProductionRedisCommand, setPendingProductionRedisCommand] = useState<string | null>(null);
  const hasResultRows = session.state.columns.length > 0 && session.state.rows.length > 0;
  const exportBaseName = tab.title.replace(/[^\w\u4e00-\u9fff.-]+/gu, "_").slice(0, 48) || "query";
  const inferredTableName = resolveExportTableName(tab.sqlText, profile.database);

  /**
   * Executes editor-selected SQL while the current workspace is idle.
   * @param sqlToRun - Selection-first SQL returned by the editor.
   * @returns Nothing (`void`).
   * Side effects: starts the asynchronous query session.
   */
  function handleExecute(sqlToRun: string): void {
    if (session.state.running) {
      return;
    }
    if (
      isRedis
      && profile.environment === "production"
      && redisCommandNeedsProductionConfirmation(sqlToRun)
    ) {
      setPendingProductionRedisCommand(sqlToRun);
      return;
    }
    void session.run(sqlToRun);
  }

  /**
   * Executes the exact production Redis command after the user reviews it.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: closes the confirmation layer and starts the query session.
   */
  function confirmProductionRedisCommand(): void {
    const command = pendingProductionRedisCommand;
    setPendingProductionRedisCommand(null);
    if (command && !session.state.running) {
      void session.run(command);
    }
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
   * Replaces the Redis editor with one explicit native-command template.
   * @param command - Safe non-secret command template selected by the user.
   * @returns Nothing (`void`).
   * Side effects: updates the persisted editor contents for the active tab.
   */
  function handleRedisPreset(command: string): void {
    onSqlChange(tab.id, command);
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

  useEffect(() => {
    /** Cancels only this mounted, active query before the WebView consumes the primary shortcut. */
    function handleCancelShortcut(event: KeyboardEvent): void {
      if (document.querySelector("[aria-modal='true']")) {
        return;
      }
      const isCancelShortcut = matchesShortcut(event, shortcuts.bindings.cancelQuery);
      if (!isCancelShortcut || !session.state.running) {
        return;
      }
      event.preventDefault();
      void session.cancel();
    }

    document.addEventListener("keydown", handleCancelShortcut, true);
    return () => document.removeEventListener("keydown", handleCancelShortcut, true);
  }, [session.cancel, session.state.running, shortcuts.bindings.cancelQuery]);

  useEffect(() => {
    onRunningChange(tab.id, session.state.running);
    return () => onRunningChange(tab.id, false);
  }, [onRunningChange, session.state.running, tab.id]);

  /** Retries the latest failed encrypted workspace snapshot without touching editor state. */
  function handleRetryPersistence(): void {
    void onRetryPersistence();
  }

  /**
   * Writes clipboard text and surfaces short result-area feedback.
   * @param text - Serialized clipboard payload.
   * @param feedback - Transient status shown above the result grid.
   * @returns Nothing (`void`).
   * Side effects: writes clipboard text through the Tauri clipboard plugin.
   */
  function handleCopyText(text: string, feedback: string): void {
    if (!text) {
      setResultActionFeedback(feedback || "复制失败");
      return;
    }
    void writeText(text)
      .then(() => {
        setResultActionFeedback(feedback);
      })
      .catch((error: unknown) => {
        console.error(
          "Pipa failed to copy query results",
          error instanceof Error ? error.message : "unknown clipboard error",
        );
        setResultActionFeedback("复制失败");
      });
  }

  /**
   * Copies every loaded result row to the system clipboard as TSV with headers.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: writes clipboard text through the Tauri clipboard plugin.
   */
  function handleCopyAllResults(): void {
    if (!hasResultRows) {
      return;
    }
    handleCopyText(
      serializeResultAsTsv(session.state.columns, session.state.rows),
      `已复制 ${session.state.rows.length} 行`,
    );
  }

  /**
   * Runs one export through the native save dialog and reports the outcome.
   * @param buildContent - Builds the file body for the current result set.
   * @param fileName - Suggested save file name.
   * @param mimeType - MIME type used by the browser fallback path.
   * @param successFeedback - Status text shown after a successful save.
   * @returns Nothing (`void`).
   * Side effects: closes the export menu and may write a local file.
   */
  function runResultExport(
    buildContent: () => string,
    fileName: string,
    mimeType: string,
    successFeedback: string,
  ): void {
    if (!hasResultRows) {
      return;
    }
    setExportMenuOpen(false);
    const content = buildContent();
    if (!content) {
      setResultActionFeedback("导出失败：没有可导出的内容");
      return;
    }
    void downloadTextFile(content, fileName, mimeType).then((result) => {
      if (result === "saved") {
        setResultActionFeedback(successFeedback);
        return;
      }
      if (result === "cancelled") {
        setResultActionFeedback("已取消导出");
        return;
      }
      setResultActionFeedback("导出失败");
    });
  }

  /**
   * Downloads every loaded result row as a CSV file.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: opens a native save dialog and writes a CSV document.
   */
  function handleExportCsv(): void {
    runResultExport(
      () => serializeResultAsCsv(session.state.columns, session.state.rows),
      `${exportBaseName}-results.csv`,
      "text/csv;charset=utf-8",
      `已导出 CSV · ${session.state.rows.length} 行`,
    );
  }

  /**
   * Downloads every loaded result row as pretty-printed JSON.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: opens a native save dialog and writes a JSON document.
   */
  function handleExportJson(): void {
    const selection = {
      startRow: 0,
      startCol: 0,
      endRow: session.state.rows.length - 1,
      endCol: session.state.columns.length - 1,
    };
    runResultExport(
      () => serializeSelectionAsJson(session.state.columns, session.state.rows, selection),
      `${exportBaseName}-results.json`,
      "application/json;charset=utf-8",
      `已导出 JSON · ${session.state.rows.length} 行`,
    );
  }

  /**
   * Downloads every loaded result row as a Markdown table.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: opens a native save dialog and writes a Markdown document.
   */
  function handleExportMarkdown(): void {
    const selection = {
      startRow: 0,
      startCol: 0,
      endRow: session.state.rows.length - 1,
      endCol: session.state.columns.length - 1,
    };
    runResultExport(
      () => serializeSelectionAsMarkdown(session.state.columns, session.state.rows, selection),
      `${exportBaseName}-results.md`,
      "text/markdown;charset=utf-8",
      `已导出 Markdown · ${session.state.rows.length} 行`,
    );
  }

  /**
   * Downloads every loaded result row as a standard SQL INSERT statement.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: opens a native save dialog and writes a `.sql` document.
   */
  function handleExportSql(): void {
    runResultExport(
      () =>
        serializeRowsAsInsert(session.state.columns, session.state.rows, {
          tableName: inferredTableName,
          includePrimaryKey: true,
        }),
      `${exportBaseName}-results.sql`,
      "application/sql;charset=utf-8",
      `已导出 SQL INSERT · ${session.state.rows.length} 行`,
    );
  }

  useEffect(() => {
    setResultSearch("");
    setExportMenuOpen(false);
  }, [session.state.columns, tab.id]);

  useEffect(() => {
    if (!resultActionFeedback) {
      return;
    }
    const timer = window.setTimeout(() => setResultActionFeedback(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [resultActionFeedback]);

  useEffect(() => {
    if (!exportMenuOpen) {
      return;
    }
    /** Closes the export menu when clicking outside it. */
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".query-export-menu")) {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [exportMenuOpen]);

  /**
   * Focuses the result search box when Mod+F is used inside the results region.
   * @param event - Keyboard event from the results section.
   * @returns Nothing (`void`).
   * Side effects: focuses and selects the result search input.
   */
  function handleResultsKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (!matchesShortcut(event, shortcuts.bindings.find) || !hasResultRows) {
      return;
    }
    event.preventDefault();
    resultSearchInputRef.current?.focus();
    resultSearchInputRef.current?.select();
  }
  return (
    <section
      className={`query-workspace${isRedis ? " query-workspace--redis" : ""}`}
      aria-label={`${profile.name} 查询工作区`}
    >
      <header className="query-context">
        <span className="query-context__engine">{isRedis ? "Redis" : "MySQL"}</span>
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

      <div className={`query-editor-panel${isRedis ? " query-editor-panel--redis" : ""}`}>
        <div className="query-toolbar">
          <span className="query-toolbar__title">{tab.title}</span>
          <span className="query-toolbar__actions">
            <button
              className="query-library-button"
              onClick={() => setSqlLibraryOpen(true)}
              type="button"
            >
              <Bookmark size={13} aria-hidden="true" />
              常用 SQL
            </button>
            <button
              className="query-run-button"
              disabled={session.state.running}
              onClick={handleToolbarExecute}
              title={`执行选中${isRedis ? "命令" : " SQL 或当前语句"}（${getShortcutKeyLabels(shortcuts.bindings.executeQuery).join(" + ")}）`}
              type="button"
            >
              <Play size={13} fill="currentColor" aria-hidden="true" />
              执行
              <kbd>{getShortcutKeyLabels(shortcuts.bindings.executeQuery).join(" + ")}</kbd>
            </button>
          </span>
        </div>
        {isRedis ? (
          <div className="redis-command-presets" aria-label="Redis 常用命令">
            {REDIS_COMMAND_PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => handleRedisPreset(preset.command)}
                title={preset.command}
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
        ) : null}
        <QueryEditor
          active={active}
          engine={isRedis ? "redis" : "my_sql"}
          ref={queryEditorRef}
          sql={tab.sqlText}
          onSqlChange={(sqlText) => onSqlChange(tab.id, sqlText)}
          onExecute={handleExecute}
          theme={theme}
        />
      </div>

      <section className="query-results" aria-label="结果区域" onKeyDown={handleResultsKeyDown}>
        <header className="query-results__header">
          <span>
            结果
            {session.state.rows.length > 0 ? ` · ${session.state.rows.length} 行` : ""}
            {selectionStatus ? ` · ${selectionStatus}` : ""}
            {session.state.incomplete ? " · 不完整" : ""}
          </span>
          <span className="query-results__actions">
            {resultActionFeedback ? (
              <span className="query-results__feedback" role="status">{resultActionFeedback}</span>
            ) : null}
            {hasResultRows ? (
              <>
                <label className="query-result-search">
                  <Search size={12} aria-hidden="true" />
                  <input
                    aria-label="搜索结果"
                    onChange={(event) => setResultSearch(event.target.value)}
                    placeholder="搜索结果"
                    ref={resultSearchInputRef}
                    title={`搜索当前结果（${getShortcutKeyLabels(shortcuts.bindings.find).join(" + ")}）`}
                    type="search"
                    value={resultSearch}
                  />
                </label>
                <button
                  onClick={handleCopyAllResults}
                  title="复制全部结果（含表头，TSV）"
                  type="button"
                >
                  <Copy size={12} aria-hidden="true" />
                  复制全部
                </button>
                <div className="query-export-menu">
                  <button
                    aria-expanded={exportMenuOpen}
                    aria-haspopup="menu"
                    onClick={() => setExportMenuOpen((open) => !open)}
                    title="导出全部结果"
                    type="button"
                  >
                    <Download size={12} aria-hidden="true" />
                    导出
                  </button>
                  {exportMenuOpen ? (
                    <div aria-label="导出格式" className="query-export-menu__panel" role="menu">
                      <button onClick={handleExportCsv} role="menuitem" type="button">
                        导出 CSV
                      </button>
                      <button onClick={handleExportJson} role="menuitem" type="button">
                        导出 JSON
                      </button>
                      <button onClick={handleExportMarkdown} role="menuitem" type="button">
                        导出 Markdown
                      </button>
                      {!isRedis ? (
                        <button onClick={handleExportSql} role="menuitem" type="button">
                          导出 SQL INSERT
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
            {session.state.running ? (
              <span className="query-loading" role="status">
                <span className="loading-spinner" aria-hidden="true" />
                {isRedis ? "命令执行中…" : "查询中…"}
                <button
                  disabled={session.state.cancelRequested}
                  onClick={handleCancel}
                  title={`取消当前${isRedis ? "命令" : "查询"}（${getShortcutKeyLabels(shortcuts.bindings.cancelQuery).join(" + ")}）`}
                  type="button"
                >
                  <X size={12} aria-hidden="true" />
                  取消
                  <kbd>{getShortcutKeyLabels(shortcuts.bindings.cancelQuery).join(" + ")}</kbd>
                </button>
              </span>
            ) : null}
          </span>
        </header>

        {session.state.error && !session.state.running ? (
          <div className="query-error" role="alert">
            <strong>{isRedis ? "命令失败" : "查询失败"}</strong>
            <span className="query-error__summary">{session.state.error.message}</span>
            <span className="query-error__advice">{queryErrorAdvice(session.state.error, isRedis)}</span>
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
            searchQuery={resultSearch}
            tableName={inferredTableName}
            onCopyAll={handleCopyAllResults}
            onCopyText={handleCopyText}
            onSelectionChange={setSelectionStatus}
          />
        ) : null}

        {!session.state.running &&
        !session.state.error &&
        session.state.columns.length === 0 &&
        session.state.affectedRows === null ? (
          <div className="query-results__empty">
            {session.state.incomplete
              ? `${isRedis ? "命令" : "查询"}已取消`
              : `执行${isRedis ? "命令" : "查询"}后，结果会显示在这里。`}
          </div>
        ) : null}

        {!session.state.running &&
        !session.state.error &&
        session.state.columns.length === 0 &&
        session.state.affectedRows !== null ? (
          <div className="query-results__empty">执行完成</div>
        ) : null}
      </section>

      {sqlLibraryOpen ? (
        <SqlLibraryDialog
          currentSql={tab.sqlText}
          engine={profile.engine}
          onApply={(sqlText) => onSqlChange(tab.id, sqlText)}
          onClose={() => setSqlLibraryOpen(false)}
        />
      ) : null}

      {pendingProductionRedisCommand ? (
        <div className="redis-dialog-backdrop">
          <section
            aria-labelledby="redis-cli-confirm-title"
            aria-modal="true"
            className="redis-dialog redis-dialog--confirm"
            role="alertdialog"
          >
            <header>
              <span>
                <small>PRODUCTION COMMAND</small>
                <h2 id="redis-cli-confirm-title">确认执行 Redis 命令</h2>
              </span>
              <AlertTriangle size={18} aria-hidden="true" />
            </header>
            <div className="redis-dialog__body">
              <p>该命令可能修改生产 Redis 数据，请核对后再执行。</p>
              <pre>{pendingProductionRedisCommand}</pre>
            </div>
            <footer>
              <button
                autoFocus
                onClick={() => setPendingProductionRedisCommand(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="button--danger"
                onClick={confirmProductionRedisCommand}
                type="button"
              >
                确认执行
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
