import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import {
  EDITOR_SPLIT_DEFAULT,
  EDITOR_SPLIT_MAX,
  EDITOR_SPLIT_MIN,
  clampEditorSplit,
} from "./paneLayout";

interface PaneSplitterProps {
  label: string;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  onRatioCommit: (ratio: number) => void;
}

/** Percentage points moved per arrow-key press; Shift takes larger steps. */
const KEYBOARD_STEP = 2;
const KEYBOARD_STEP_COARSE = 10;

/**
 * Renders the draggable divider that splits a workspace into two stacked panes.
 *
 * The position is expressed as a percentage of the container's height, measured
 * against the splitter's own offset parent, so the ratio holds when the window
 * is resized. Drag updates stream through `onRatioChange` while
 * `onRatioCommit` fires once per gesture, keeping persistence off the hot path.
 * @param props - Accessible label, current ratio, and live-change/commit callbacks.
 * @returns A horizontal separator control usable by pointer and keyboard.
 * Side effects: captures the pointer during a drag and sets a body-wide resize cursor.
 */
export function PaneSplitter({
  label,
  ratio,
  onRatioChange,
  onRatioCommit,
}: PaneSplitterProps) {
  const draggingRef = useRef(false);
  const latestRatioRef = useRef(ratio);

  useEffect(() => {
    latestRatioRef.current = ratio;
  }, [ratio]);

  // A drag that ends outside the WebView still has to release the global cursor.
  useEffect(() => () => {
    if (draggingRef.current) {
      document.body.classList.remove("is-pane-resizing");
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
    document.body.classList.add("is-pane-resizing");
    document.body.style.setProperty("cursor", "row-resize");
    document.body.style.setProperty("user-select", "none");
  }

  /** Tracks the pointer while a resize gesture is active. */
  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) {
      return;
    }
    // The ratio is consumed by CSS as a percentage of the grid's own height,
    // so it has to be measured against exactly that box.
    const grid = event.currentTarget.parentElement;
    if (!(grid instanceof HTMLElement)) {
      return;
    }
    const bounds = grid.getBoundingClientRect();
    if (bounds.height <= 0) {
      return;
    }
    const nextRatio = clampEditorSplit(
      ((event.clientY - bounds.top) / bounds.height) * 100,
    );
    latestRatioRef.current = nextRatio;
    onRatioChange(nextRatio);
  }

  /** Ends the gesture and persists the final ratio exactly once. */
  function handlePointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) {
      return;
    }
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-pane-resizing");
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    onRatioCommit(latestRatioRef.current);
  }

  /** Restores the default split on double-click. */
  function handleDoubleClick(): void {
    latestRatioRef.current = EDITOR_SPLIT_DEFAULT;
    onRatioChange(EDITOR_SPLIT_DEFAULT);
    onRatioCommit(EDITOR_SPLIT_DEFAULT);
  }

  /** Adjusts the ratio in discrete steps so the divider is keyboard operable. */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? KEYBOARD_STEP_COARSE : KEYBOARD_STEP;
    let nextRatio: number | null = null;
    if (event.key === "ArrowUp") {
      nextRatio = clampEditorSplit(ratio - step);
    } else if (event.key === "ArrowDown") {
      nextRatio = clampEditorSplit(ratio + step);
    } else if (event.key === "Home") {
      nextRatio = EDITOR_SPLIT_MIN;
    } else if (event.key === "End") {
      nextRatio = EDITOR_SPLIT_MAX;
    }
    if (nextRatio === null) {
      return;
    }
    event.preventDefault();
    latestRatioRef.current = nextRatio;
    onRatioChange(nextRatio);
    onRatioCommit(nextRatio);
  }

  return (
    <div
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemax={EDITOR_SPLIT_MAX}
      aria-valuemin={EDITOR_SPLIT_MIN}
      aria-valuenow={ratio}
      className="pane-splitter"
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      role="separator"
      tabIndex={0}
      title="拖动调整编辑器与结果区高度；双击恢复默认"
    />
  );
}
