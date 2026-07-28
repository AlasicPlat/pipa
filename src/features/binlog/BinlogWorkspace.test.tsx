import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BinlogWorkspace } from "./BinlogWorkspace";
import type {
  BinlogImportEvent,
  BinlogSummary,
  BinlogTransaction,
  BinlogTransactionPage,
  BinlogTransactionSummary,
} from "./types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  writeText: vi.fn(),
  channels: [] as Array<{ onmessage: ((event: unknown) => void) | null }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel {
    onmessage: ((event: unknown) => void) | null = null;

    /** Retains each test channel so lifecycle events can be delivered deterministically. */
    constructor() {
      mocks.channels.push(this);
    }
  },
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mocks.writeText,
}));

const ANALYSIS_ID = "analysis-1";
const SUMMARY: BinlogSummary = {
  analysisId: ANALYSIS_ID,
  status: "warning",
  files: [{ path: "/var/log/mysql/mysql-bin.000001", sizeBytes: 4096 }],
  startedAt: "2026-07-27T01:02:02Z",
  endedAt: "2026-07-27T02:03:05Z",
  firstEventAt: "2026-07-27T01:02:03Z",
  lastEventAt: "2026-07-27T02:03:04Z",
  transactionCount: 12,
  eventCount: 90,
  rowChangeCount: 27,
  diagnostics: [
    {
      severity: "warning",
      code: "minimal_metadata",
      message: "部分列名未写入日志。",
      fileName: "mysql-bin.000001",
      position: 120,
    },
  ],
  tables: [
    {
      database: "shop",
      table: "orders",
      insertCount: 10,
      updateCount: 8,
      deleteCount: 3,
      ddlCount: 0,
      rowChangeCount: 21,
    },
    {
      database: "shop",
      table: "users",
      insertCount: 2,
      updateCount: 4,
      deleteCount: 0,
      ddlCount: 0,
      rowChangeCount: 6,
    },
  ],
};
const TRANSACTION: BinlogTransaction = {
  id: "transaction-1",
  sequence: 1,
  timestamp: "2026-07-27T01:12:13Z",
  gtid: "server-uuid:42",
  xid: "9001",
  serverId: 7,
  fileName: "mysql-bin.000001",
  startPosition: 120,
  endPosition: 488,
  status: "committed",
  rowChangeCount: 1,
  tables: [{
    database: "shop",
    table: "users",
    insertCount: 0,
    updateCount: 1,
    deleteCount: 0,
    ddlCount: 0,
    rowChangeCount: 1,
  }],
  changes: [
    {
      database: "shop",
      table: "users",
      operation: "update",
      rowCount: 1,
      columns: ["name", "changed_at", "nullable_note", "hidden_column"],
      rows: [
        {
          before: {
            name: { kind: "value", value: { kind: "text", value: "Alice" } },
            changed_at: { kind: "unix_timestamp", value: "1722067200.123456" },
            nullable_note: { kind: "null" },
            hidden_column: { kind: "not_logged" },
          },
          after: {
            name: { kind: "value", value: { kind: "text", value: "Alicia" } },
            changed_at: { kind: "unix_timestamp", value: "1722067260.123456" },
            nullable_note: { kind: "null" },
            hidden_column: { kind: "decode_error", message: "unsupported collation" },
          },
        },
      ],
      tableConfidence: "exact",
      sql: null,
    },
  ],
};
const TRANSACTION_SUMMARY: BinlogTransactionSummary = {
  id: TRANSACTION.id,
  sequence: TRANSACTION.sequence,
  timestamp: TRANSACTION.timestamp,
  gtid: TRANSACTION.gtid,
  xid: TRANSACTION.xid,
  serverId: TRANSACTION.serverId,
  fileName: TRANSACTION.fileName,
  startPosition: TRANSACTION.startPosition,
  endPosition: TRANSACTION.endPosition,
  status: TRANSACTION.status,
  rowChangeCount: TRANSACTION.rowChangeCount,
  tables: TRANSACTION.tables,
};
const PAGE: BinlogTransactionPage = { items: [TRANSACTION_SUMMARY], nextCursor: null };

/** Returns the latest mocked Tauri channel or fails the test with clear context. */
function latestChannel(): { onmessage: ((event: unknown) => void) | null } {
  const channel = mocks.channels[mocks.channels.length - 1];
  if (!channel) {
    throw new Error("Expected a binlog event channel to be created.");
  }
  return channel;
}

