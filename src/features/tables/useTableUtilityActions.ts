import { useCallback, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { TableDdlPreviewState } from "../dialogs/TableDdlPreviewDialog";
import type { TableQuickAction } from "./TableActionMenu";
import { createDetachedWorkspaceWindow } from "../workspace/detachedWorkspace";
import { downloadTextFile } from "../query/resultExport";
import { executeQueryOnce } from "../query/executeQueryOnce";
import { getConnectionActionError } from "../connections/connectionErrors";
import {
  buildDetachedTableDescriptor,
  buildSelectAllStatement,
  buildShowCreateTableStatement,
  buildTableExportFile,
  extractCreateTableSql,
} from "./tableActions";

/** One of the export formats offered by the shared table menu. */
type TableExportAction = Extract<TableQuickAction, "export_csv" | "export_json" | "export_sql">;

/** Shell collaborators the read-only table actions need. */
export interface TableUtilityActionsOptions {
  /** Clears the shell's error toast before an action starts. */
  clearError: () => void;
  /** Reports a recoverable failure through the shell's error toast. */
  showError: (message: string) => void;
  /** Reports progress or completion through the shell's notice toast. */
  showNotice: (message: string) => void;
  /** Opens one table in the current window, used as the non-desktop fallback. */
  openTableInCurrentWindow: (connectionId: string, database: string, tableName: string) => void;
}

/** The read-only table actions plus the DDL preview they populate. */
export interface TableUtilityActions {
  /** Whether one long-running action (export or DDL read) is in flight. */
  running: boolean;
  /** Current DDL preview, or `null` when the dialog is closed. */
  ddlPreview: TableDdlPreviewState | null;
  /** Closes the DDL preview dialog. */
  closeDdlPreview: () => void;
  /** Copies arbitrary table metadata, reporting one visible result either way. */
  copyText: (text: string, successMessage: string) => Promise<void>;
  /** Loads and copies the server-authored CREATE TABLE statement. */
  copyCreateTable: (profile: ConnectionProfile, database: string, tableName: string) => Promise<void>;
  /** Reads the whole table and saves it in the chosen format. */
  exportTable: (
    profile: ConnectionProfile,
    database: string,
    tableName: string,
    action: TableExportAction,
  ) => Promise<void>;
  /** Opens one table in a separate native window, falling back to the current one. */
  openInNewWindow: (profile: ConnectionProfile, database: string, tableName: string) => Promise<void>;
  /** Loads the server-authored CREATE TABLE statement into the preview dialog. */
  showCreateTable: (profile: ConnectionProfile, database: string, tableName: string) => Promise<void>;
}

/**
 * Owns the table actions that only read: clipboard copies, exports, the DDL preview, and detaching
 * a table into its own window.
 *
 * Every action reports through the shell's toasts rather than throwing, because they are invoked
 * from menus where there is nowhere to surface a rejected promise. Destructive actions (truncate,
 * drop, rename, duplicate) are deliberately not here; they need typed confirmation first.
 * @param options - Shell collaborators for feedback and same-window fallback.
 * @returns The actions and the state they drive.
 */
export function useTableUtilityActions(
  options: TableUtilityActionsOptions,
): TableUtilityActions {
  const { clearError, openTableInCurrentWindow, showError, showNotice } = options;
  const [running, setRunning] = useState(false);
  const [ddlPreview, setDdlPreview] = useState<TableDdlPreviewState | null>(null);

  const copyText = useCallback(async (text: string, successMessage: string): Promise<void> => {
    try {
      await writeText(text);
      showNotice(successMessage);
    } catch (error: unknown) {
      showError(getConnectionActionError(error, "复制失败，请检查系统剪贴板权限。"));
    }
  }, [showError, showNotice]);

  /** Fetches the server-authored CREATE TABLE statement for one exact MySQL table. */
  const loadCreateTableSql = useCallback(async (
    connectionId: string,
    database: string,
    tableName: string,
  ): Promise<string> => {
    const result = await executeQueryOnce(
      connectionId,
      buildShowCreateTableStatement(database, tableName),
    );
    return extractCreateTableSql(result);
  }, []);

  const openInNewWindow = useCallback(async (
    profile: ConnectionProfile,
    database: string,
    tableName: string,
  ): Promise<void> => {
    if (!isTauri()) {
      openTableInCurrentWindow(profile.id, database, tableName);
      showNotice("当前环境不支持独立窗口，已在当前窗口打开表。");
      return;
    }
    try {
      await createDetachedWorkspaceWindow(
        buildDetachedTableDescriptor(profile, database, tableName),
        { x: window.screenX + 140, y: window.screenY + 90 },
      );
      showNotice(`已在新窗口中打开表“${tableName}”。`);
    } catch (error: unknown) {
      showError(getConnectionActionError(error, "无法打开独立表窗口，请重试。"));
    }
  }, [openTableInCurrentWindow, showError, showNotice]);

  const exportTable = useCallback(async (
    profile: ConnectionProfile,
    database: string,
    tableName: string,
    action: TableExportAction,
  ): Promise<void> => {
    if (!database || running) {
      return;
    }
    setRunning(true);
    clearError();
    showNotice(`正在导出表“${tableName}”…`);
    try {
      const result = await executeQueryOnce(
        profile.id,
        buildSelectAllStatement(database, tableName),
      );
      const exportFile = buildTableExportFile(action, database, tableName, result);
      const outcome = await downloadTextFile(
        exportFile.content,
        exportFile.fileName,
        exportFile.mimeType,
      );
      showNotice(outcome === "saved"
        ? `已导出 ${exportFile.label} · ${result.rows.length} 行。`
        : outcome === "cancelled" ? "已取消导出。" : "导出失败，请重试。");
    } catch (error: unknown) {
      showError(getConnectionActionError(error, "无法读取或导出该表，请重试。"));
    } finally {
      setRunning(false);
    }
  }, [clearError, running, showError, showNotice]);

  const showCreateTable = useCallback(async (
    profile: ConnectionProfile,
    database: string,
    tableName: string,
  ): Promise<void> => {
    if (!database) {
      return;
    }
    setDdlPreview({ connectionId: profile.id, tableName, loading: true, sql: "", error: null });
    /*
     * Each update re-checks that the preview still targets this table, because the user can request
     * another one while this query is still running.
     */
    try {
      const sql = await loadCreateTableSql(profile.id, database, tableName);
      setDdlPreview((current) => current?.connectionId === profile.id
          && current.tableName === tableName
        ? { ...current, loading: false, sql }
        : current);
    } catch (error: unknown) {
      setDdlPreview((current) => current?.connectionId === profile.id
          && current.tableName === tableName
        ? {
          ...current,
          loading: false,
          error: getConnectionActionError(error, "无法读取 CREATE TABLE 语法。"),
        }
        : current);
    }
  }, [loadCreateTableSql]);

  const copyCreateTable = useCallback(async (
    profile: ConnectionProfile,
    database: string,
    tableName: string,
  ): Promise<void> => {
    if (!database || running) {
      return;
    }
    setRunning(true);
    try {
      const sql = await loadCreateTableSql(profile.id, database, tableName);
      await copyText(sql, `已复制表“${tableName}”的 CREATE TABLE 语法。`);
    } catch (error: unknown) {
      showError(getConnectionActionError(error, "无法读取 CREATE TABLE 语法。"));
    } finally {
      setRunning(false);
    }
  }, [copyText, loadCreateTableSql, running, showError]);

  const closeDdlPreview = useCallback((): void => setDdlPreview(null), []);

  return {
    running,
    ddlPreview,
    closeDdlPreview,
    copyText,
    copyCreateTable,
    exportTable,
    openInNewWindow,
    showCreateTable,
  };
}
