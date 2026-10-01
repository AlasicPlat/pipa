import { useEffect } from "react";

/**
 * Closes one open dialog with the platform-standard Escape key while it is idle.
 *
 * Every dialog in the app repeated the same effect: bail when closed or busy, listen on `document`,
 * cancel on Escape, remove the listener on cleanup. The "busy" guard is the important part — a
 * dialog that is executing a destructive statement must not be dismissable, because dismissing it
 * would hide an operation that is still running against the server.
 *
 * @param open - Whether the dialog is currently mounted and visible.
 * @param busy - Whether the dialog is running an operation that must not be interrupted.
 * @param onDismiss - Cancel handler invoked on Escape; must not mutate server state.
 * @returns Nothing (`void`).
 * Side effects: registers a document-level keydown listener while the dialog is open and idle.
 */
export function useDialogDismiss(open: boolean, busy: boolean, onDismiss: () => void): void {
  useEffect(() => {
    if (!open || busy) {
      return;
    }
    /** Dismisses the dialog without touching server state. */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onDismiss();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onDismiss, open]);
}