/** Delivers one ordered lifecycle event through the component's mocked Tauri channel. */
function emitEvent(event: BinlogImportEvent): void {
  act(() => {
    latestChannel().onmessage?.(event);
  });
}

/** Configures the common successful import, summary, and timeline command responses. */
function configureSuccessfulBackend(page: BinlogTransactionPage = PAGE): void {
  mocks.invoke.mockImplementation((command: string) => {
    switch (command) {
      case "binlog_start_import":
        return Promise.resolve(ANALYSIS_ID);
      case "binlog_get_summary":
        return Promise.resolve(SUMMARY);
      case "binlog_list_transactions":
        return Promise.resolve(page);
      case "binlog_get_transaction":
        return Promise.resolve(TRANSACTION);
      case "binlog_get_reset_sql":
        return Promise.resolve({
          sql: "UPDATE `shop`.`users` SET `name` = 'Alice' WHERE `name` <=> 'Alicia' LIMIT 1;",
          statementCount: 1,
          complete: true,
          warnings: [],
        });
      case "binlog_cancel_import":
      case "binlog_close_analysis":
        return Promise.resolve(undefined);
      default:
        return Promise.reject(new Error(`Unexpected command: ${command}`));
    }
  });
}

/** Selects one source and waits until the native import command owns a channel. */
async function startImport(): Promise<void> {
  mocks.open.mockResolvedValue(["/var/log/mysql/mysql-bin.000001"]);
  fireEvent.click(screen.getByRole("button", { name: "选择日志文件" }));
  await waitFor(() => {
    expect(mocks.invoke).toHaveBeenCalledWith(
      "binlog_start_import",
      expect.objectContaining({
        paths: ["/var/log/mysql/mysql-bin.000001"],
        onEvent: expect.anything(),
      }),
    );
  });
}

/** Starts and completes an analysis, including the initial cursor page. */
async function completeAnalysis(): Promise<void> {
  await startImport();
  emitEvent({ type: "completed", analysisId: ANALYSIS_ID });
  await screen.findByText("操作时间线");
  await screen.findByText("GTID server-uuid:42");
}

/** Resets native mocks and DOM state between feature tests. */
function resetTestState(): void {
  mocks.invoke.mockReset();
  mocks.open.mockReset();
  mocks.writeText.mockReset();
  mocks.writeText.mockResolvedValue(undefined);
  mocks.channels.length = 0;
}

/** Removes mounted workspaces after each test so their idempotent close cleanup runs. */
function cleanupTestState(): void {
  cleanup();
}

beforeEach(resetTestState);
afterEach(cleanupTestState);

