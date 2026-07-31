import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/editor/contrib/find/browser/findController";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "monaco-editor/languages/definitions/sql/register";

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
