import {
  Bookmark,
  Check,
  FileCode2,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Engine } from "../../bindings/Engine";
import {
  deleteCommonSql,
  deleteSqlFolder,
  loadSqlLibrary,
  saveCommonSql,
  saveSqlFolder,
} from "../../lib/tauriClient";
import type { CommonSql, SqlFolder, SqlLibrary } from "./types";

interface SqlLibraryDialogProps {
  currentSql: string;
  engine: Engine;
  onApply: (sql: string) => void;
  onClose: () => void;
}

interface EntryDraft {
  id: string;
  name: string;
  folderId: string;
  sqlText: string;
}

const EMPTY_LIBRARY: SqlLibrary = { folders: [], entries: [] };

/** Returns the compact user-visible label for one persisted engine. */
function engineLabel(engine: Engine): string {
  return {
    my_sql: "MySQL",
    postgre_sql: "PostgreSQL",
    mongo_db: "MongoDB",
    redis: "Redis",
  }[engine];
}

/** Extracts a safe actionable message from an unknown Tauri rejection. */
function libraryErrorMessage(error: unknown): string {
  if (
    typeof error === "object"
    && error !== null
    && "message" in error
    && typeof error.message === "string"
  ) {
    return error.message;
  }
  return "常用 SQL 操作失败，请重试。";
}

/** Logs one safe operation context and returns the same message for inline recovery UI. */
function reportLibraryError(action: string, error: unknown): string {
  const message = libraryErrorMessage(error);
  console.error(`Pipa common SQL ${action} failed`, message);
  return message;
}

/** Inserts or replaces one identified library object without mutating prior state. */
function upsertById<T extends { id: string }>(items: readonly T[], nextItem: T): T[] {
  return items.some((item) => item.id === nextItem.id)
    ? items.map((item) => item.id === nextItem.id ? nextItem : item)
    : [...items, nextItem];
}

