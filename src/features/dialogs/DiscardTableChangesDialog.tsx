import { AlertTriangle } from "lucide-react";
import { useDialogDismiss } from "./useDialogDismiss";

interface DiscardTableChangesDialogProps {
  /** Table whose workspace has uncommitted edits; the dialog is closed when this is null. */
  tableName: string | null;
  /** Returns to the workspace, keeping the local change set. */
  onCancel: () => void;
  /** Discards the local change set and closes the workspace. */
  onDiscard: () => void;
}

/**
 * Confirms closing a table workspace that still holds uncommitted DML or DDL.
 *
 * Cancel is focused and labelled "继续编辑": the safe path is staying, because the local change set
 * cannot be recovered once the workspace closes.
 *
 * @param props - Target table and the keep/discard handlers.
 * @returns The confirmation dialog, or null when no close is pending.
 * Side effects: none directly; the parent owns tab closure.
 */
export function DiscardTableChangesDialog({
  tableName,
  onCancel,
  onDiscard,
}: DiscardTableChangesDialogProps) {
  useDialogDismiss(tableName !== null, false, onCancel);

  if (tableName === null) {
    return null;
  }

  return (
    <div
      className="destructive-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <section
        aria-describedby="close-dirty-table-description"
        aria-labelledby="close-dirty-table-title"
        aria-modal="true"
        className="destructive-dialog"
        role="alertdialog"
      >
        <header>
          <span className="destructive-dialog__icon" aria-hidden="true">
            <AlertTriangle size={18} />
          </span>
          <span>
            <span className="eyebrow">UNCOMMITTED CHANGES</span>
            <h2 id="close-dirty-table-title">关闭“{tableName}”？</h2>
          </span>
        </header>
        <p id="close-dirty-table-description">
          此表工作区包含尚未提交的 DML 或 DDL。关闭后，本地变更集将无法恢复。
        </p>
        <footer>
          <button
            autoFocus
            className="button button--secondary"
            onClick={onCancel}
            type="button"
          >
            继续编辑
          </button>
          <button className="button button--danger" onClick={onDiscard} type="button">
            放弃修改并关闭
          </button>
        </footer>
      </section>
    </div>
  );
}
