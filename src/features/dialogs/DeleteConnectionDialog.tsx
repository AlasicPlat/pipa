import { AlertTriangle, Trash2 } from "lucide-react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { useDialogDismiss } from "./useDialogDismiss";

interface DeleteConnectionDialogProps {
  /** Profile awaiting deletion; the dialog is closed when this is null. */
  profile: ConnectionProfile | null;
  /** How many open workspaces would close along with the connection. */
  workspaceCount: number;
  /** Whether a query is still running on this connection, which blocks deletion. */
  blockedByRunningQuery: boolean;
  error: string | null;
  /** Whether deletion is in flight; blocks dismissal and re-submission. */
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirms permanent deletion of one saved connection.
 *
 * Deletion removes the encrypted credential and query history as well as the profile, so the dialog
 * enumerates the consequences. It refuses while a query is still running: deleting the credential
 * underneath a live query would fail confusingly rather than cleanly.
 *
 * @param props - Target profile, blocking conditions, and commit/cancel handlers.
 * @returns The confirmation dialog, or null when nothing is pending.
 * Side effects: none directly; the parent owns deletion.
 */
export function DeleteConnectionDialog({
  profile,
  workspaceCount,
  blockedByRunningQuery,
  error,
  deleting,
  onCancel,
  onConfirm,
}: DeleteConnectionDialogProps) {
  useDialogDismiss(profile !== null, deleting, onCancel);

  if (!profile) {
    return null;
  }

  return (
    <div
      className="destructive-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) {
          onCancel();
        }
      }}
    >
      <section
        aria-describedby="delete-connection-description"
        aria-labelledby="delete-connection-title"
        aria-modal="true"
        className="destructive-dialog"
        role="alertdialog"
      >
        <header>
          <span className="destructive-dialog__icon" aria-hidden="true">
            <AlertTriangle size={18} />
          </span>
          <span>
            <span className="eyebrow">PERMANENT ACTION</span>
            <h2 id="delete-connection-title">删除“{profile.name}”？</h2>
          </span>
        </header>
        <p id="delete-connection-description">
          将永久删除连接配置、加密凭据和查询历史
          {workspaceCount > 0 ? `，并关闭 ${workspaceCount} 个相关工作区` : ""}
          。未提交的表修改无法恢复。
        </p>
        <dl>
          <div><dt>类型</dt><dd>{profile.engine === "my_sql" ? "MySQL" : "Redis"}</dd></div>
          <div><dt>地址</dt><dd>{profile.host}:{profile.port}</dd></div>
        </dl>
        {blockedByRunningQuery ? (
          <p className="destructive-dialog__warning" role="status">
            此连接仍有查询运行。请先取消或等待查询完成。
          </p>
        ) : null}
        {error ? <p className="destructive-dialog__error" role="alert">{error}</p> : null}
        <footer>
          <button
            autoFocus
            className="button button--secondary"
            disabled={deleting}
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="button button--danger"
            disabled={deleting || blockedByRunningQuery}
            onClick={onConfirm}
            type="button"
          >
            <Trash2 size={14} aria-hidden="true" />
            {deleting
              ? "正在删除…"
              : profile.environment === "production" ? "永久删除生产连接" : "永久删除连接"}
          </button>
        </footer>
      </section>
    </div>
  );
}
