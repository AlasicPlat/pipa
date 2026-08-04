import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/editor/contrib/find/browser/findController";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "monaco-editor/languages/definitions/sql/register";
import { PIPA_MONACO_THEME_DARK, PIPA_MONACO_THEME_LIGHT } from "./monacoThemes";

export { PIPA_MONACO_THEME_DARK, PIPA_MONACO_THEME_LIGHT } from "./monacoThemes";

// 将 Monaco 及其 Worker 打包进 Pipa，避免具备权限的 Tauri WebView 执行 CDN 代码。
self.MonacoEnvironment = {
  /**
   * 创建 Pipa 的 SQL 与纯文本编辑器模型使用的本地 Worker。
   * @returns 随应用打包的 Monaco 编辑器 Worker。
   * 副作用：Monaco 请求后台编辑器服务时启动一个 Web Worker。
   */
  getWorker(): Worker {
    return new EditorWorker();
  },
};

loader.config({ monaco });

/**
 * Registers Pipa-aligned Monaco themes that match the cool-instrument shell tokens.
 * Side effects: defines `pipa-light` and `pipa-dark` on the shared Monaco instance.
 */
function registerPipaMonacoThemes(): void {
  monaco.editor.defineTheme(PIPA_MONACO_THEME_LIGHT, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8a929c", fontStyle: "italic" },
      { token: "keyword", foreground: "2f7aa3" },
      { token: "string", foreground: "2f8f5b" },
      { token: "number", foreground: "c47a1a" },
      { token: "operator", foreground: "5c6570" },
      { token: "identifier", foreground: "1a1d21" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#1a1d21",
      "editor.lineHighlightBackground": "#f4f5f7",
      "editor.selectionBackground": "#dce6f0",
      "editor.inactiveSelectionBackground": "#e8ebf0",
      "editorCursor.foreground": "#c47a1a",
      "editorLineNumber.foreground": "#8a929c",
      "editorLineNumber.activeForeground": "#5c6570",
      "editorIndentGuide.background1": "#e6e9ee",
      "editorIndentGuide.activeBackground1": "#b8c0cb",
      "editorWidget.background": "#f8f9fb",
      "editorWidget.border": "#d8dde5",
      "editorSuggestWidget.background": "#ffffff",
      "editorSuggestWidget.border": "#d8dde5",
      "editorSuggestWidget.selectedBackground": "#e8ebf0",
      "scrollbarSlider.background": "#b8c0cb66",
      "scrollbarSlider.hoverBackground": "#8a929c99",
      "scrollbarSlider.activeBackground": "#5c6570aa",
      "focusBorder": "#c47a1a",
    },
  });

  monaco.editor.defineTheme(PIPA_MONACO_THEME_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7a8490", fontStyle: "italic" },
      { token: "keyword", foreground: "67a6cf" },
      { token: "string", foreground: "4db883" },
      { token: "number", foreground: "e0a04a" },
      { token: "operator", foreground: "a8b0ba" },
      { token: "identifier", foreground: "e8eaed" },
    ],
    colors: {
      "editor.background": "#1a1d21",
      "editor.foreground": "#e8eaed",
      "editor.lineHighlightBackground": "#22262c",
      "editor.selectionBackground": "#2a3a4a",
      "editor.inactiveSelectionBackground": "#2a2f37",
      "editorCursor.foreground": "#e0a04a",
      "editorLineNumber.foreground": "#7a8490",
      "editorLineNumber.activeForeground": "#a8b0ba",
      "editorIndentGuide.background1": "#2a2f36",
      "editorIndentGuide.activeBackground1": "#4a5360",
      "editorWidget.background": "#1e2228",
      "editorWidget.border": "#323840",
      "editorSuggestWidget.background": "#1a1d21",
      "editorSuggestWidget.border": "#323840",
      "editorSuggestWidget.selectedBackground": "#2a2f37",
      "scrollbarSlider.background": "#4a536066",
      "scrollbarSlider.hoverBackground": "#7a849099",
      "scrollbarSlider.activeBackground": "#a8b0baaa",
      "focusBorder": "#e0a04a",
    },
  });
}

registerPipaMonacoThemes();
