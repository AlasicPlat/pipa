import { Channel } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  Database,
  FileClock,
  FileCode2,
  LoaderCircle,
  RefreshCw,
  Table2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CellValue } from "../../bindings/CellValue";
import {
  cancelBinlogImport,
  closeBinlogAnalysis,
  getBinlogResetSql,
  getBinlogTransaction,
  getBinlogSummary,
  listBinlogTransactions,
  startBinlogImport,
} from "../../lib/tauriClient";
import type {
  BinlogCellValue,
  BinlogImportError,
  BinlogImportEvent,
  BinlogImportProgress,
  BinlogOperation,
  BinlogRowImage,
  BinlogSummary,
  BinlogTableChange,
  BinlogTransaction,
  BinlogTransactionFilter,
  BinlogTransactionSummary,
} from "./types";
import "./binlog.css";

const PAGE_SIZE = 50;
const EMPTY_PROGRESS: BinlogImportProgress = {
  bytesRead: 0,
  totalBytes: 0,
  filesCompleted: 0,
  fileCount: 0,
  currentFile: null,
  transactionCount: 0,
  eventCount: 0,
};

type ImportPhase = "empty" | "importing" | "loading" | "ready" | "error" | "canceled";

interface TimelineFilter {
  database: string;
  table: string;
  operation: "" | BinlogOperation;
}

interface TransactionCardProps {
  transaction: BinlogTransactionSummary;
  detail: BinlogTransaction | null;
  detailError: string | null;
  detailLoading: boolean;
  expanded: boolean;
  resetFeedback: ResetSqlFeedback | null;
  resetLoading: boolean;
  onCopyResetSql: (transaction: BinlogTransactionSummary) => void;
  onToggle: (transaction: BinlogTransactionSummary) => void;
}

interface ResetSqlFeedback {
  message: string;
  tone: "success" | "warning" | "error";
  details: string | null;
}

/** Returns only a source file's final path segment for compact, privacy-safe display. */
function fileBaseName(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Formats a non-negative count consistently without sacrificing integer precision from the API. */
function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

/** Formats an RFC3339 timestamp in the user's desktop locale, preserving invalid source text. */
function formatTimestamp(value: string | null): string {
  if (!value) {
    return "日志未提供";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN");
}

/** Formats exact Unix seconds for display while retaining invalid input verbatim. */
function formatUnixTimestamp(value: string): string {
  const seconds = Number(value);
  const parsed = new Date(seconds * 1000);
  return Number.isFinite(seconds) && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleString("zh-CN")
    : value;
}

/** Formats parser byte progress into a compact binary unit. */
function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 ** 2) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 ** 3) {
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

/** Maps a backend operation identifier to concise Chinese UI text. */
function operationLabel(operation: BinlogOperation): string {
  switch (operation) {
    case "insert":
      return "INSERT";
    case "update":
      return "UPDATE";
    case "delete":
      return "DELETE";
    case "ddl":
      return "DDL";
  }
}

/** Maps an inferred transaction state to user-facing text without overstating certainty. */
function transactionStatusLabel(status: BinlogTransaction["status"]): string {
  switch (status) {
    case "committed":
      return "已提交";
    case "rolled_back":
      return "观察到 ROLLBACK";
    case "incomplete":
      return "不完整";
    case "unknown":
      return "状态未知";
  }
}

/** Maps the aggregate parser result to a short diagnostic label. */
function analysisStatusLabel(status: BinlogSummary["status"]): string {
  switch (status) {
    case "complete":
      return "完整";
    case "warning":
      return "有警告";
    case "error":
      return "有错误";
    case "partial":
      return "部分可用";
  }
}

/** Converts an unknown native rejection into a safe, retryable import error. */
function normalizeImportError(error: unknown, fallback: string): BinlogImportError {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return {
      code: "internal",
      message: error.message,
      technicalDetails:
        "technicalDetails" in error && typeof error.technicalDetails === "string"
          ? error.technicalDetails
          : null,
      retryable: "retryable" in error && typeof error.retryable === "boolean"
        ? error.retryable
        : true,
    };
  }
  return { code: "internal", message: fallback, technicalDetails: null, retryable: true };
}

/** Renders a recorded database value while keeping SQL NULL visually explicit. */
function renderStoredCellValue(cell: CellValue): ReactNode {
  switch (cell.kind) {
    case "null":
      return <span className="binlog-value binlog-value--null">NULL</span>;
    case "boolean":
      return cell.value ? "true" : "false";
    case "integer":
    case "decimal":
    case "text":
    case "date_time":
      return cell.value;
    case "float":
      return String(cell.value);
    case "json":
      return JSON.stringify(cell.value);
    case "binary":
      return <span className="binlog-value binlog-value--binary">二进制数据</span>;
    default:
      return <span className="binlog-value binlog-value--unknown">未知值</span>;
  }
}

