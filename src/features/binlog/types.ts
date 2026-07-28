import type { AppError } from "../../bindings/AppError";
import type { BinlogCell } from "../../bindings/BinlogCell";
import type { BinlogChange } from "../../bindings/BinlogChange";
import type { BinlogImportEvent as GeneratedBinlogImportEvent } from "../../bindings/BinlogImportEvent";
import type { BinlogOperation as GeneratedBinlogOperation } from "../../bindings/BinlogOperation";
import type { BinlogResetSql as GeneratedBinlogResetSql } from "../../bindings/BinlogResetSql";
import type { BinlogRowChange as GeneratedBinlogRowChange } from "../../bindings/BinlogRowChange";
import type { BinlogSummary as GeneratedBinlogSummary } from "../../bindings/BinlogSummary";
import type { BinlogTransaction as GeneratedBinlogTransaction } from "../../bindings/BinlogTransaction";
import type { BinlogTransactionFilter as GeneratedBinlogTransactionFilter } from "../../bindings/BinlogTransactionFilter";
import type { BinlogTransactionPage as GeneratedBinlogTransactionPage } from "../../bindings/BinlogTransactionPage";
import type { BinlogTransactionSummary as GeneratedBinlogTransactionSummary } from "../../bindings/BinlogTransactionSummary";

/** Rust-generated row-level operation contract. */
export type BinlogOperation = GeneratedBinlogOperation;

/** Rust-generated aggregate analysis contract. */
export type BinlogSummary = GeneratedBinlogSummary;

/** Rust-generated lossless binlog cell state. */
export type BinlogCellValue = BinlogCell;

/** Ordered column values from either side of one row mutation. */
export type BinlogRowImage = Record<string, BinlogCellValue>;

/** Rust-generated before/after row image contract. */
export type BinlogRowChange = GeneratedBinlogRowChange;

/** Rust-generated table change contract. */
export type BinlogTableChange = BinlogChange;

/** Rust-generated transaction timeline item. */
export type BinlogTransaction = GeneratedBinlogTransaction;

/** Rust-generated lightweight transaction timeline item. */
export type BinlogTransactionSummary = GeneratedBinlogTransactionSummary;

/** Rust-generated filter and cursor envelope. */
export type BinlogTransactionFilter = GeneratedBinlogTransactionFilter;

/** Rust-generated cursor page. */
export type BinlogTransactionPage = GeneratedBinlogTransactionPage;

/** Rust-generated reviewable Reset SQL and safety diagnostics. */
export type BinlogResetSql = GeneratedBinlogResetSql;

/** Progress fields streamed while files are read without loading them into browser memory. */
export type BinlogImportProgress = Omit<
  Extract<GeneratedBinlogImportEvent, { type: "progress" }>,
  "type" | "analysisId"
>;

/** Safe Rust application error returned through the Tauri channel. */
export type BinlogImportError = AppError;

/** Rust-generated ordered lifecycle events delivered by `binlog_start_import`. */
export type BinlogImportEvent = GeneratedBinlogImportEvent;
