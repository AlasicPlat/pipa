import { useCallback, useState } from "react";

import type { Engine } from "../../bindings/Engine";

/** Engines that have a connection form in the current desktop slice. */
type FormEngine = Extract<Engine, "my_sql" | "redis">;

/** The two-step add-connection flow: pick an engine, then fill in its form. */
export interface ConnectionFormFlow {
  /** Whether the modal flow is on screen at all. */
  open: boolean;
  /** Engine whose form is shown, or `null` while the type picker is up. */
  engine: FormEngine | null;
  /** Opens the type picker, unless the shell is blocked on workspace recovery. */
  start: () => void;
  /** Advances from the type picker to that engine's form. */
  selectEngine: (engine: FormEngine) => void;
  /** Steps back from a form to the type picker. */
  clearEngine: () => void;
  /** Closes the whole flow, discarding the draft and its password state. */
  close: () => void;
}

/**
 * Owns the add-connection flow's visibility and which engine form is showing.
 *
 * Closing unmounts the form rather than hiding it, so the password the user typed does not stay in
 * React state after they back out.
 * @param canStart - Whether the shell currently allows adding a connection; a blocked workspace
 * recovery must be resolved first, since a new connection cannot be placed in a workspace.
 * @returns The flow's state and its transitions.
 */
export function useConnectionFormFlow(canStart: boolean): ConnectionFormFlow {
  const [open, setOpen] = useState(false);
  const [engine, setEngine] = useState<FormEngine | null>(null);

  const close = useCallback((): void => {
    setOpen(false);
    setEngine(null);
  }, []);

  const start = useCallback((): void => {
    if (!canStart) {
      return;
    }
    setOpen(true);
    setEngine(null);
  }, [canStart]);

  return {
    open,
    engine,
    start,
    selectEngine: setEngine,
    clearEngine: useCallback((): void => setEngine(null), []),
    close,
  };
}
