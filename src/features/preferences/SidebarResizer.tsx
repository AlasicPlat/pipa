import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
} from "./sidebarLayout";

interface SidebarResizerProps {
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
}

/** Pixels moved per arrow-key press; Shift multiplies this for coarse adjustment. */
const KEYBOARD_STEP = 16;
const KEYBOARD_STEP_COARSE = 64;

/**
 * Renders the draggable divider that resizes the connection sidebar.
 *
 * Drag updates are reported continuously through `onWidthChange` so the panel
 * tracks the pointer, while `onWidthCommit` fires once per gesture so the
 * preference is persisted without writing on every pointer move.
 * @param props - Current width plus live-change and commit callbacks.
 * @returns A separator control usable by pointer and keyboard.
 * Side effects: captures the pointer during a drag and sets a body-wide resize cursor.
 */
export function SidebarResizer({ width, onWidthChange, onWidthCommit }: SidebarResizerProps) {
  const draggingRef = useRef(false);
  const latestWidthRef = useRef(width);

  useEffect(() => {
    latestWidthRef.current = width;
  }, [width]);

  // A drag that ends outside the WebView still has to release the global cursor.
  useEffect(() => () => {
    if (draggingRef.current) {
      document.body.classList.remove("is-sidebar-resizing");
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    }
  }, []);

  /** Begins a pointer-captured resize gesture from the divider. */
  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-sidebar-resizing");
    document.body.style.setProperty("cursor", "col-resize");
    document.body.style.setProperty("user-select", "none");
  }

  /** Tracks the pointer while a resize gesture is active. */
  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) {
      return;
    }
    // The sidebar starts after the fixed activity rail, so the divider's
    // width is the pointer's distance from the panel's own left edge.
    const panel = event.currentTarget.previousElementSibling;
    const panelLeft = panel instanceof HTMLElement
      ? panel.getBoundingClientRect().left
      : 0;
    const nextWidth = clampSidebarWidth(event.clientX - panelLeft);
    latestWidthRef.current = nextWidth;
    onWidthChange(nextWidth);
  }

  /** Ends the gesture and persists the final width exactly once. */
  function handlePointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) {
      return;
    }
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-sidebar-resizing");
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    onWidthCommit(latestWidthRef.current);
  }

  /** Restores the default sidebar width on double-click. */
  function handleDoubleClick(): void {
    latestWidthRef.current = SIDEBAR_WIDTH_DEFAULT;
    onWidthChange(SIDEBAR_WIDTH_DEFAULT);
    onWidthCommit(SIDEBAR_WIDTH_DEFAULT);
  }

  /** Adjusts the width in discrete steps so the divider is keyboard operable. */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? KEYBOARD_STEP_COARSE : KEYBOARD_STEP;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") {
      nextWidth = clampSidebarWidth(width - step);
    } else if (event.key === "ArrowRight") {
      nextWidth = clampSidebarWidth(width + step);
    } else if (event.key === "Home") {
      nextWidth = SIDEBAR_WIDTH_MIN;
    } else if (event.key === "End") {
      nextWidth = SIDEBAR_WIDTH_MAX;
    }
    if (nextWidth === null) {
      return;
    }
    event.preventDefault();
    latestWidthRef.current = nextWidth;
    onWidthChange(nextWidth);
    onWidthCommit(nextWidth);
  }

  return (
    <div
      aria-label="调整连接侧边栏宽度"
      aria-orientation="vertical"
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuenow={width}
      className="sidebar-resizer"
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      role="separator"
      tabIndex={0}
      title="拖动调整宽度；双击恢复默认"
    />
  );
}
