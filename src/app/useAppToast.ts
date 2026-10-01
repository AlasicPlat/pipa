import { useEffect, useState } from "react";

/** How long a success notice stays visible, in milliseconds. */
const NOTICE_TIMEOUT_MS = 3200;
/** How long an error stays visible, in milliseconds; longer, since it must be read. */
const ERROR_TIMEOUT_MS = 5000;

/** One self-dismissing shell message. */
export interface AppToast {
  /** Current message, or `null` when nothing is shown. */
  message: string | null;
  /** Shows a message, restarting the dismissal timer. */
  show: (message: string) => void;
  /** Clears the message immediately. */
  clear: () => void;
}

/**
 * Holds one shell-level message that clears itself after a timeout.
 *
 * Re-showing the same string does not restart the timer, because the state does not change; that is
 * acceptable for the shell's notices, which always describe a distinct completed action.
 * @param timeoutMs - How long the message stays visible.
 * @returns The message and its handlers.
 */
function useSelfClearingMessage(timeoutMs: number): AppToast {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) {
      return;
    }
    const timeoutId = window.setTimeout(() => setMessage(null), timeoutMs);
    return () => window.clearTimeout(timeoutId);
  }, [message, timeoutMs]);
  return {
    message,
    show: setMessage,
    clear: () => setMessage(null),
  };
}

/** The shell's two transient message channels. */
export interface AppToasts {
  /** Confirmations for completed actions, such as a deleted connection. */
  notice: AppToast;
  /** Recoverable failures from connection-level actions. */
  error: AppToast;
}

/**
 * Owns the shell's success and error toasts, each clearing itself after its own timeout.
 * @returns Both toast channels.
 */
export function useAppToasts(): AppToasts {
  return {
    notice: useSelfClearingMessage(NOTICE_TIMEOUT_MS),
    error: useSelfClearingMessage(ERROR_TIMEOUT_MS),
  };
}
