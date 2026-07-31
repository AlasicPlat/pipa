import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/editor/contrib/find/browser/findController";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "monaco-editor/languages/definitions/sql/register";

// Bundle Monaco and its worker with Pipa so the privileged Tauri WebView never executes CDN code.
self.MonacoEnvironment = {
  /**
   * Creates the local worker used by Pipa's SQL and plaintext editor models.
   * @returns A bundled Monaco editor worker.
   * Side effects: starts one Web Worker when Monaco requests background editor services.
   */
  getWorker(): Worker {
    return new EditorWorker();
  },
};

loader.config({ monaco });
