import { Braces, Copy } from "lucide-react";
import { SelectableSqlBlock } from "../tables/SelectableSqlBlock";
import { useDialogDismiss } from "./useDialogDismiss";

export interface TableDdlPreviewState {
  connectionId: string;
  error: string | null;
  loading: boolean;
  sql: string;
  tableName: string;
}

interface TableDdlPreviewDialogProps {
  /** Loaded or loading DDL; the dialog is closed when this is null. */
  preview: TableDdlPreviewState | null;
  onClose: () => void;
  onCopy: (sql: string, successMessage: string) => void;
}

/**
 * Shows the server-authored `CREATE TABLE` statement for one table.
 *
 * Read-only, so it holds no state and stays dismissable even while loading — there is nothing in
 * flight that a dismissal could hide.
 *
 * @param props - Preview state and the close/copy handlers.
 * @returns The preview dialog, or null when nothing is being previewed.
 * Side effects: none directly; the parent owns clipboard access.
 */
export function TableDdlPreviewDialog({ preview, onClose, onCopy }: TableDdlPreviewDialogProps) {
  useDialogDismiss(preview !== null, false, onClose);

  if (!preview) {
    return null;
  }

  return (
    <div
      className="destructive-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        aria-labelledby="table-ddl-preview-title"
        aria-modal="true"
        className="destructive-dialog connection-action-dialog table-ddl-dialog"
        role="dialog"
      >
        <header>
          <span className="connection-action-dialog__icon" aria-hidden="true">
            <Braces size={17} />
          </span>
          <span>
            <span className="eyebrow">SHOW CREATE TABLE</span>
            <h2 id="table-ddl-preview-title">{preview.tableName}</h2>
          </span>
        </header>
        <div className="table-ddl-dialog__body">
          {preview.loading ? (
            <p className="panel-status">正在读取 CREATE TABLE 语法…</p>
          ) : preview.error ? (
            <p className="destructive-dialog__error" role="alert">{preview.error}</p>
          ) : (
            <SelectableSqlBlock
              ariaLabel={`${preview.tableName} CREATE TABLE 语法`}
              value={preview.sql}
            />
          )}
        </div>
        <footer>
          <button className="button button--secondary" onClick={onClose} type="button">
            关闭
          </button>
          <button
            className="button button--primary"
            disabled={!preview.sql}
            onClick={() => onCopy(
              preview.sql,
              `已复制表“${preview.tableName}”的 CREATE TABLE 语法。`,
            )}
            type="button"
          >
            <Copy size={14} aria-hidden="true" />
            复制语法
          </button>
        </footer>
      </section>
    </div>
  );
}