/** Produces a compact single-line SQL preview for the library list. */
function sqlPreview(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

/**
 * Renders the engine-scoped reusable SQL collection and its directory controls.
 * @param props - Current editor text, immutable engine, and close/apply callbacks.
 * @returns An accessible modal library manager.
 * Side effects: loads and mutates encrypted local SQL-library persistence through Tauri.
 */
export function SqlLibraryDialog({ currentSql, engine, onApply, onClose }: SqlLibraryDialogProps) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [library, setLibrary] = useState<SqlLibrary>(EMPTY_LIBRARY);
  const [selectedFolder, setSelectedFolder] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [folderDraft, setFolderDraft] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [entryDraft, setEntryDraft] = useState<EntryDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const visibleEntries = useMemo(() => library.entries.filter((entry) => {
    const matchesFolder = selectedFolder === "all"
      || (selectedFolder === "uncategorized" ? entry.folderId === null : entry.folderId === selectedFolder);
    const matchesSearch = !normalizedSearch
      || `${entry.name}\n${entry.sqlText}`.toLocaleLowerCase().includes(normalizedSearch);
    return matchesFolder && matchesSearch;
  }), [library.entries, normalizedSearch, selectedFolder]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void loadSqlLibrary(engine)
      .then((snapshot) => {
        if (active) setLibrary(snapshot);
      })
      .catch((loadError: unknown) => {
        if (active) setError(reportLibraryError("load", loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [engine]);

  useEffect(() => {
    /** Closes an editor first, then the modal, when Escape is pressed. */
    function handleEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      if (entryDraft) {
        setEntryDraft(null);
      } else {
        onClose();
      }
    }
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [busy, entryDraft, onClose]);

  /** Opens the inline directory editor for a new directory. */
  function startNewFolder(): void {
    setEditingFolderId(null);
    setFolderDraft("");
    window.requestAnimationFrame(() => folderInputRef.current?.focus());
  }

  /** Opens the inline directory editor with one existing directory name. */
  function startRenameFolder(folder: SqlFolder): void {
    setEditingFolderId(folder.id);
    setFolderDraft(folder.name);
    window.requestAnimationFrame(() => folderInputRef.current?.focus());
  }

  /** Persists one new or renamed directory and keeps the local snapshot ordered. */
  async function handleSaveFolder(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!folderDraft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const folder = await saveSqlFolder({
        id: editingFolderId ?? crypto.randomUUID(),
        engine,
        name: folderDraft,
      });
      setLibrary((current) => ({
        ...current,
        folders: upsertById(current.folders, folder)
          .sort((left, right) => left.name.localeCompare(right.name)),
      }));
      setSelectedFolder(folder.id);
      setEditingFolderId(null);
      setFolderDraft("");
    } catch (saveError: unknown) {
      setError(reportLibraryError("directory save", saveError));
    } finally {
      setBusy(false);
    }
  }

  /** Deletes one directory after confirmation and retains its entries as uncategorized. */
  async function handleDeleteFolder(folder: SqlFolder): Promise<void> {
    if (busy || !window.confirm(`删除目录“${folder.name}”？目录内的 SQL 会移到“未分类”。`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSqlFolder(folder.id);
      setLibrary((current) => ({
        folders: current.folders.filter((item) => item.id !== folder.id),
        entries: current.entries.map((entry) => entry.folderId === folder.id
          ? { ...entry, folderId: null }
          : entry),
      }));
      setEntryDraft((current) => current?.folderId === folder.id
        ? { ...current, folderId: "" }
        : current);
      if (selectedFolder === folder.id) setSelectedFolder("uncategorized");
    } catch (deleteError: unknown) {
      setError(reportLibraryError("directory delete", deleteError));
    } finally {
      setBusy(false);
    }
  }

  /** Opens a new entry draft prefilled with the active editor contents and directory. */
  function startNewEntry(): void {
    setEntryDraft({
      id: crypto.randomUUID(),
      name: "",
      folderId: selectedFolder !== "all" && selectedFolder !== "uncategorized" ? selectedFolder : "",
      sqlText: currentSql,
    });
    setError(null);
  }

  /** Opens one existing reusable statement for editing or directory reassignment. */
  function startEditEntry(entry: CommonSql): void {
    setEntryDraft({
      id: entry.id,
      name: entry.name,
      folderId: entry.folderId ?? "",
      sqlText: entry.sqlText,
    });
    setError(null);
  }

  /** Persists the current reusable statement draft and returns to the filtered list. */
  async function handleSaveEntry(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!entryDraft?.name.trim() || !entryDraft.sqlText.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const entry = await saveCommonSql({
        id: entryDraft.id,
        engine,
        folderId: entryDraft.folderId || null,
        name: entryDraft.name,
        sqlText: entryDraft.sqlText,
      });
      setLibrary((current) => ({
        ...current,
        entries: [
          entry,
          ...current.entries.filter((item) => item.id !== entry.id),
        ],
      }));
      setEntryDraft(null);
    } catch (saveError: unknown) {
      setError(reportLibraryError("entry save", saveError));
    } finally {
      setBusy(false);
    }
  }

  /** Inserts a straight double quote so macOS smart punctuation cannot alter code syntax. */
  function handleSqlQuoteKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (!entryDraft || !['"', "“", "”"].includes(event.key) || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const textarea = event.currentTarget;
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const sqlText = `${entryDraft.sqlText.slice(0, selectionStart)}"${entryDraft.sqlText.slice(selectionEnd)}`;
    setEntryDraft({ ...entryDraft, sqlText });
    window.requestAnimationFrame(() => {
      textarea.setSelectionRange(selectionStart + 1, selectionStart + 1);
    });
  }

  /** Deletes one reusable statement after explicit confirmation. */
  async function handleDeleteEntry(entry: CommonSql): Promise<void> {
    if (busy || !window.confirm(`删除常用 SQL“${entry.name}”？此操作无法撤销。`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteCommonSql(entry.id);
      setLibrary((current) => ({
        ...current,
        entries: current.entries.filter((item) => item.id !== entry.id),
      }));
    } catch (deleteError: unknown) {
      setError(reportLibraryError("entry delete", deleteError));
    } finally {
      setBusy(false);
    }
  }

  /** Replaces the active editor with one deliberately selected reusable statement. */
  function handleApply(entry: CommonSql): void {
    onApply(entry.sqlText);
    onClose();
  }

  /** Applies a double-clicked entry while leaving its explicit action buttons independent. */
  function handleEntryDoubleClick(event: ReactMouseEvent<HTMLElement>, entry: CommonSql): void {
    if (event.target instanceof Element && event.target.closest("button")) return;
    handleApply(entry);
  }

  return (
    <div
      className="sql-library-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section aria-labelledby="sql-library-title" aria-modal="true" className="sql-library" role="dialog">
        <header className="sql-library__header">
          <span className="sql-library__heading-icon" aria-hidden="true"><Bookmark size={18} /></span>
          <span>
            <span className="eyebrow">{engineLabel(engine)} COLLECTION</span>
            <h2 id="sql-library-title">常用 SQL</h2>
          </span>
          <button aria-label="关闭常用 SQL" disabled={busy} onClick={onClose} type="button">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="sql-library__body">
          <aside className="sql-library__folders" aria-label="常用 SQL 目录">
            <div className="sql-library__section-title">
              <span>目录</span>
              <button aria-label="新建目录" onClick={startNewFolder} title="新建目录" type="button">
                <FolderPlus size={14} aria-hidden="true" />
              </button>
            </div>
            <button
              className={selectedFolder === "all" ? "is-selected" : ""}
              onClick={() => setSelectedFolder("all")}
              type="button"
            >
              <Bookmark size={13} aria-hidden="true" />
              <span>全部</span>
              <small>{library.entries.length}</small>
            </button>
            <button
              className={selectedFolder === "uncategorized" ? "is-selected" : ""}
              onClick={() => setSelectedFolder("uncategorized")}
              type="button"
            >
              <Folder size={13} aria-hidden="true" />
              <span>未分类</span>
              <small>{library.entries.filter((entry) => entry.folderId === null).length}</small>
            </button>
            <div className="sql-library__folder-list">
              {library.folders.map((folder) => (
                <div className={selectedFolder === folder.id ? "is-selected" : ""} key={folder.id}>
                  <button onClick={() => setSelectedFolder(folder.id)} type="button">
                    <Folder size={13} aria-hidden="true" />
                    <span>{folder.name}</span>
                    <small>{library.entries.filter((entry) => entry.folderId === folder.id).length}</small>
                  </button>
                  <span className="sql-library__folder-actions">
                    <button aria-label={`重命名目录 ${folder.name}`} onClick={() => startRenameFolder(folder)} type="button">
                      <Pencil size={11} aria-hidden="true" />
                    </button>
                    <button aria-label={`删除目录 ${folder.name}`} onClick={() => void handleDeleteFolder(folder)} type="button">
                      <Trash2 size={11} aria-hidden="true" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
            <form className="sql-library__folder-form" onSubmit={(event) => void handleSaveFolder(event)}>
              <label>
                <span className="sr-only">{editingFolderId ? "重命名目录" : "新目录名称"}</span>
                <input
                  aria-label={editingFolderId ? "重命名目录" : "新目录名称"}
                  maxLength={120}
                  onChange={(event) => setFolderDraft(event.target.value)}
                  placeholder={editingFolderId ? "输入新名称" : "新目录名称"}
                  ref={folderInputRef}
                  value={folderDraft}
                />
              </label>
              <button aria-label="保存目录" disabled={busy || !folderDraft.trim()} type="submit">
                <Check size={12} aria-hidden="true" />
              </button>
            </form>
          </aside>

          <main className="sql-library__content">
            <div className="sql-library__toolbar">
              <label>
                <Search size={13} aria-hidden="true" />
                <input
                  autoFocus
                  aria-label="搜索常用 SQL"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="搜索名称或 SQL 内容"
                  type="search"
                  value={searchQuery}
                />
              </label>
              <button disabled={!currentSql.trim() || busy} onClick={startNewEntry} type="button">
                <Plus size={13} aria-hidden="true" />
                保存当前 SQL
              </button>
            </div>
            {error ? <p className="sql-library__error" role="alert">{error}</p> : null}

            {entryDraft ? (
              <form className="sql-library__entry-form" onSubmit={(event) => void handleSaveEntry(event)}>
                <div className="sql-library__form-row">
                  <label>
                    <span>名称</span>
                    <input
                      autoFocus
                      maxLength={120}
                      onChange={(event) => setEntryDraft({ ...entryDraft, name: event.target.value })}
                      placeholder="例如：近 7 天订单"
                      value={entryDraft.name}
                    />
                  </label>
                  <label>
                    <span>目录</span>
                    <select
                      onChange={(event) => setEntryDraft({ ...entryDraft, folderId: event.target.value })}
                      value={entryDraft.folderId}
                    >
                      <option value="">未分类</option>
                      {library.folders.map((folder) => (
                        <option key={folder.id} value={folder.id}>{folder.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="sql-library__sql-field">
                  <span>SQL 内容</span>
                  <textarea
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(event) => setEntryDraft({ ...entryDraft, sqlText: event.target.value })}
                    onKeyDown={handleSqlQuoteKeyDown}
                    spellCheck="false"
                    value={entryDraft.sqlText}
                  />
                </label>
                <footer>
                  <button className="button button--secondary" disabled={busy} onClick={() => setEntryDraft(null)} type="button">
                    取消
                  </button>
                  <button className="button button--primary" disabled={busy || !entryDraft.name.trim() || !entryDraft.sqlText.trim()} type="submit">
                    {busy ? "正在保存…" : "保存"}
                  </button>
                </footer>
              </form>
            ) : loading ? (
              <p className="sql-library__status" role="status">正在读取常用 SQL…</p>
            ) : visibleEntries.length > 0 ? (
              <div className="sql-library__entries">
                {visibleEntries.map((entry) => {
                  const folder = library.folders.find((item) => item.id === entry.folderId);
                  return (
                    <article
                      key={entry.id}
                      onDoubleClick={(event) => handleEntryDoubleClick(event, entry)}
                      title="双击替换编辑器"
                    >
                      <span className="sql-library__entry-icon" aria-hidden="true"><FileCode2 size={15} /></span>
                      <span className="sql-library__entry-copy">
                        <strong>{entry.name}</strong>
                        <small>{folder?.name ?? "未分类"}</small>
                        <code>{sqlPreview(entry.sqlText)}</code>
                      </span>
                      <span className="sql-library__entry-actions">
                        <button onClick={() => handleApply(entry)} type="button">替换编辑器</button>
                        <button aria-label={`编辑 ${entry.name}`} onClick={() => startEditEntry(entry)} title="编辑" type="button">
                          <Pencil size={12} aria-hidden="true" />
                        </button>
                        <button aria-label={`删除 ${entry.name}`} onClick={() => void handleDeleteEntry(entry)} title="删除" type="button">
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      </span>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="sql-library__empty">
                <FileCode2 size={24} aria-hidden="true" />
                <strong>{normalizedSearch ? "没有匹配的常用 SQL" : "这个目录还是空的"}</strong>
                <span>{normalizedSearch ? "尝试搜索名称或 SQL 片段。" : "可将当前编辑器内容保存到这里。"}</span>
              </div>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