/** Renders one binlog cell state, distinctly preserving omitted and undecodable values. */
function renderBinlogCellValue(cell: BinlogCellValue | undefined): ReactNode {
  if (!cell) {
    return <span className="binlog-value binlog-value--not-logged">未记录</span>;
  }
  switch (cell.kind) {
    case "not_logged":
      return <span className="binlog-value binlog-value--not-logged">未记录</span>;
    case "null":
      return <span className="binlog-value binlog-value--null">NULL</span>;
    case "value":
      return renderStoredCellValue(cell.value);
    case "unix_timestamp":
      return <span title={`${cell.value} Unix 秒`}>{formatUnixTimestamp(cell.value)}</span>;
    case "decode_error":
      return (
        <span className="binlog-value binlog-value--error" title={cell.message}>
          解码失败
        </span>
      );
    case "partial":
      return (
        <span className="binlog-value binlog-value--partial" title={cell.message ?? undefined}>
          {renderStoredCellValue(cell.value)} · 部分值
        </span>
      );
    default:
      return <span className="binlog-value binlog-value--unknown">未知值状态</span>;
  }
}

/** Produces stable ordered column names across a row's before and after images. */
function rowColumns(before: BinlogRowImage | null, after: BinlogRowImage | null): string[] {
  return Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]));
}

