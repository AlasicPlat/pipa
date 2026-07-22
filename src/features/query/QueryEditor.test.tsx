import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryEditor } from "./QueryEditor";

interface RegisteredAction {
  keybindings: number[];
  run: () => void;
}

const monacoState = vi.hoisted(() => ({
  action: null as RegisteredAction | null,
  sql: "select 1;\nselect 2;",
}));

vi.mock("@monaco-editor/react", () => ({
  default: (props: { onMount: (editor: unknown, monaco: unknown) => void }) => {
    props.onMount(
      {
        addAction: (action: RegisteredAction) => {
          monacoState.action = action;
        },
        getModel: () => ({ getOffsetAt: (position: { column: number }) => position.column - 1 }),
        getPosition: () => ({ lineNumber: 1, column: 18 }),
        getSelection: () => ({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 9,
        }),
        getValue: () => monacoState.sql,
      },
      { KeyMod: { CtrlCmd: 2048 }, KeyCode: { KEY_R: 48 } },
    );
    return <div data-testid="monaco-editor" />;
  },
}));

/**
 * Verifies Monaco executes the explicit selection with the cross-platform shortcut.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the editor mock and invokes the registered Monaco action.
 */
function assertMonacoRunAction(): void {
  const onExecute = vi.fn();
  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />);

  expect(monacoState.action?.keybindings).toEqual([2048 | 48]);
  monacoState.action?.run();
  expect(onExecute).toHaveBeenCalledWith("select 1");
}

/**
 * Verifies the capture-phase guard blocks the WebView refresh shortcut.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: dispatches a cancelable keyboard event to the document.
 */
function assertWebViewRefreshGuard(): void {
  render(<QueryEditor sql="select 1" onSqlChange={vi.fn()} onExecute={vi.fn()} />);
  const event = new KeyboardEvent("keydown", {
    key: "r",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

/** Registers query-editor keyboard interaction tests. */
function registerQueryEditorTests(): void {
  beforeEach(() => {
    monacoState.action = null;
  });
  it("registers Ctrl/Cmd + R and executes the selected SQL", assertMonacoRunAction);
  it("prevents the WebView refresh shortcut in capture phase", assertWebViewRefreshGuard);
}

describe("QueryEditor", registerQueryEditorTests);