describe("BinlogWorkspace", () => {
  it("renders an accessible empty state without touching native APIs", () => {
    render(<BinlogWorkspace />);

    expect(screen.getByRole("heading", { name: "选择 Binlog 文件开始分析" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择日志文件" })).toBeInTheDocument();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("keeps the empty workspace unchanged when native file selection is canceled", async () => {
    render(<BinlogWorkspace />);
    mocks.open.mockResolvedValue(null);

    fireEvent.click(screen.getByRole("button", { name: "选择日志文件" }));

    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { name: "选择 Binlog 文件开始分析" })).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("ignores a file dialog that resolves after the workspace is unmounted", async () => {
    let resolveSelection: (paths: string[]) => void = () => undefined;
    mocks.open.mockReturnValue(
      new Promise<string[]>((resolve) => {
        resolveSelection = resolve;
      }),
    );
    const { unmount } = render(<BinlogWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: "选择日志文件" }));
    unmount();
    await act(async () => {
      resolveSelection(["/var/log/mysql/mysql-bin.000001"]);
      await Promise.resolve();
    });

    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("selects unrestricted files, streams progress, and requests cancellation", async () => {
    configureSuccessfulBackend();
    render(<BinlogWorkspace />);
    mocks.open.mockResolvedValue([
      "/var/log/mysql/mysql-bin.000001",
      "/tmp/binlog-without-extension",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "选择日志文件" }));

    await waitFor(() => expect(mocks.channels).toHaveLength(1));
    expect(mocks.open).toHaveBeenCalledWith({
      directory: false,
      multiple: true,
      title: "选择一个或多个连续的 Binlog 文件",
    });

    emitEvent({
      type: "started",
      analysisId: ANALYSIS_ID,
      fileCount: 2,
      totalBytes: 200,
    });
    emitEvent({
      type: "progress",
      analysisId: ANALYSIS_ID,
      bytesRead: 100,
      totalBytes: 200,
      filesCompleted: 1,
      fileCount: 2,
      currentFile: "/tmp/binlog-without-extension",
      transactionCount: 12,
      eventCount: 48,
    });

    expect(screen.getByRole("progressbar", { name: "Binlog 导入进度" })).toHaveValue(50);
    expect(screen.getAllByText("binlog-without-extension")).toHaveLength(2);
    expect(screen.getByText("12 个事务")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消导入" }));
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("binlog_cancel_import", {
        analysisId: ANALYSIS_ID,
      });
    });
    expect(screen.getByRole("button", { name: "正在取消…" })).toBeDisabled();
  });

  it("shows completed summary cards and sends table filters with a reset cursor", async () => {
    configureSuccessfulBackend();
    render(<BinlogWorkspace />);
    await completeAnalysis();

    expect(screen.getByText("mysql-bin.000001")).toBeInTheDocument();
    expect(screen.getByText("90")).toBeInTheDocument();
    expect(screen.getByText("27")).toBeInTheDocument();
    expect(screen.getByText("有警告")).toBeInTheDocument();
    expect(
      mocks.invoke.mock.calls.some(([command]) => command === "binlog_get_transaction"),
    ).toBe(false);

    fireEvent.change(screen.getByRole("combobox", { name: "数据库" }), {
      target: { value: "shop" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "数据表" }), {
      target: { value: "orders" },
    });

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("binlog_list_transactions", {
        analysisId: ANALYSIS_ID,
        filter: {
          database: "shop",
          table: "orders",
          operation: null,
          cursor: null,
          limit: 50,
        },
      });
    });
  });

  it("expands a transaction and distinguishes before, after, NULL, omitted, and decode errors", async () => {
    configureSuccessfulBackend();
    render(<BinlogWorkspace />);
    await completeAnalysis();

    fireEvent.click(screen.getByRole("button", { name: /GTID server-uuid:42已提交/u }));

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Alicia")).toBeInTheDocument();
    expect(screen.getByText("未记录")).toBeInTheDocument();
    expect(screen.getAllByText("NULL")).not.toHaveLength(0);
    expect(screen.getByText("解码失败")).toHaveAttribute("title", "unsupported collation");
    expect(screen.getByTitle("1722067200.123456 Unix 秒")).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("binlog_get_transaction", {
      analysisId: ANALYSIS_ID,
      sequence: 1,
      database: null,
      table: null,
      operation: null,
    });
  });

  it("warns that an observed ROLLBACK may not reverse non-transactional table changes", async () => {
    configureSuccessfulBackend({
      items: [{ ...TRANSACTION_SUMMARY, status: "rolled_back" }],
      nextCursor: null,
    });
    render(<BinlogWorkspace />);
    await completeAnalysis();

    expect(screen.getByText("观察到 ROLLBACK")).toHaveAttribute(
      "title",
      "日志中观察到 ROLLBACK；非事务表的变更可能仍已生效",
    );
    expect(
      screen.getByRole("button", {
        name: "复制事务 GTID server-uuid:42 的 Reset SQL",
      }),
    ).toBeDisabled();
  });

  it("copies backend-generated Reset SQL for the active transaction projection", async () => {
    configureSuccessfulBackend();
    render(<BinlogWorkspace />);
    await completeAnalysis();

    fireEvent.click(
      screen.getByRole("button", {
        name: "复制事务 GTID server-uuid:42 的 Reset SQL",
      }),
    );

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("binlog_get_reset_sql", {
        analysisId: ANALYSIS_ID,
        sequence: 1,
        database: null,
        table: null,
        operation: null,
      });
    });
    expect(mocks.writeText).toHaveBeenCalledWith(
      "UPDATE `shop`.`users` SET `name` = 'Alice' WHERE `name` <=> 'Alicia' LIMIT 1;",
    );
    expect(await screen.findByText("已复制 1 条")).toBeInTheDocument();
  });

  it("retains a failed file selection and retries it without reopening the dialog", async () => {
    configureSuccessfulBackend();
    render(<BinlogWorkspace />);
    await startImport();

    emitEvent({
      type: "failed",
      analysisId: ANALYSIS_ID,
      error: {
        code: "query",
        message: "校验和错误，解析已停止。",
        technicalDetails: "mysql-bin.000001:488",
        retryable: true,
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("校验和错误，解析已停止。");
    expect(screen.getByText("mysql-bin.000001")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "使用相同文件重试" }));

    await waitFor(() => {
      const startCalls = mocks.invoke.mock.calls.filter(
        ([command]) => command === "binlog_start_import",
      );
      expect(startCalls).toHaveLength(2);
    });
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });
});
