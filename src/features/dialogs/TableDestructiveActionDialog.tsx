import { AlertTriangle, Trash2 } from "lucide-react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { useDialogDismiss } from "./useDialogDismiss";

/** Which irreversible statement is awaiting confirmation. */
export type TableDestructiveActionKind = "drop" | "truncate";

interface TableDestructiveActionDialogProps {
  /** Statement awaiting confirmation; the dialog is closed when this is null. */
  action: TableDestructiveActionKind | null;
  /** Connection that owns the table. */
  profile: ConnectionProfile | null;
  tableName: string | null;
  /** Whether the table has uncommitted local edits that the statement would discard. */
  hasDirtyWorkspace: boolean;
  error: string | null;
  /** Whether the statement is running; blocks dismissal and re-submission. */
  executing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirms `DROP TABLE` or `TRUNCATE TABLE` before it runs.
 *
 * Uses `alertdialog` rather than `dialog`, and focuses Cancel rather than the destructive action, so
 * a stray Enter cannot destroy data. Both statements are irreversible, so the dialog states what will
 * be lost — including uncommitted local edits when the table has any.
 *
 * @param props - Statement, target table, dirty-state warning, and commit/cancel handlers.
 * @returns The confirmation dialog, or null when nothing is pending.
 * Side effects: none directly; the parent owns statement execution.
 */
export function TableDestructiveActionDialog({
  action,
  profile,
  tableName,
  hasDirtyWorkspace,
  error,
  executing,
  onCancel,
  onConfirm,
}: TableDestructiveActionDialogProps) {
  const open = action !== null && profile !== null && tableName !== null;
  useDialogDismiss(open, executing, onCancel);

  if (!open) {
    return null;
  }

  const isDrop = action === "drop";

  return (
    <div
      className="destructive-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !executing) {
          onCancel();
        }
      }}
    >
      <section
        aria-describedby="table-action-description"
        aria-labelledby="table-action-title"
        aria-modal="true"
        className="destructive-dialog"
        role="alertdialog"
      >
        <header>
          <span className="destructive-dialog__icon" aria-hidden="true">
            <AlertTriangle size={18} />
          </span>
          <span>
            <span className="eyebrow">DESTRUCTIVE SQL</span>
            <h2 id="table-action-title">
              {isDrop ? `删除表“${tableName}”？` : `清空“${tableName}”的全部数据？`}
            </h2>
          </span>
        </header>
        <p id="table-action-description">
          {isDrop
            ? "DROP TABLE 会永久删除表结构及全部数据，无法撤销。"
            : "TRUNCATE TABLE 会永久删除全部行并重置自增计数，无法撤销。"}
          {hasDirtyWorkspace
            ? " 此表还有未提交的本地修改；执行成功后工作区会关闭，这些修改也会丢失。"
            : " 执行成功后会关闭已打开的表工作区，避免继续显示旧数据。"}
        </p>
        <dl>
          <div><dt>连接</dt><dd>{profile.name}</dd></div>
          <div><dt>数据库</dt><dd>{profile.database}</dd></div>
          <div>
            <dt>SQL</dt>
            <dd>{isDrop ? "DROP TABLE" : "TRUNCATE TABLE"}</dd>
          </div>
        </dl>
        {error ? <p className="destructive-dialog__error" role="alert">{error}</p> : null}
        <footer>
          <button
            autoFocus
            className="button button--secondary"
            disabled={executing}
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="button button--danger"
            disabled={executing}
            onClick={onConfirm}
            type="button"
          >
            <Trash2 size={14} aria-hidden="true" />
            {executing ? "正在执行…" : isDrop ? "永久删除表" : "清空全部数据"}
          </button>
        </footer>
      </section>
    </div>
  );
}
