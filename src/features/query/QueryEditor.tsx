import Editor, { type OnMount } from "@monaco-editor/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { sqlToExecute } from "./sqlSelection";

interface QueryEditorProps {
  sql: string;
  onSqlChange: (sql: string) => void;
  onExecute: (sql: string) => void;
}

export interface QueryEditorHandle {
  executeCurrent: () => void;
}

type MonacoEditorInstance = Parameters<OnMount>[0];

/**
 * Tracks the operating-system color preference for Monaco without owning application theme state.
 * Parameters: none.
 * @returns Monaco's matching built-in light or dark theme name.
 * Side effects: subscribes to the system color-scheme media query while mounted.
 */
function useMonacoTheme(): "vs" | "vs-dark" {
  const [theme, setTheme] = useState<"vs" | "vs-dark">(() =>
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "vs-dark"
      : "vs",
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return undefined;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => setTheme(media.matches ? "vs-dark" : "vs");
    media.addEventListener("change", updateTheme);
    return () => media.removeEventListener("change", updateTheme);
  }, []);

  return theme;
}

/**
 * Executes Monaco's current scope using the one selection-first scanner path.
 * @param editor - Mounted Monaco editor that owns selection, cursor, and current buffer state.
 * @param onExecute - Callback receiving only the selected or cursor-containing statement.
 * @returns Nothing (`void`).
 * Side effects: reads Monaco state and invokes `onExecute` for a non-empty scope.
 */
function executeEditorScope(editor: MonacoEditorInstance, onExecute: (sql: string) => void): void {
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
  const sql = sqlToExecute(editor.getValue(), selection, model.getOffsetAt(position));
  if (sql) {
    onExecute(sql);
  }
}

/**
 * Renders the MySQL editor and prevents the WebView refresh shortcut in capture phase.
 * @param props - Controlled SQL value plus edit and execute callbacks.
 * @param forwardedRef - Imperative handle used by the visible toolbar execute control.
 * @returns The query-editor element.
 * Side effects: registers a temporary document key guard, Monaco action, and shared execute handle.
 */
export const QueryEditor = forwardRef<QueryEditorHandle, QueryEditorProps>(function QueryEditor(
  { sql, onSqlChange, onExecute },
  forwardedRef,
) {
  const theme = useMonacoTheme();
  const editorRef = useRef<MonacoEditorInstance | null>(null);
  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;

  /** Executes the same selection/cursor scope for keyboard and toolbar callers. */
  const executeCurrent = useCallback((): void => {
    if (editorRef.current) {
      executeEditorScope(editorRef.current, onExecuteRef.current);
    }
  }, []);

  useImperativeHandle(forwardedRef, () => ({ executeCurrent }), [executeCurrent]);

  /** Registers the native shortcut and retains the mounted editor for toolbar execution. */
  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      editorRef.current = editor;
      editor.addAction({
        id: "pipa.execute-query",
        label: "执行当前语句或选中内容",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KEY_R],
        run: executeCurrent,
      });
    },
    [executeCurrent],
  );

  useEffect(() => {
    /** Prevents the desktop shell from interpreting the product shortcut as refresh. */
    function preventWebViewRefresh(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
      }
    }

    document.addEventListener("keydown", preventWebViewRefresh, true);
    return () => document.removeEventListener("keydown", preventWebViewRefresh, true);
  }, []);

  return (
    <div className="query-editor" aria-label="SQL 编辑器">
      <Editor
        language="sql"
        onChange={(value) => onSqlChange(value ?? "")}
        onMount={handleMount}
        options={{
          accessibilityPageSize: 20,
          ariaLabel: "MySQL 查询编辑器",
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
        theme={theme}
        value={sql}
      />
    </div>
  );
});
