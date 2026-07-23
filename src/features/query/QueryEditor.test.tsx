import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_EXECUTE_QUERY_EVENT } from "../../lib/nativeEvents";
import { resetAllShortcutBindings, updateShortcutBinding } from "../commands/shortcutRegistry";
import { QueryEditor } from "./QueryEditor";

const nativeEventState = vi.hoisted(() => ({
  handler: null as (() => void) | null,
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

const monacoState = vi.hoisted(() => ({
  actionRegistrations: 0,
  findRun: vi.fn(async () => undefined),
  focus: vi.fn(),
  hasTextFocus: true,
  setSelection: vi.fn(),
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
        focus: monacoState.focus,
        getAction: (actionId: string) => actionId === "actions.find" ? { run: monacoState.findRun } : null,
        getModel: () => ({
          getFullModelRange: () => ({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 2,
            endColumn: 10,
          }),
          getOffsetAt,
        }),
        getPosition: () => monacoState.position,
        getSelection: () => monacoState.selection,
        getValue: () => monacoState.sql,
        hasTextFocus: () => monacoState.hasTextFocus,
        setSelection: monacoState.setSelection,
      },
      { KeyMod: { CtrlCmd: 2048 }, KeyCode: { KEY_R: 48 } },
    );
    return <div data-testid="monaco-editor" />;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: nativeEventState.listen }));

/**
 * Verifies both platform modifiers execute the primary shortcut once through document capture.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the editor mock and dispatches cancelable keyboard events.
 */
function assertCapturedPlatformShortcutsExecuteOnce(): void {
  const onExecute = vi.fn();
  const controlEditor = render(
    <QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />,
  );
  const controlShortcut = new KeyboardEvent("keydown", {
    key: "r",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(controlShortcut);
  expect(controlShortcut.defaultPrevented).toBe(true);
  expect(onExecute).toHaveBeenCalledTimes(1);
  expect(onExecute).toHaveBeenLastCalledWith("select 1");
  controlEditor.unmount();

  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />);
  const commandShortcut = new KeyboardEvent("keydown", {
    key: "r",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(commandShortcut);
  expect(commandShortcut.defaultPrevented).toBe(true);
  expect(onExecute).toHaveBeenCalledTimes(2);
  expect(onExecute).toHaveBeenLastCalledWith("select 1");
  expect(monacoState.actionRegistrations).toBe(0);
}

/**
 * Verifies a changed execution binding replaces the previous combination immediately.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: updates the in-process shortcut store and dispatches configured/default combinations.
 */
function assertConfiguredExecuteShortcutReplacesDefault(): void {
  expect(updateShortcutBinding("executeQuery", "Mod+Shift+E")).toBe(true);
  const onExecute = vi.fn();
  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />);
  const configuredShortcut = new KeyboardEvent("keydown", {
    key: "E",
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  const previousDefault = new KeyboardEvent("keydown", {
    key: "r",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(configuredShortcut);
  document.dispatchEvent(previousDefault);

  expect(onExecute).toHaveBeenCalledTimes(1);
  expect(configuredShortcut.defaultPrevented).toBe(true);
  expect(previousDefault.defaultPrevented).toBe(false);
}

/** Verifies the configurable contextual search binding opens Monaco's native find action. */
function assertConfiguredFindShortcutRunsMonacoAction(): void {
  expect(updateShortcutBinding("find", "Alt+K")).toBe(true);
  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={vi.fn()} />);
  const findShortcut = new KeyboardEvent("keydown", {
    key: "k",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(findShortcut);

  expect(findShortcut.defaultPrevented).toBe(true);
  expect(monacoState.findRun).toHaveBeenCalledTimes(1);
}

/** Verifies an open modal prevents its recorded keys from leaking into the SQL editor. */
function assertModalBlocksEditorShortcuts(): void {
  const onExecute = vi.fn();
  render(
    <>
      <section aria-modal="true" role="dialog" />
      <QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />
    </>,
  );
  const shortcut = new KeyboardEvent("keydown", {
    key: "r",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(shortcut);

  expect(shortcut.defaultPrevented).toBe(false);
  expect(onExecute).not.toHaveBeenCalled();
}

/**
 * Verifies the native menu bridge registers, deduplicates a DOM echo, and cleans up.
 * Parameters: none.
 * @returns A promise that settles after the asynchronous Tauri listener is registered.
 * Side effects: resolves the mocked native listener and unmounts the editor.
 */
async function assertNativeShortcutRegistrationAndCleanup(): Promise<void> {
  const onExecute = vi.fn();
  const view = render(
    <QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />,
  );
  await waitFor(() => {
    expect(nativeEventState.listen).toHaveBeenCalledWith(
      NATIVE_EXECUTE_QUERY_EVENT,
      expect.any(Function),
    );
    expect(nativeEventState.handler).not.toBeNull();
  });

  act(() => nativeEventState.handler?.());
  const echoedDomShortcut = new KeyboardEvent("keydown", {
    key: "r",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(echoedDomShortcut);

  expect(echoedDomShortcut.defaultPrevented).toBe(true);
  expect(onExecute).toHaveBeenCalledTimes(1);
  expect(onExecute).toHaveBeenCalledWith("select 1");
  view.unmount();
  expect(nativeEventState.unlisten).toHaveBeenCalledTimes(1);
}

/**
 * Verifies repeated shortcuts from the same source are never treated as cross-source echoes.
 * Parameters: none.
 * @returns A promise that settles after both native-listener registrations complete.
 * Side effects: mounts separate DOM and native editor instances and dispatches repeated shortcuts.
 */
async function assertSameSourceShortcutsAlwaysExecute(): Promise<void> {
  vi.spyOn(performance, "now").mockReturnValue(1_000);
  const domExecute = vi.fn();
  const domEditor = render(
    <QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={domExecute} />,
  );
  for (let index = 0; index < 2; index += 1) {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "r",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  expect(domExecute).toHaveBeenCalledTimes(2);
  domEditor.unmount();

  const nativeExecute = vi.fn();
  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={nativeExecute} />);
  await waitFor(() => expect(nativeEventState.handler).not.toBeNull());
  act(() => {
    nativeEventState.handler?.();
    nativeEventState.handler?.();
  });
  expect(nativeExecute).toHaveBeenCalledTimes(2);
}

/**
 * Verifies only opposite-source echoes inside the window are suppressed without chaining state.
 * Parameters: none.
 * @returns A promise that settles after native listener registration.
 * Side effects: controls monotonic time and invokes DOM and native shortcut sources.
 */
async function assertCrossSourceEchoRules(): Promise<void> {
  const now = vi.spyOn(performance, "now");
  const onExecute = vi.fn();
  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />);
  await waitFor(() => expect(nativeEventState.handler).not.toBeNull());

  now.mockReturnValue(1_000);
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "r",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  now.mockReturnValue(1_100);
  act(() => nativeEventState.handler?.());
  now.mockReturnValue(1_200);
  act(() => {
    nativeEventState.handler?.();
  });
  expect(onExecute).toHaveBeenCalledTimes(1);

  now.mockReturnValue(1_300);
  act(() => nativeEventState.handler?.());
  expect(onExecute).toHaveBeenCalledTimes(2);
}

/**
 * Verifies native-to-DOM delivery is also deduplicated inside the echo window.
 * Parameters: none.
 * @returns A promise that settles after native listener registration.
 * Side effects: invokes both shortcut sources against one editor instance.
 */
async function assertNativeThenDomEchoExecutesOnce(): Promise<void> {
  vi.spyOn(performance, "now").mockReturnValue(2_000);
  const onExecute = vi.fn();
  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={onExecute} />);
  await waitFor(() => expect(nativeEventState.handler).not.toBeNull());

  act(() => nativeEventState.handler?.());
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "r",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(onExecute).toHaveBeenCalledTimes(1);
}

/**
 * Verifies a listener that resolves after unmount is immediately disposed.
 * Parameters: none.
 * @returns A promise that settles after the delayed registration resolves.
 * Side effects: controls a deferred native-listener promise and unmounts the editor.
 */
async function assertPendingNativeListenerIsDisposed(): Promise<void> {
  let resolveListener: ((unlisten: () => void) => void) | undefined;
  nativeEventState.listen.mockImplementationOnce(
    () =>
      new Promise<() => void>((resolve) => {
        resolveListener = resolve;
      }),
  );
  const view = render(
    <QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={vi.fn()} />,
  );
  expect(nativeEventState.listen).toHaveBeenCalledTimes(1);

  view.unmount();
  const lateUnlisten = vi.fn();
  await act(async () => {
    resolveListener?.(lateUnlisten);
    await Promise.resolve();
  });

  expect(lateUnlisten).toHaveBeenCalledTimes(1);
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

/** Verifies Ctrl/Cmd+L selects SQL only while Monaco owns text focus. */
function assertScopedSqlSelectionShortcut(): void {
  render(<QueryEditor sql={monacoState.sql} onSqlChange={vi.fn()} onExecute={vi.fn()} />);
  const focusedShortcut = new KeyboardEvent("keydown", {
    key: "l",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(focusedShortcut);
  expect(focusedShortcut.defaultPrevented).toBe(true);
  expect(monacoState.setSelection).toHaveBeenCalledWith({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 2,
    endColumn: 10,
  });
  expect(monacoState.focus).toHaveBeenCalledTimes(1);

  monacoState.hasTextFocus = false;
  const outsideShortcut = new KeyboardEvent("keydown", {
    key: "l",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(outsideShortcut);
  expect(outsideShortcut.defaultPrevented).toBe(false);
  expect(monacoState.setSelection).toHaveBeenCalledTimes(1);
}

/** Registers query-editor keyboard interaction tests. */
function registerQueryEditorTests(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeEventState.handler = null;
    nativeEventState.listen.mockImplementation(
      async (_event: string, handler: () => void): Promise<() => void> => {
        nativeEventState.handler = handler;
        return nativeEventState.unlisten;
      },
    );
    monacoState.actionRegistrations = 0;
    monacoState.hasTextFocus = true;
    monacoState.sql = "select 1;\nselect 2;";
    monacoState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 9,
    };
    monacoState.position = { lineNumber: 1, column: 8 };
  });
  afterEach(() => {
    cleanup();
    resetAllShortcutBindings();
    vi.restoreAllMocks();
  });
  it("executes Ctrl/Cmd + R once in capture phase", assertCapturedPlatformShortcutsExecuteOnce);
  it("replaces the default execution binding after customization", assertConfiguredExecuteShortcutReplacesDefault);
  it("opens Monaco find with the configured contextual binding", assertConfiguredFindShortcutRunsMonacoAction);
  it("does not leak modal key recording into the SQL editor", assertModalBlocksEditorShortcuts);
  it("executes one native shortcut and cleans up its listener", assertNativeShortcutRegistrationAndCleanup);
  it("always executes repeated shortcuts from the same source", assertSameSourceShortcutsAlwaysExecute);
  it("suppresses only cross-source echoes without updating state", assertCrossSourceEchoRules);
  it("suppresses a native-to-DOM echo", assertNativeThenDomEchoExecutesOnce);
  it("disposes a native listener that resolves after unmount", assertPendingNativeListenerIsDisposed);
  it("ignores execute shortcuts with extra modifiers", assertModifiedShortcutsAreIgnored);
  it("executes the cursor statement without a selection", assertCapturedCursorExecution);
  it("selects current SQL only while the editor is focused", assertScopedSqlSelectionShortcut);
}

describe("QueryEditor", registerQueryEditorTests);
