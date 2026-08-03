import Editor, { type OnMount } from "@monaco-editor/react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { NATIVE_EXECUTE_QUERY_EVENT } from "../../lib/nativeEvents";
import { matchesShortcut, useShortcutSettings } from "../commands/shortcutRegistry";
import type { ResolvedTheme } from "../preferences/theme";
import { PIPA_MONACO_THEME_DARK, PIPA_MONACO_THEME_LIGHT } from "./monacoThemes";
import { sqlToExecute } from "./sqlSelection";

interface QueryEditorProps {
  active?: boolean;
  engine?: "my_sql" | "redis";
  sql: string;
  onSqlChange: (sql: string) => void;
  onExecute: (sql: string) => void;
  theme?: ResolvedTheme;
}

export interface QueryEditorHandle {
  executeCurrent: () => void;
}

type MonacoEditorInstance = Parameters<OnMount>[0];
type ShortcutSource = "native" | "dom";

interface ExecutedShortcut {
  source: ShortcutSource;
  timestamp: number;
}

const SHORTCUT_ECHO_WINDOW_MS = 250;

/**
 * Returns whether a keyboard event requests selection-first SQL execution.
 * @param event - Captured browser keyboard event.
 * @returns `true` when the event matches the current configured execution binding.
 * Side effects: none.
 */
function isExecuteShortcut(event: KeyboardEvent, binding: string): boolean {
  return matchesShortcut(event, binding);
}

/** Returns whether the SQL-editor-only select-all shortcut was pressed. */
function isSelectCurrentSqlShortcut(event: KeyboardEvent, binding: string): boolean {
  return matchesShortcut(event, binding);
}

/**
 * Executes Monaco's current scope using the one selection-first scanner path.
 * @param editor - Mounted Monaco editor that owns selection, cursor, and current buffer state.
 * @param onExecute - Callback receiving only the selected or cursor-containing statement.
 * @param engine - Native syntax used to resolve an unselected execution scope.
 * @returns Nothing (`void`).
 * Side effects: reads Monaco state and invokes `onExecute` for a non-empty scope.
 */
function executeEditorScope(
  editor: MonacoEditorInstance,
  onExecute: (sql: string) => void,
  engine: QueryEditorProps["engine"],
): void {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) {
    return;
  }

  const monacoSelection = editor.getSelection();
  const selection = monacoSelection
    ? {
        start: model.getOffsetAt({
          lineNumber: monacoSelection.startLineNumber,
          column: monacoSelection.startColumn,
        }),
        end: model.getOffsetAt({
          lineNumber: monacoSelection.endLineNumber,
          column: monacoSelection.endColumn,
        }),
      }
    : null;
  const selectedText = selection
    ? editor.getValue().slice(selection.start, selection.end).trim()
    : "";
  const sql = engine === "redis"
    ? (selectedText || model.getLineContent(position.lineNumber)).trim().replace(/;$/u, "").trim()
    : sqlToExecute(editor.getValue(), selection, model.getOffsetAt(position));
  if (sql) {
    onExecute(sql);
  }
}

/**
 * Renders an engine-native command editor and executes the desktop shortcut in capture phase.
 * @param props - Controlled SQL value plus edit and execute callbacks.
 * @param forwardedRef - Imperative handle used by the visible toolbar execute control.
 * @returns The query-editor element.
 * Side effects: registers one temporary document shortcut and the shared toolbar execute handle.
 */