/** Builds a DOM-safe disclosure identifier without relying on backend identifier syntax. */
function transactionDetailsId(transactionId: string): string {
  return `binlog-transaction-${transactionId.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
}

/** Renders one table operation and every before/after row image returned for it. */
function TableChangeDetails({ change }: { change: BinlogTableChange }) {
  return (
    <section className="binlog-change" aria-label={`${change.database}.${change.table} 变更`}>
      <div className="binlog-change__heading">
        <span className={`binlog-operation binlog-operation--${change.operation}`}>
          {operationLabel(change.operation)}
        </span>
        <strong>
          {change.database}.{change.table}
        </strong>
        <span>{formatCount(change.rowCount)} 行</span>
      </div>
      {change.sql ? <pre className="binlog-change__sql">{change.sql}</pre> : null}
      {change.rows.length === 0 ? (
        <p className="binlog-change__empty">该操作未包含可展示的行镜像。</p>
      ) : (
        change.rows.map((row, rowIndex) => {
          const columns = rowColumns(row.before, row.after);
          return (
            <div className="binlog-diff" key={`${change.database}.${change.table}-${rowIndex}`}>
              <div className="binlog-diff__label">行 {rowIndex + 1}</div>
              <div className="binlog-diff__scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">列</th>
                      <th scope="col">Before</th>
                      <th scope="col">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((column) => (
                      <tr key={column}>
                        <th scope="row">{column}</th>
                        <td>{renderBinlogCellValue(row.before?.[column])}</td>
                        <td>{renderBinlogCellValue(row.after?.[column])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

/** Renders one keyboard-accessible transaction disclosure in source-file order. */
function TransactionCard({
  transaction,
  detail,
  detailError,
  detailLoading,
  expanded,
  resetFeedback,
  resetLoading,
  onCopyResetSql,
  onToggle,
}: TransactionCardProps) {
  const detailsId = transactionDetailsId(transaction.id);
  const identity = transaction.gtid
    ? `GTID ${transaction.gtid}`
    : transaction.xid
      ? `XID ${transaction.xid}`
      : `事务 ${transaction.id}`;

  return (
    <article className={`binlog-transaction${expanded ? " binlog-transaction--expanded" : ""}`}>
      <button
        aria-controls={detailsId}
        aria-expanded={expanded}
        className="binlog-transaction__toggle"
        onClick={() => onToggle(transaction)}
        type="button"
      >
        <ChevronRight aria-hidden="true" className="binlog-transaction__chevron" size={15} />
        <span className="binlog-transaction__time">{formatTimestamp(transaction.timestamp)}</span>
        <span className="binlog-transaction__identity" title={identity}>
          {identity}
        </span>
        <span
          className={`binlog-status binlog-status--${transaction.status}`}
          title={
            transaction.status === "rolled_back"
              ? "日志中观察到 ROLLBACK；非事务表的变更可能仍已生效"
              : `事务状态：${transactionStatusLabel(transaction.status)}`
          }
        >
          {transactionStatusLabel(transaction.status)}
        </span>
        <span className="binlog-transaction__rows">
          {formatCount(transaction.rowChangeCount)} 行
        </span>
      </button>

      <div className="binlog-transaction__meta">
        <span>server {transaction.serverId}</span>
        <span>
          {transaction.fileName}:{transaction.startPosition}
          {transaction.endPosition !== transaction.startPosition
            ? `–${transaction.endPosition}`
            : ""}
        </span>
        <span className="binlog-transaction__tables">
          {transaction.tables.length > 0
            ? transaction.tables.map((table) => (
                <span className="binlog-table-chip" key={`${table.database}.${table.table}`}>
                  {table.database}.{table.table}
                  {table.rowChangeCount === undefined ? "" : ` · ${formatCount(table.rowChangeCount)}`}
                </span>
              ))
            : "未识别表"}
        </span>
        <span className="binlog-reset-sql">
          <button
            aria-label={`复制事务 ${identity} 的 Reset SQL`}
            disabled={resetLoading || transaction.status !== "committed" || transaction.rowChangeCount === 0}
            onClick={() => onCopyResetSql(transaction)}
            title={
              transaction.status !== "committed"
                ? "只为已提交事务生成 Reset SQL"
                : transaction.rowChangeCount === 0
                  ? "该事务没有可逆的行变更"
                  : "按当前筛选生成逆序 Reset SQL；复制前不会执行"
            }
            type="button"
          >
            <Copy aria-hidden="true" size={12} />
            {resetLoading ? "生成中…" : "复制 Reset SQL"}
          </button>
          {resetFeedback ? (
            <span
              className={`binlog-reset-sql__feedback binlog-reset-sql__feedback--${resetFeedback.tone}`}
              role={resetFeedback.tone === "error" ? "alert" : "status"}
              title={resetFeedback.details ?? undefined}
            >
              {resetFeedback.message}
            </span>
          ) : null}
        </span>
      </div>

      {expanded ? (
        <div className="binlog-transaction__details" id={detailsId}>
          {detailLoading ? (
            <p className="binlog-change__empty" role="status">正在加载事务详情…</p>
          ) : detailError ? (
            <p className="binlog-change__empty binlog-change__empty--error" role="alert">
              {detailError}；收起后可重试。
            </p>
          ) : detail && detail.changes.length > 0 ? (
            detail.changes.map((change, index) => (
              <TableChangeDetails
                change={change}
                key={`${change.database}.${change.table}-${change.operation}-${index}`}
              />
            ))
          ) : (
            <p className="binlog-change__empty">该事务没有可展示的表变更。</p>
          )}
        </div>
      ) : null}
    </article>
  );
}

/** Renders aggregate source, time-range, change-count, and diagnostic summary cards. */
function SummaryCards({ summary }: { summary: BinlogSummary }) {
  const sourceNames = summary.files
    .map((file) => fileBaseName(file.path))
    .join("、");

  return (
    <>
      <section className="binlog-summary" aria-label="分析摘要">
        <div className="binlog-summary__card">
          <span>日志文件</span>
          <strong>{formatCount(summary.files.length)}</strong>
          <small title={sourceNames}>{sourceNames || "无"}</small>
        </div>
        <div className="binlog-summary__card binlog-summary__card--wide">
          <span>事件时间范围</span>
          <strong>{formatTimestamp(summary.firstEventAt)}</strong>
          <small>至 {formatTimestamp(summary.lastEventAt)}</small>
        </div>
        <div className="binlog-summary__card">
          <span>事务</span>
          <strong>{formatCount(summary.transactionCount)}</strong>
          <small>按提交边界聚合</small>
        </div>
        <div className="binlog-summary__card">
          <span>底层事件</span>
          <strong>{formatCount(summary.eventCount)}</strong>
          <small>按文件位置排序</small>
        </div>
        <div className="binlog-summary__card">
          <span>行变更</span>
          <strong>{formatCount(summary.rowChangeCount)}</strong>
          <small>INSERT / UPDATE / DELETE</small>
        </div>
        <div className="binlog-summary__card">
          <span>诊断状态</span>
          <strong className={`binlog-summary__status binlog-summary__status--${summary.status}`}>
            {analysisStatusLabel(summary.status)}
          </strong>
          <small>{formatCount(summary.diagnostics.length)} 项诊断</small>
        </div>
      </section>

      {summary.diagnostics.length > 0 ? (
        <details className="binlog-diagnostics">
          <summary>查看解析诊断（{summary.diagnostics.length}）</summary>
          <ul>
            {summary.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${diagnostic.fileName ?? ""}-${index}`}>
                <span className={`binlog-diagnostic binlog-diagnostic--${diagnostic.severity}`}>
                  {diagnostic.severity === "error"
                    ? "错误"
                    : diagnostic.severity === "warning"
                      ? "警告"
                      : "信息"}
                </span>
                <code>{diagnostic.code}</code>
                <span>{diagnostic.message}</span>
                {diagnostic.fileName ? (
                  <small>
                    {diagnostic.fileName}
                    {diagnostic.position === null || diagnostic.position === undefined
                      ? ""
                      : `:${diagnostic.position}`}
                  </small>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

/**
 * Owns one ephemeral offline binlog import, its filters, and cursor-paginated timeline.
 * Parameters: none.
 * @returns A self-contained desktop analysis workspace.
 * Side effects: opens a native file picker and invokes binlog Tauri commands.
 */
export function BinlogWorkspace() {
  const [phase, setPhase] = useState<ImportPhase>("empty");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [progress, setProgress] = useState<BinlogImportProgress>(EMPTY_PROGRESS);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [importError, setImportError] = useState<BinlogImportError | null>(null);
  const [summary, setSummary] = useState<BinlogSummary | null>(null);
  const [filter, setFilter] = useState<TimelineFilter>({
    database: "",
    table: "",
    operation: "",
  });
  const [transactions, setTransactions] = useState<BinlogTransactionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineReload, setTimelineReload] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [transactionDetails, setTransactionDetails] = useState<
    Record<string, BinlogTransaction>
  >({});
  const [transactionDetailErrors, setTransactionDetailErrors] = useState<
    Record<string, string>
  >({});
  const [transactionDetailLoadingIds, setTransactionDetailLoadingIds] = useState<Set<string>>(
    new Set(),
  );
  const [resetSqlLoadingIds, setResetSqlLoadingIds] = useState<Set<string>>(new Set());
  const [resetSqlFeedback, setResetSqlFeedback] = useState<Record<string, ResetSqlFeedback>>({});

  const mountedRef = useRef(true);
  const activeRunRef = useRef(0);
  const timelineGenerationRef = useRef(0);
  const transactionDetailGenerationRef = useRef(0);
  const analysisIdRef = useRef<string | null>(null);
  const importRunningRef = useRef(false);
  const cancelRequestedRef = useRef(false);

  /**
   * Cancels a running parser when requested and always releases its ephemeral analysis.
   * @param id - Backend analysis identifier.
   * @param running - Whether cancellation should precede close.
   * @returns A promise that settles after best-effort cleanup.
   * Side effects: invokes cancel and close; failures are intentionally contained.
   */
  const disposeAnalysis = useCallback(async (id: string, running: boolean): Promise<void> => {
    if (running) {
      await cancelBinlogImport(id).catch(() => undefined);
    }
    await closeBinlogAnalysis(id).catch(() => undefined);
  }, []);

  /**
   * Invalidates all expanded transaction requests when the analysis or filter changes.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: clears disclosure state and prevents stale detail responses from rendering.
   */
  const resetTransactionDetails = useCallback((): void => {
    transactionDetailGenerationRef.current += 1;
    setExpandedIds(new Set());
    setTransactionDetails({});
    setTransactionDetailErrors({});
    setTransactionDetailLoadingIds(new Set());
    setResetSqlLoadingIds(new Set());
    setResetSqlFeedback({});
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRunRef.current += 1;
      timelineGenerationRef.current += 1;
      transactionDetailGenerationRef.current += 1;
      const id = analysisIdRef.current;
      if (id) {
        void disposeAnalysis(id, importRunningRef.current);
      }
    };
  }, [disposeAnalysis]);

  /**
   * Loads aggregate analysis data after the parser emits a completed terminal event.
   * @param id - Completed backend analysis identifier.
   * @param runId - Local generation used to reject stale event and promise delivery.
   * @returns A promise resolving after the summary is visible or an error is retained.
   * Side effects: reads backend summary state and updates this workspace.
   */
  const hydrateCompletedAnalysis = useCallback(async (id: string, runId: number): Promise<void> => {
    analysisIdRef.current = id;
    setAnalysisId(id);
    setPhase("loading");
    try {
      const loadedSummary = await getBinlogSummary(id);
      if (!mountedRef.current || runId !== activeRunRef.current) {
        return;
      }
      setSummary(loadedSummary);
      setPhase("ready");
    } catch (error) {
      if (!mountedRef.current || runId !== activeRunRef.current) {
        return;
      }
      setImportError(normalizeImportError(error, "分析摘要加载失败，请重试。"));
      setPhase("error");
    }
  }, []);

  /**
   * Sends cancellation once an analysis identifier is available.
   * @param id - Active backend analysis identifier.
   * @param runId - Local import generation guarding stale promise delivery.
   * @returns A promise resolving after the request succeeds or its error is displayed.
   * Side effects: invokes the native cancel command and updates cancellation feedback.
   */
  const requestCancellation = useCallback(async (id: string, runId: number): Promise<void> => {
    try {
      await cancelBinlogImport(id);
    } catch (error) {
      if (!mountedRef.current || runId !== activeRunRef.current) {
        return;
      }
      cancelRequestedRef.current = false;
      setCancelRequested(false);
      setCancelError(normalizeImportError(error, "取消请求失败，解析仍在继续。").message);
    }
  }, []);

  /**
   * Starts one new import using an already selected ordered path list.
   * @param paths - Native paths selected by the user; no extension filtering is assumed.
   * @returns A promise resolving once startup is accepted or its failure is retained.
   * Side effects: closes the previous session, creates a Tauri channel, and starts parsing.
   */
  const beginImport = useCallback(
    async (paths: string[]): Promise<void> => {
      if (!mountedRef.current || paths.length === 0) {
        return;
      }

      const runId = activeRunRef.current + 1;
      activeRunRef.current = runId;
      const previousId = analysisIdRef.current;
      const previousRunning = importRunningRef.current;
      analysisIdRef.current = null;
      importRunningRef.current = false;
      cancelRequestedRef.current = false;

      setSelectedPaths(paths);
      setAnalysisId(null);
      setPhase("importing");
      setProgress({ ...EMPTY_PROGRESS, fileCount: paths.length });
      setCancelRequested(false);
      setCancelError(null);
      setImportError(null);
      setSummary(null);
      setTransactions([]);
      setNextCursor(null);
      setTimelineError(null);
      resetTransactionDetails();
      setFilter({ database: "", table: "", operation: "" });

      if (previousId) {
        await disposeAnalysis(previousId, previousRunning);
      }
      if (!mountedRef.current || runId !== activeRunRef.current) {
        return;
      }

      const onEvent = new Channel<BinlogImportEvent>();
      importRunningRef.current = true;
      onEvent.onmessage = (event) => {
        if (!mountedRef.current || runId !== activeRunRef.current) {
          return;
        }

        analysisIdRef.current = event.analysisId;
        setAnalysisId(event.analysisId);
        switch (event.type) {
          case "started":
            setProgress((current) => ({
              ...current,
              fileCount: event.fileCount,
              totalBytes: event.totalBytes,
            }));
            break;
          case "progress":
            setProgress({
              bytesRead: event.bytesRead,
              totalBytes: event.totalBytes,
              filesCompleted: event.filesCompleted,
              fileCount: event.fileCount,
              currentFile: event.currentFile,
              transactionCount: event.transactionCount,
              eventCount: event.eventCount,
            });
            break;
          case "completed":
            importRunningRef.current = false;
            cancelRequestedRef.current = false;
            setCancelRequested(false);
            void hydrateCompletedAnalysis(event.analysisId, runId);
            break;
          case "failed":
            importRunningRef.current = false;
            cancelRequestedRef.current = false;
            setCancelRequested(false);
            setImportError(event.error);
            setPhase("error");
            break;
          case "canceled":
            importRunningRef.current = false;
            cancelRequestedRef.current = false;
            setCancelRequested(false);
            setPhase("canceled");
            break;
        }
      };

      try {
        const id = await startBinlogImport(paths, onEvent);
        if (!mountedRef.current || runId !== activeRunRef.current) {
          void disposeAnalysis(id, true);
          return;
        }
        analysisIdRef.current = id;
        setAnalysisId(id);
        if (cancelRequestedRef.current) {
          void requestCancellation(id, runId);
        }
      } catch (error) {
        if (!mountedRef.current || runId !== activeRunRef.current) {
          return;
        }
        importRunningRef.current = false;
        setImportError(normalizeImportError(error, "无法启动 Binlog 导入，请重试。"));
        setPhase("error");
      }
    },
    [disposeAnalysis, hydrateCompletedAnalysis, requestCancellation, resetTransactionDetails],
  );

  /**
   * Opens the unrestricted native file picker and starts analysis for its ordered result.
   * Parameters: none.
   * @returns A promise resolving after selection is canceled or import startup completes.
   * Side effects: opens a desktop dialog; file content, not extension, determines compatibility.
   */
  const chooseFiles = useCallback(async (): Promise<void> => {
    try {
      const selection = await open({
        directory: false,
        multiple: true,
        title: "选择一个或多个连续的 Binlog 文件",
      });
      const paths = (Array.isArray(selection) ? selection : selection ? [selection] : []).filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      );
      if (mountedRef.current && paths.length > 0) {
        await beginImport(paths);
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setImportError(normalizeImportError(error, "无法打开文件选择器，请重试。"));
      setPhase("error");
    }
  }, [beginImport]);

  /** Requests cancellation immediately or defers it until startup returns an identifier. */
  const cancelImport = useCallback((): void => {
    if (!importRunningRef.current || cancelRequestedRef.current) {
      return;
    }
    cancelRequestedRef.current = true;
    setCancelRequested(true);
    setCancelError(null);
    const id = analysisIdRef.current;
    if (id) {
      void requestCancellation(id, activeRunRef.current);
    }
  }, [requestCancellation]);

  useEffect(() => {
    if (phase !== "ready" || !analysisId) {
      return;
    }
    const generation = timelineGenerationRef.current + 1;
    timelineGenerationRef.current = generation;
    const request: BinlogTransactionFilter = {
      database: filter.database || null,
      table: filter.table || null,
      operation: filter.operation || null,
      cursor: null,
      limit: PAGE_SIZE,
    };
    setTimelineLoading(true);
    setTimelineError(null);
    setTransactions([]);
    setNextCursor(null);
    void listBinlogTransactions(analysisId, request)
      .then((page) => {
        if (mountedRef.current && generation === timelineGenerationRef.current) {
          setTransactions(page.items);
          setNextCursor(page.nextCursor);
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current && generation === timelineGenerationRef.current) {
          setTimelineError(normalizeImportError(error, "事务时间线加载失败，请重试。").message);
        }
      })
      .finally(() => {
        if (mountedRef.current && generation === timelineGenerationRef.current) {
          setTimelineLoading(false);
        }
      });
  }, [analysisId, filter, phase, timelineReload]);

  /** Appends the next cursor page without replacing already visible transactions. */
  const loadMoreTransactions = useCallback(async (): Promise<void> => {
    if (!analysisId || !nextCursor || timelineLoading) {
      return;
    }
    const generation = timelineGenerationRef.current;
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const page = await listBinlogTransactions(analysisId, {
        database: filter.database || null,
        table: filter.table || null,
        operation: filter.operation || null,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      if (!mountedRef.current || generation !== timelineGenerationRef.current) {
        return;
      }
      setTransactions((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (mountedRef.current && generation === timelineGenerationRef.current) {
        setTimelineError(normalizeImportError(error, "下一页加载失败，请重试。").message);
      }
    } finally {
      if (mountedRef.current && generation === timelineGenerationRef.current) {
        setTimelineLoading(false);
      }
    }
  }, [analysisId, filter, nextCursor, timelineLoading]);

  /**
   * Loads one transaction's row images only after its summary is expanded.
   * @param transaction - Lightweight transaction selected from the current timeline page.
   * @returns A promise resolving after the matching projected details are retained.
   * Side effects: invokes one native detail command and updates per-transaction feedback.
   */
  const loadTransactionDetails = useCallback(async (
    transaction: BinlogTransactionSummary,
  ): Promise<void> => {
    if (!analysisId) {
      return;
    }
    const generation = transactionDetailGenerationRef.current;
    setTransactionDetailLoadingIds((current) => new Set(current).add(transaction.id));
    setTransactionDetailErrors((current) => {
      const next = { ...current };
      delete next[transaction.id];
      return next;
    });
    try {
      const detail = await getBinlogTransaction(
        analysisId,
        transaction.sequence,
        filter.database || null,
        filter.table || null,
        filter.operation || null,
      );
      if (!mountedRef.current || generation !== transactionDetailGenerationRef.current) {
        return;
      }
      setTransactionDetails((current) => ({ ...current, [transaction.id]: detail }));
    } catch (error) {
      if (mountedRef.current && generation === transactionDetailGenerationRef.current) {
        setTransactionDetailErrors((current) => ({
          ...current,
          [transaction.id]: normalizeImportError(
            error,
            "事务详情加载失败",
          ).message,
        }));
      }
    } finally {
      if (mountedRef.current && generation === transactionDetailGenerationRef.current) {
        setTransactionDetailLoadingIds((current) => {
          const next = new Set(current);
          next.delete(transaction.id);
          return next;
        });
      }
    }
  }, [analysisId, filter]);

  /**
   * Toggles one transaction disclosure and lazily requests missing row images.
   * @param transaction - Lightweight transaction selected from the current timeline page.
   * @returns Nothing (`void`).
   * Side effects: updates disclosure state and may start one detail request.
   */
  const toggleTransaction = useCallback((transaction: BinlogTransactionSummary): void => {
    const transactionId = transaction.id;
    if (!expandedIds.has(transactionId)
      && !transactionDetails[transactionId]
      && !transactionDetailLoadingIds.has(transactionId)) {
      void loadTransactionDetails(transaction);
    }
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(transactionId)) {
        next.delete(transactionId);
      } else {
        next.add(transactionId);
      }
      return next;
    });
  }, [
    expandedIds,
    loadTransactionDetails,
    transactionDetails,
    transactionDetailLoadingIds,
  ]);

  /**
   * Generates Reset SQL for the current transaction projection and writes it to the clipboard.
   * @param transaction - Lightweight timeline transaction selected by the user.
   * @returns A promise that settles after generation and the optional clipboard write.
   * Side effects: invokes the backend generator, writes the OS clipboard, and updates feedback.
   */
  const copyResetSql = useCallback(async (
    transaction: BinlogTransactionSummary,
  ): Promise<void> => {
    if (!analysisId || resetSqlLoadingIds.has(transaction.id)) {
      return;
    }
    setResetSqlLoadingIds((current) => new Set(current).add(transaction.id));
    setResetSqlFeedback((current) => {
      const next = { ...current };
      delete next[transaction.id];
      return next;
    });
    try {
      const output = await getBinlogResetSql(
        analysisId,
        transaction.sequence,
        filter.database || null,
        filter.table || null,
        filter.operation || null,
      );
      if (!mountedRef.current) {
        return;
      }
      if (!output.sql) {
        setResetSqlFeedback((current) => ({
          ...current,
          [transaction.id]: {
            message: "没有可安全生成的 Reset SQL",
            tone: "warning",
            details: output.warnings.join("\n") || null,
          },
        }));
        return;
      }
      await writeText(output.sql);
      if (!mountedRef.current) {
        return;
      }
      setResetSqlFeedback((current) => ({
        ...current,
        [transaction.id]: {
          message: output.complete
            ? `已复制 ${formatCount(output.statementCount)} 条`
            : `已复制 ${formatCount(output.statementCount)} 条，部分变更已跳过`,
          tone: output.complete ? "success" : "warning",
          details: output.warnings.join("\n") || null,
        },
      }));
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setResetSqlFeedback((current) => ({
        ...current,
        [transaction.id]: {
          message: "Reset SQL 复制失败",
          tone: "error",
          details: normalizeImportError(error, "Reset SQL 生成或复制失败。").message,
        },
      }));
    } finally {
      if (mountedRef.current) {
        setResetSqlLoadingIds((current) => {
          const next = new Set(current);
          next.delete(transaction.id);
          return next;
        });
      }
    }
  }, [analysisId, filter, resetSqlLoadingIds]);

  const databaseOptions = useMemo(
    () => Array.from(new Set((summary?.tables ?? []).map((table) => table.database))).sort(),
    [summary],
  );
  const tableOptions = useMemo(
    () =>
      Array.from(
        new Set(
          (summary?.tables ?? [])
            .filter((table) => !filter.database || table.database === filter.database)
            .map((table) => table.table),
        ),
      ).sort(),
    [filter.database, summary],
  );
  const progressPercent =
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesRead / progress.totalBytes) * 100))
      : 0;
  const selectedFileNames = selectedPaths.map(fileBaseName);

  return (
    <section className="binlog-workspace" aria-label="Binlog 分析工作区">
      <header className="binlog-workspace__header">
        <div>
          <span className="binlog-workspace__eyebrow">离线日志分析</span>
          <h1>Binlog 时间线</h1>
          <p>按事务还原表与行级变化，缺失值不会被误判为 NULL。</p>
        </div>
        {phase !== "empty" && phase !== "importing" && phase !== "loading" ? (
          <button className="binlog-button binlog-button--secondary" onClick={() => void chooseFiles()} type="button">
            <FileCode2 aria-hidden="true" size={15} />
            导入新日志
          </button>
        ) : null}
      </header>

      {phase === "empty" ? (
        <div className="binlog-empty">
          <div className="binlog-empty__icon" aria-hidden="true">
            <FileClock size={34} strokeWidth={1.4} />
          </div>
          <h2>选择 Binlog 文件开始分析</h2>
          <p>
            可一次选择多个连续文件。兼容性由文件内容检测，不依赖文件扩展名；日志只在本机解析。
          </p>
          <button className="binlog-button binlog-button--primary" onClick={() => void chooseFiles()} type="button">
            <FileCode2 aria-hidden="true" size={16} />
            选择日志文件
          </button>
        </div>
      ) : null}

      {phase === "importing" ? (
        <div className="binlog-import" aria-live="polite">
          <div className="binlog-import__heading">
            <div>
              <span className="binlog-workspace__eyebrow">
                {cancelRequested ? "正在取消" : "正在解析"}
              </span>
              <h2>{progress.currentFile ? fileBaseName(progress.currentFile) : "准备日志文件"}</h2>
            </div>
            <strong>{progressPercent}%</strong>
          </div>
          <progress aria-label="Binlog 导入进度" max={100} value={progressPercent} />
          <div className="binlog-import__stats">
            <span>
              {formatBytes(progress.bytesRead)} / {formatBytes(progress.totalBytes)}
            </span>
            <span>
              文件 {progress.filesCompleted} / {progress.fileCount || selectedPaths.length}
            </span>
            <span>{formatCount(progress.transactionCount)} 个事务</span>
            <span>{formatCount(progress.eventCount)} 个事件</span>
          </div>
          <div className="binlog-file-list" aria-label="已选择文件">
            {selectedFileNames.map((name, index) => (
              <span key={`${name}-${index}`}>{name}</span>
            ))}
          </div>
          {cancelError ? <p className="binlog-inline-error" role="alert">{cancelError}</p> : null}
          <button
            className="binlog-button binlog-button--danger"
            disabled={cancelRequested}
            onClick={cancelImport}
            type="button"
          >
            <X aria-hidden="true" size={15} />
            {cancelRequested ? "正在取消…" : "取消导入"}
          </button>
        </div>
      ) : null}

      {phase === "loading" ? (
        <div className="binlog-loading" role="status">
          <LoaderCircle aria-hidden="true" className="binlog-spin" size={24} />
          <div>
            <strong>解析完成，正在生成时间线</strong>
            <span>正在读取摘要与筛选索引…</span>
          </div>
        </div>
      ) : null}

      {phase === "error" && importError ? (
        <div className="binlog-state-card binlog-state-card--error" role="alert">
          <AlertTriangle aria-hidden="true" size={23} />
          <div>
            <h2>导入未完成</h2>
            <p>{importError.message}</p>
            {importError.technicalDetails ? <code>{importError.technicalDetails}</code> : null}
            {selectedFileNames.length > 0 ? (
              <div className="binlog-file-list" aria-label="保留的文件选择">
                {selectedFileNames.map((name, index) => (
                  <span key={`${name}-${index}`}>{name}</span>
                ))}
              </div>
            ) : null}
            <div className="binlog-state-card__actions">
              {selectedPaths.length > 0 ? (
                <button className="binlog-button binlog-button--primary" onClick={() => void beginImport(selectedPaths)} type="button">
                  <RefreshCw aria-hidden="true" size={15} />
                  使用相同文件重试
                </button>
              ) : null}
              <button className="binlog-button binlog-button--secondary" onClick={() => void chooseFiles()} type="button">
                重新选择
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {phase === "canceled" ? (
        <div className="binlog-state-card">
          <Check aria-hidden="true" size={23} />
          <div>
            <h2>导入已取消</h2>
            <p>未完成的解析结果不会展示。可以使用相同文件重新开始。</p>
            <div className="binlog-state-card__actions">
              <button className="binlog-button binlog-button--primary" onClick={() => void beginImport(selectedPaths)} type="button">
                <RefreshCw aria-hidden="true" size={15} />
                重新导入
              </button>
              <button className="binlog-button binlog-button--secondary" onClick={() => void chooseFiles()} type="button">
                选择其他文件
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {phase === "ready" && summary ? (
        <div className="binlog-analysis">
          <SummaryCards summary={summary} />

          <section className="binlog-timeline" aria-labelledby="binlog-timeline-title">
            <div className="binlog-timeline__toolbar">
              <div>
                <span className="binlog-workspace__eyebrow">事务视图</span>
                <h2 id="binlog-timeline-title">操作时间线</h2>
              </div>
              <div className="binlog-filters" aria-label="时间线筛选">
                <label>
                  <Database aria-hidden="true" size={13} />
                  <span>数据库</span>
                  <select
                    aria-label="数据库"
                    onChange={(event) => {
                      resetTransactionDetails();
                      setFilter((current) => ({
                        ...current,
                        database: event.target.value,
                        table: "",
                      }));
                    }}
                    value={filter.database}
                  >
                    <option value="">全部数据库</option>
                    {databaseOptions.map((database) => (
                      <option key={database} value={database}>
                        {database}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <Table2 aria-hidden="true" size={13} />
                  <span>数据表</span>
                  <select
                    aria-label="数据表"
                    onChange={(event) => {
                      resetTransactionDetails();
                      setFilter((current) => ({ ...current, table: event.target.value }));
                    }}
                    value={filter.table}
                  >
                    <option value="">全部数据表</option>
                    {tableOptions.map((table) => (
                      <option key={table} value={table}>
                        {table}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>操作类型</span>
                  <select
                    aria-label="操作类型"
                    onChange={(event) => {
                      resetTransactionDetails();
                      setFilter((current) => ({
                        ...current,
                        operation: event.target.value as "" | BinlogOperation,
                      }));
                    }}
                    value={filter.operation}
                  >
                    <option value="">全部操作</option>
                    <option value="insert">INSERT</option>
                    <option value="update">UPDATE</option>
                    <option value="delete">DELETE</option>
                    <option value="ddl">DDL</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="binlog-timeline__legend" aria-hidden="true">
              <span>时间 / 事务</span>
              <span>状态 / 行数</span>
            </div>

            {timelineError ? (
              <div className="binlog-timeline__error" role="alert">
                <AlertTriangle aria-hidden="true" size={16} />
                <span>{timelineError}</span>
                <button onClick={() => setTimelineReload((value) => value + 1)} type="button">
                  重试加载
                </button>
              </div>
            ) : null}

            {timelineLoading && transactions.length === 0 ? (
              <div className="binlog-timeline__loading" role="status">
                <LoaderCircle aria-hidden="true" className="binlog-spin" size={18} />
                正在加载事务…
              </div>
            ) : null}

            {!timelineLoading && !timelineError && transactions.length === 0 ? (
              <div className="binlog-timeline__empty">
                <FileClock aria-hidden="true" size={22} />
                <strong>当前筛选没有事务</strong>
                <span>调整数据库、数据表或操作类型筛选。</span>
              </div>
            ) : null}

            <div className="binlog-timeline__items">
              {transactions.map((transaction) => (
                <TransactionCard
                  detail={transactionDetails[transaction.id] ?? null}
                  detailError={transactionDetailErrors[transaction.id] ?? null}
                  detailLoading={transactionDetailLoadingIds.has(transaction.id)}
                  expanded={expandedIds.has(transaction.id)}
                  key={transaction.id}
                  onCopyResetSql={(item) => void copyResetSql(item)}
                  onToggle={toggleTransaction}
                  resetFeedback={resetSqlFeedback[transaction.id] ?? null}
                  resetLoading={resetSqlLoadingIds.has(transaction.id)}
                  transaction={transaction}
                />
              ))}
            </div>

            {nextCursor ? (
              <button
                className="binlog-button binlog-button--secondary binlog-timeline__more"
                disabled={timelineLoading}
                onClick={() => void loadMoreTransactions()}
                type="button"
              >
                {timelineLoading ? (
                  <LoaderCircle aria-hidden="true" className="binlog-spin" size={15} />
                ) : (
                  <ChevronRight aria-hidden="true" size={15} />
                )}
                {timelineLoading ? "正在加载…" : "加载更多事务"}
              </button>
            ) : transactions.length > 0 ? (
              <p className="binlog-timeline__end">已到达当前筛选的时间线末尾</p>
            ) : null}
          </section>
        </div>
      ) : null}
    </section>
  );
}
