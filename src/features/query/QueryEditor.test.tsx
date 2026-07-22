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
  selection: {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 9,
  } as {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null,
  position: { lineNumber: 1, column: 18 },
}));

vi.mock("@monaco-editor/react", () => ({
  default: (props: { onMount: (editor: unknown, monaco: unknown) => void }) => {
    /** Converts Monaco line/column coordinates to a UTF-16 test offset. */
    function getOffsetAt(position: { lineNumber: number; column: number }): number {
      const lines = monacoState.sql.split("\n");
      return (
        lines.slice(0, position.lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) +
        position.column -
        1
      );
    }

    props.onMount(
      {
        addAction: (action: RegisteredAction) => {
          monacoState.action = action;
        },
        getModel: () => ({ getOffsetAt }),
        getPosition: () => monacoState.position,
        getSelection: () => monacoState.selection,
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
 * Verifies Monaco executes the cursor statement when there is no selection.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the editor mock and invokes the registered Monaco action.
 */
function assertMonacoCursorRunAction(): void {
  const onExecute = vi.fn();
  monacoState.selection = null;
  monacoState.position = { lineNumber: 2, column: 4 };
  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />);

  monacoState.action?.run();
  expect(onExecute).toHaveBeenCalledWith("select 2");
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
    monacoState.sql = "select 1;\nselect 2;";
    monacoState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 9,
    };
    monacoState.position = { lineNumber: 1, column: 8 };
  });
  it("registers Ctrl/Cmd + R and executes the selected SQL", assertMonacoRunAction);
  it("executes the cursor statement without a selection", assertMonacoCursorRunAction);
  it("prevents the WebView refresh shortcut in capture phase", assertWebViewRefreshGuard);
}

describe("QueryEditor", registerQueryEditorTests);
