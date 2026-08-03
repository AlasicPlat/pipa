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
 * Registers Pipa-aligned Monaco themes that match the warm porcelain shell tokens.
 * Side effects: defines `pipa-light` and `pipa-dark` on the shared Monaco instance.
 */
function registerPipaMonacoThemes(): void {
  monaco.editor.defineTheme(PIPA_MONACO_THEME_LIGHT, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7f725f", fontStyle: "italic" },
      { token: "keyword", foreground: "2f7aa3" },
      { token: "string", foreground: "2f8f5b" },
      { token: "number", foreground: "bd7217" },
      { token: "operator", foreground: "6d604f" },
      { token: "identifier", foreground: "282119" },
    ],
    colors: {
      "editor.background": "#fffdf8",
      "editor.foreground": "#282119",
      "editor.lineHighlightBackground": "#fcf5e9",
      "editor.selectionBackground": "#f7dfb8",
      "editor.inactiveSelectionBackground": "#f8efe2",
      "editorCursor.foreground": "#bd7217",
      "editorLineNumber.foreground": "#7f725f",
      "editorLineNumber.activeForeground": "#6d604f",
      "editorIndentGuide.background1": "#efe3d3",
      "editorIndentGuide.activeBackground1": "#cbb9a2",
      "editorWidget.background": "#fffaf2",
      "editorWidget.border": "#e3d5c3",
      "editorSuggestWidget.background": "#fffdf8",
      "editorSuggestWidget.border": "#e3d5c3",
      "editorSuggestWidget.selectedBackground": "#f5e7d4",
      "scrollbarSlider.background": "#cbb9a266",
      "scrollbarSlider.hoverBackground": "#7f725f99",
      "scrollbarSlider.activeBackground": "#6d604faa",
      "focusBorder": "#bd7217",
    },
  });

  monaco.editor.defineTheme(PIPA_MONACO_THEME_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "9f8f7f", fontStyle: "italic" },
      { token: "keyword", foreground: "67a6cf" },
      { token: "string", foreground: "4db883" },
      { token: "number", foreground: "e4a447" },
      { token: "operator", foreground: "c5b6a5" },
      { token: "identifier", foreground: "f5ede3" },
    ],
    colors: {
      "editor.background": "#201711",
      "editor.foreground": "#f5ede3",
      "editor.lineHighlightBackground": "#2a1f17",
      "editor.selectionBackground": "#3b2917",
      "editor.inactiveSelectionBackground": "#2a1f17",
      "editorCursor.foreground": "#e4a447",
      "editorLineNumber.foreground": "#9f8f7f",
      "editorLineNumber.activeForeground": "#c5b6a5",
      "editorIndentGuide.background1": "#33251c",
      "editorIndentGuide.activeBackground1": "#5a4636",
      "editorWidget.background": "#261b14",
      "editorWidget.border": "#3a2a20",
      "editorSuggestWidget.background": "#201711",
      "editorSuggestWidget.border": "#3a2a20",
      "editorSuggestWidget.selectedBackground": "#34261b",
      "scrollbarSlider.background": "#5a463666",
      "scrollbarSlider.hoverBackground": "#9f8f7f99",
      "scrollbarSlider.activeBackground": "#c5b6a5aa",
      "focusBorder": "#e4a447",
    },
  });
}

registerPipaMonacoThemes();
