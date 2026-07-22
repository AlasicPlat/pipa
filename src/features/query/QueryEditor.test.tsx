import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryEditor } from "./QueryEditor";

const monacoState = vi.hoisted(() => ({
  actionRegistrations: 0,
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
        addAction: () => {
          monacoState.actionRegistrations += 1;
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
 * Verifies both platform modifiers execute once through document capture and block refresh.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the editor mock and dispatches cancelable keyboard events.
 */
function assertCapturedPlatformShortcutsExecuteOnce(): void {
  const onExecute = vi.fn();
  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />);
  const controlShortcut = new KeyboardEvent("keydown", {
    key: "r",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  const commandShortcut = new KeyboardEvent("keydown", {
    key: "R",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(controlShortcut);
  expect(controlShortcut.defaultPrevented).toBe(true);
  expect(onExecute).toHaveBeenCalledTimes(1);
  expect(onExecute).toHaveBeenLastCalledWith("select 1");

  document.dispatchEvent(commandShortcut);
  expect(commandShortcut.defaultPrevented).toBe(true);
  expect(onExecute).toHaveBeenCalledTimes(2);
  expect(onExecute).toHaveBeenLastCalledWith("select 1");
  expect(monacoState.actionRegistrations).toBe(0);
}

/**
 * Verifies extra modifiers do not execute or consume unrelated keyboard combinations.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the editor mock and dispatches keyboard events to the document.
 */
function assertModifiedShortcutsAreIgnored(): void {
  const onExecute = vi.fn();
  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />);
  const shortcuts = [
    new KeyboardEvent("keydown", {
      key: "r",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
    new KeyboardEvent("keydown", {
      key: "r",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  ];

  shortcuts.forEach((shortcut) => document.dispatchEvent(shortcut));

  expect(onExecute).not.toHaveBeenCalled();
  shortcuts.forEach((shortcut) => expect(shortcut.defaultPrevented).toBe(false));
}

/**
 * Verifies the captured shortcut executes the cursor statement when there is no selection.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the editor mock and dispatches a keyboard event.
 */
function assertCapturedCursorExecution(): void {
  const onExecute = vi.fn();
  monacoState.selection = null;
  monacoState.position = { lineNumber: 2, column: 4 };
  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />);

  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "r",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(onExecute).toHaveBeenCalledWith("select 2");
}

/** Registers query-editor keyboard interaction tests. */
function registerQueryEditorTests(): void {
  beforeEach(() => {
    monacoState.actionRegistrations = 0;
    monacoState.sql = "select 1;\nselect 2;";
    monacoState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 9,
    };
    monacoState.position = { lineNumber: 1, column: 8 };
  });
  it("executes Ctrl/Cmd + R once in capture phase", assertCapturedPlatformShortcutsExecuteOnce);
  it("ignores execute shortcuts with extra modifiers", assertModifiedShortcutsAreIgnored);
  it("executes the cursor statement without a selection", assertCapturedCursorExecution);
}

describe("QueryEditor", registerQueryEditorTests);
