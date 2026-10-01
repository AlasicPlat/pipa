import { Pencil } from "lucide-react";
import { useState } from "react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { useDialogDismiss } from "./useDialogDismiss";

interface RenameConnectionDialogProps {
  /** Profile being renamed; the dialog is closed when this is null. */
  profile: ConnectionProfile | null;
  /** Error reported by the last save attempt. */
  error: string | null;
  /** Whether a save is in flight; blocks dismissal and re-submission. */
  saving: boolean;
  onCancel: () => void;
  /** Commits the trimmed name. The parent owns the request and its error reporting. */
  onConfirm: (name: string) => void;
}

/**
 * Renames one saved connection.
 *
 * The draft name lives here rather than in the app shell: it changes on every keystroke and nothing
 * outside this dialog reads it, so keeping it local stops each character from re-rendering the whole
 * workspace.
 *
 * @param props - Target profile, in-flight state, and commit/cancel handlers.
 * @returns The rename dialog, or null when no profile is selected.
 * Side effects: none directly; handlers are owned by the parent.
 */
export function RenameConnectionDialog({
  profile,
  error,
  saving,
  onCancel,
  onConfirm,
}: RenameConnectionDialogProps) {
  const [draft, setDraft] = useState(profile?.name ?? "");
  // Remounting per profile keeps the draft in step with the target without a synchronizing effect.
  useDialogDismiss(profile !== null, saving, onCancel);

  if (!profile) {
    return null;
  }

  const submittable = !saving && draft.trim().length > 0;

  /** Commits the rename when the draft is non-empty and no save is running. */
  function submit(): void {
    if (submittable) {
      onConfirm(draft);
    }
  }

  return (
    <div
      className="destructive-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) {
          onCancel();
        }
      }}
    >
      <section
        aria-labelledby="rename-connection-title"
        aria-modal="true"
        className="destructive-dialog connection-action-dialog"
        role="dialog"
      >
        <header>
          <span className="connection-action-dialog__icon" aria-hidden="true">
            <Pencil size={17} />
          </span>
          <span>
            <span className="eyebrow">CONNECTION NAME</span>
            <h2 id="rename-connection-title">重命名连接</h2>
          </span>
        </header>
        <label className="connection-action-dialog__field">
          <span>连接名称</span>
          <input
            autoFocus
            disabled={saving}
            maxLength={120}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            value={draft}
          />
        </label>
        {error ? <p className="destructive-dialog__error" role="alert">{error}</p> : null}
        <footer>
          <button
            className="button button--secondary"
            disabled={saving}
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="button button--primary"
            disabled={!submittable}
            onClick={submit}
            type="button"
          >
            {saving ? "正在保存…" : "保存名称"}
          </button>
        </footer>
      </section>
    </div>
  );
}
