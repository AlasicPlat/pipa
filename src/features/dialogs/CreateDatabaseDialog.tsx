import { DatabasePlus } from "lucide-react";
import { useState } from "react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { DATABASE_CHARSET_OPTIONS } from "../tables/tableSql";
import { useDialogDismiss } from "./useDialogDismiss";

/** Character set and collation chosen for a new schema; empty means "server default". */
export interface CreateDatabaseRequest {
  name: string;
  charset: string;
  collation: string;
}

interface CreateDatabaseDialogProps {
  /** Connection that will own the new schema; the dialog is closed when this is null. */
  profile: ConnectionProfile | null;
  error: string | null;
  /** Whether CREATE DATABASE is running; blocks dismissal and re-submission. */
  creating: boolean;
  onCancel: () => void;
  onConfirm: (request: CreateDatabaseRequest) => void;
}

/**
 * Creates one schema on a MySQL connection.
 *
 * The whole draft — name, charset, collation — is local. Previously each keystroke rewrote a
 * `pendingCreateDatabase` object in the app shell, so typing a schema name re-rendered the entire
 * workspace including the navigator and every open tab panel.
 *
 * @param props - Target connection, in-flight state, and commit/cancel handlers.
 * @returns The create-database dialog, or null when no connection is selected.
 * Side effects: none directly; the parent owns statement execution.
 */
export function CreateDatabaseDialog({
  profile,
  error,
  creating,
  onCancel,
  onConfirm,
}: CreateDatabaseDialogProps) {
  const [name, setName] = useState("");
  const [charset, setCharset] = useState("");
  const [collation, setCollation] = useState("");
  useDialogDismiss(profile !== null, creating, onCancel);

  if (!profile) {
    return null;
  }

  const collations = DATABASE_CHARSET_OPTIONS
    .find((option) => option.charset === charset)
    ?.collations ?? [];
  const submittable = !creating && name.trim().length > 0;

  /** Commits the draft when a name is present and no statement is running. */
  function submit(): void {
    if (submittable) {
      onConfirm({ name, charset, collation });
    }
  }

  return (
    <div
      className="destructive-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !creating) {
          onCancel();
        }
      }}
    >
      <section
        aria-labelledby="create-database-title"
        aria-modal="true"
        className="destructive-dialog connection-action-dialog"
        role="dialog"
      >
        <header>
          <span className="connection-action-dialog__icon" aria-hidden="true">
            <DatabasePlus size={17} />
          </span>
          <span>
            <span className="eyebrow">CREATE DATABASE</span>
            <h2 id="create-database-title">新建数据库</h2>
          </span>
        </header>
        <dl>
          <div><dt>连接</dt><dd>{profile.name}</dd></div>
          <div>
            <dt>地址</dt>
            <dd>{profile.host}:{profile.port}</dd>
          </div>
        </dl>
        <label className="connection-action-dialog__field">
          <span>数据库名</span>
          <input
            autoFocus
            disabled={creating}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            value={name}
          />
        </label>
        <label className="connection-action-dialog__field">
          <span>字符集</span>
          <select
            disabled={creating}
            onChange={(event) => {
              // A new charset invalidates the previous collation, which belonged to the old set.
              setCharset(event.target.value);
              setCollation("");
            }}
            value={charset}
          >
            <option value="">服务器默认</option>
            {DATABASE_CHARSET_OPTIONS.map((option) => (
              <option key={option.charset} value={option.charset}>{option.charset}</option>
            ))}
          </select>
        </label>
        {charset ? (
          <label className="connection-action-dialog__field">
            <span>排序规则</span>
            <select
              disabled={creating}
              onChange={(event) => setCollation(event.target.value)}
              value={collation}
            >
              <option value="">字符集默认</option>
              {collations.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        ) : null}
        <p>
          将在此连接上执行 CREATE DATABASE。侧边栏只展示连接的默认数据库，新库需要把连接的默认数据库改成它才能浏览。
        </p>
        {error ? <p className="destructive-dialog__error" role="alert">{error}</p> : null}
        <footer>
          <button
            className="button button--secondary"
            disabled={creating}
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
            {creating ? "正在创建…" : "创建数据库"}
          </button>
        </footer>
      </section>
    </div>
  );
}