export const QueryEditor = forwardRef<QueryEditorHandle, QueryEditorProps>(function QueryEditor(
  { active = true, engine = "my_sql", sql, onSqlChange, onExecute, theme = "light" },
  forwardedRef,
) {
  const shortcuts = useShortcutSettings();
  const editorRef = useRef<MonacoEditorInstance | null>(null);
  const lastExecutedShortcutRef = useRef<ExecutedShortcut | null>(null);
  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;

  /** Executes the same selection/cursor scope for keyboard and toolbar callers. */
  const executeCurrent = useCallback((): void => {
    if (editorRef.current) {
      executeEditorScope(editorRef.current, onExecuteRef.current, engine);
    }
  }, [engine]);

  /**
   * Executes one native/DOM shortcut while suppressing an immediate echo from the other source.
   * @param source - Native menu or DOM keyboard source that delivered the shortcut.
   * @returns Nothing (`void`).
   * Side effects: records the shortcut time and executes the current editor scope once.
   */
  const executeShortcutOnce = useCallback((source: ShortcutSource): void => {
    if (!active || !editorRef.current || document.querySelector("[aria-modal='true']")) {
      return;
    }
    const now = performance.now();
    const lastExecution = lastExecutedShortcutRef.current;
    if (
      lastExecution !== null &&
      lastExecution.source !== source &&
      now - lastExecution.timestamp < SHORTCUT_ECHO_WINDOW_MS
    ) {
      return;
    }
    lastExecutedShortcutRef.current = { source, timestamp: now };
    executeCurrent();
  }, [active, executeCurrent]);

  useImperativeHandle(forwardedRef, () => ({ executeCurrent }), [executeCurrent]);

  /** Retains the mounted editor for both toolbar and captured-shortcut execution. */
  const handleMount = useCallback<OnMount>((editor) => {
    editorRef.current = editor;
  }, []);

  useEffect(() => {
    /** Executes configured SQL actions before the WebView can consume their key events. */
    function handleExecuteShortcut(event: KeyboardEvent): void {
      if (!active || document.querySelector("[aria-modal='true']")) {
        return;
      }
      if (isSelectCurrentSqlShortcut(event, shortcuts.bindings.selectSql) && editorRef.current?.hasTextFocus()) {
        const model = editorRef.current.getModel();
        if (model) {
          event.preventDefault();
          editorRef.current.setSelection(model.getFullModelRange());
          editorRef.current.focus();
        }
        return;
      }
      if (matchesShortcut(event, shortcuts.bindings.find) && editorRef.current?.hasTextFocus()) {
        event.preventDefault();
        void editorRef.current.getAction("actions.find")?.run();
        return;
      }
      if (!isExecuteShortcut(event, shortcuts.bindings.executeQuery)) {
        return;
      }
      event.preventDefault();
      executeShortcutOnce("dom");
    }

    document.addEventListener("keydown", handleExecuteShortcut, true);
    return () => document.removeEventListener("keydown", handleExecuteShortcut, true);
  }, [
    active,
    executeShortcutOnce,
    shortcuts.bindings.executeQuery,
    shortcuts.bindings.find,
    shortcuts.bindings.selectSql,
  ]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    // Tauri registration is asynchronous, so late resolution must honor an earlier unmount.
    void listen<void>(NATIVE_EXECUTE_QUERY_EVENT, () => executeShortcutOnce("native"))
      .then((registeredUnlisten) => {
        if (disposed) {
          registeredUnlisten();
          return;
        }
        unlisten = registeredUnlisten;
      })
      .catch((error: unknown) => {
        if (!disposed) {
          console.error(
            "Pipa native execute shortcut listener failed",
            error instanceof Error ? error.message : "unknown listener error",
          );
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [executeShortcutOnce]);

  return (
    <div className="query-editor" aria-label={engine === "redis" ? "Redis 命令编辑器" : "SQL 编辑器"}>
      <Editor
        language={engine === "redis" ? "plaintext" : "sql"}
        onChange={(value) => onSqlChange(value ?? "")}
        onMount={handleMount}
        options={{
          accessibilityPageSize: 20,
          ariaLabel: engine === "redis" ? "Redis 命令编辑器" : "MySQL 查询编辑器",
          automaticLayout: true,
          fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
          fontSize: 13,
          lineHeight: 21,
          minimap: { enabled: false },
          padding: { top: 12, bottom: 12 },
          renderLineHighlight: "line",
          scrollBeyondLastLine: false,
          tabSize: 2,
        }}
        theme={theme === "dark" ? PIPA_MONACO_THEME_DARK : PIPA_MONACO_THEME_LIGHT}
        value={sql}
      />
    </div>
  );
});
