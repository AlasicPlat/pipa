import { Copy, Pencil } from "lucide-react";
import { useState } from "react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { useDialogDismiss } from "./useDialogDismiss";

/** Which identifier-changing operation the dialog is collecting a destination name for. */
export type TableNameActionKind = "rename" | "duplicate";

export interface TableNameActionRequest {
  /** Destination table name, untrimmed; the parent validates and trims it. */
  tableName: string;
  /** Whether a duplicate should copy rows as well as structure; ignored when renaming. */
  copyData: boolean;
}

interface TableNameActionDialogProps {
  /** Operation being collected; the dialog is closed when this is null. */
  action: TableNameActionKind | null;
  /** Connection that owns the source table. */
  profile: ConnectionProfile | null;
  /** Exact source table name. */
  tableName: string | null;
  /** Whether the source table has uncommitted local edits, which blocks renaming. */
  hasDirtyWorkspace: boolean;
  error: string | null;
  /** Whether the statement is running; blocks dismissal and re-submission. */
  executing: boolean;
  onCancel: () => void;
  onConfirm: (request: TableNameActionRequest) => void;
}

/**
 * Collects the destination name for renaming or duplicating one table.
 *
 * The destination name and the copy-data choice are local. The initial value differs per operation —
 * a rename starts from the current name, a duplicate from `<name>_copy` — so the parent remounts this
 * component per target rather than synchronizing a draft downward.
 *
 * @param props - Operation, source table, dirty-state guard, and commit/cancel handlers.
 * @returns The dialog, or null when no operation is pending.
 * Side effects: none directly; the parent owns statement execution.
 */
export function TableNameActionDialog({
  action,
  profile,
  tableName,
  hasDirtyWorkspace,
  error,
  executing,
  onCancel,
  onConfirm,
}: TableNameActionDialogProps) {
  const [draft, setDraft] = useState(
    action === "duplicate" && tableName ? `${tableName}_copy` : tableName ?? "",
  );
  const [copyData, setCopyData] = useState(true);
  const open = action !== null && profile !== null && tableName !== null;
  useDialogDismiss(open, executing, onCancel);

  if (!open) {
    return null;
  }

  const isRename = action === "rename";
  const submittable = !executing && draft.trim().length > 0;

  /** Commits the destination name when it is non-empty and no statement is running. */
  function submit(): void {
    if (submittable) {
      onConfirm({ tableName: draft, copyData });
    }
  }

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
        aria-labelledby="table-name-action-title"
        aria-modal="true"
        className="destructive-dialog connection-action-dialog"
        role="dialog"
      >
        <header>
          <span className="connection-action-dialog__icon" aria-hidden="true">
            {isRename ? <Pencil size={17} /> : <Copy size={17} />}
          </span>
          <span>
            <span className="eyebrow">TABLE OPERATION</span>
            <h2 id="table-name-action-title">{isRename ? "重命名表" : "复制表"}</h2>
          </span>
        </header>
        <dl>
          <div><dt>连接</dt><dd>{profile.name}</dd></div>
          <div><dt>原表</dt><dd>{tableName}</dd></div>
        </dl>
        <label className="connection-action-dialog__field">
          <span>{isRename ? "新表名" : "复制为"}</span>
          <input
            autoFocus
            disabled={executing}
            maxLength={64}
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
        {isRename ? null : (
          <label className="table-copy-option">
            <input
              checked={copyData}
              disabled={executing}
              onChange={(event) => setCopyData(event.target.checked)}
              type="checkbox"
            />
            同时复制表数据
          </label>
        )}
        {hasDirtyWorkspace ? (
          <p className="destructive-dialog__warning">
            该表有未提交的本地修改；请先提交或撤销后再重命名。
          </p>
        ) : null}
        {error ? <p className="destructive-dialog__error" role="alert">{error}</p> : null}
        <footer>
          <button
            className="button button--secondary"
            disabled={executing}
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
            {executing ? "正在执行…" : isRename ? "保存新表名" : "开始复制"}
          </button>
        </footer>
      </section>
    </div>
  );
}
