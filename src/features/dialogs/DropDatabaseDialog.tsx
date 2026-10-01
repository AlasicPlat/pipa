import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { useDialogDismiss } from "./useDialogDismiss";

interface DropDatabaseDialogProps {
  /** Connection that owns the schema; the dialog is closed when this is null. */
  profile: ConnectionProfile | null;
  /** Exact schema name to drop, which the user must retype to confirm. */
  database: string | null;
  error: string | null;
  /** Whether DROP DATABASE is running; blocks dismissal and re-submission. */
  dropping: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Permanently drops one schema after the user retypes its name.
 *
 * The typed confirmation is local state. It is compared against the exact schema name rather than a
 * trimmed or lowercased form, because this is the only guard before an irreversible statement.
 *
 * @param props - Target connection and schema, in-flight state, and commit/cancel handlers.
 * @returns The drop-database dialog, or null when no schema is selected.
 * Side effects: none directly; the parent owns statement execution.
 */
export function DropDatabaseDialog({
  profile,
  database,
  error,
  dropping,
  onCancel,
  onConfirm,
}: DropDatabaseDialogProps) {
  const [confirmation, setConfirmation] = useState("");
  const open = profile !== null && database !== null;
  useDialogDismiss(open, dropping, onCancel);

  if (!open) {
    return null;
  }

  const submittable = !dropping && confirmation === database;

  /** Runs the drop only when the retyped name matches exactly. */
  function submit(): void {
    if (submittable) {
      onConfirm();
    }
  }

  return (
    <div
      className="destructive-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !dropping) {
          onCancel();
        }
      }}
    >
      <section
        aria-labelledby="drop-database-title"
        aria-modal="true"
        className="destructive-dialog"
        role="dialog"
      >
        <header>
          <span className="destructive-dialog__icon" aria-hidden="true">
            <AlertTriangle size={17} />
          </span>
          <span>
            <span className="eyebrow">DROP DATABASE</span>
            <h2 id="drop-database-title">删除数据库</h2>
          </span>
        </header>
        <dl>
          <div><dt>连接</dt><dd>{profile.name}</dd></div>
          <div><dt>数据库</dt><dd>{database}</dd></div>
        </dl>
        <p className="destructive-dialog__warning">
          这会永久删除该数据库及其中所有表和数据，无法撤销。
        </p>
        <label className="connection-action-dialog__field">
          <span>请输入 {database} 以确认</span>
          <input
            autoFocus
            disabled={dropping}
            onChange={(event) => setConfirmation(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            value={confirmation}
          />
        </label>
        {error ? <p className="destructive-dialog__error" role="alert">{error}</p> : null}
        <footer>
          <button
            className="button button--secondary"
            disabled={dropping}
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="button button--danger"
            disabled={!submittable}
            onClick={submit}
            type="button"
          >
            {dropping ? "正在删除…" : "永久删除"}
          </button>
        </footer>
      </section>
    </div>
  );
}
