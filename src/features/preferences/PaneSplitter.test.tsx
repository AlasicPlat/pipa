import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneSplitter } from "./PaneSplitter";
import { EDITOR_SPLIT_MAX, EDITOR_SPLIT_MIN } from "./paneLayout";

interface RenderedSplitter {
  splitter: HTMLElement;
  onRatioChange: ReturnType<typeof vi.fn>;
  onRatioCommit: ReturnType<typeof vi.fn>;
}

/**
 * Renders the splitter inside a grid whose height is stubbed for measurement.
 * @param ratio - Initial ratio reported to the control.
 * @returns The splitter element and its spied callbacks.
 * Side effects: stubs `getBoundingClientRect` on the parent grid.
 */
function renderSplitter(ratio = 44): RenderedSplitter {
  const onRatioChange = vi.fn();
  const onRatioCommit = vi.fn();
  render(
    <div data-testid="grid">
      <PaneSplitter
        label="调整编辑器与结果区高度"
        onRatioChange={onRatioChange}
        onRatioCommit={onRatioCommit}
        ratio={ratio}
      />
    </div>,
  );
  const grid = screen.getByTestId("grid");
  // The component derives a percentage from the grid box, so it needs real numbers.
  grid.getBoundingClientRect = () => ({
    top: 100,
    bottom: 600,
    height: 500,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  }) as DOMRect;
  return {
    splitter: screen.getByRole("separator", { name: "调整编辑器与结果区高度" }),
    onRatioChange,
    onRatioCommit,
  };
}

/** Verifies a drag converts the pointer position into a clamped percentage. */
function assertDragReportsMeasuredRatio(): void {
  const { splitter, onRatioChange, onRatioCommit } = renderSplitter();
  splitter.setPointerCapture = vi.fn();
  splitter.hasPointerCapture = () => true;
  splitter.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(splitter, { button: 0, pointerId: 1 });
  // 350px sits 250px into a 500px grid that starts at y=100, so 50%.
  fireEvent.pointerMove(splitter, { clientY: 350, pointerId: 1 });
  expect(onRatioChange).toHaveBeenLastCalledWith(50);
  expect(onRatioCommit).not.toHaveBeenCalled();

  fireEvent.pointerUp(splitter, { pointerId: 1 });
  expect(onRatioCommit).toHaveBeenCalledWith(50);
  expect(document.body.classList.contains("is-pane-resizing")).toBe(false);
}

/** Verifies a drag beyond the supported range is clamped rather than ignored. */
function assertDragClampsToBounds(): void {
  const { splitter, onRatioChange } = renderSplitter();
  splitter.setPointerCapture = vi.fn();

  fireEvent.pointerDown(splitter, { button: 0, pointerId: 1 });
  fireEvent.pointerMove(splitter, { clientY: 5_000, pointerId: 1 });
  expect(onRatioChange).toHaveBeenLastCalledWith(EDITOR_SPLIT_MAX);
  fireEvent.pointerMove(splitter, { clientY: -5_000, pointerId: 1 });
  expect(onRatioChange).toHaveBeenLastCalledWith(EDITOR_SPLIT_MIN);
}

/** Verifies the divider is operable and commits from the keyboard. */
function assertKeyboardAdjustsAndCommits(): void {
  const { splitter, onRatioChange, onRatioCommit } = renderSplitter(50);

  fireEvent.keyDown(splitter, { key: "ArrowUp" });
  expect(onRatioChange).toHaveBeenLastCalledWith(48);
  expect(onRatioCommit).toHaveBeenLastCalledWith(48);

  fireEvent.keyDown(splitter, { key: "ArrowDown", shiftKey: true });
  expect(onRatioChange).toHaveBeenLastCalledWith(60);

  fireEvent.keyDown(splitter, { key: "Home" });
  expect(onRatioChange).toHaveBeenLastCalledWith(EDITOR_SPLIT_MIN);
  fireEvent.keyDown(splitter, { key: "End" });
  expect(onRatioChange).toHaveBeenLastCalledWith(EDITOR_SPLIT_MAX);
}

/** Verifies double-click restores the default split and exposes ARIA range state. */
function assertDoubleClickResetsAndExposesRange(): void {
  const { splitter, onRatioCommit } = renderSplitter(70);

  expect(splitter).toHaveAttribute("aria-valuenow", "70");
  expect(splitter).toHaveAttribute("aria-valuemin", String(EDITOR_SPLIT_MIN));
  expect(splitter).toHaveAttribute("aria-valuemax", String(EDITOR_SPLIT_MAX));
  expect(splitter).toHaveAttribute("aria-orientation", "horizontal");

  fireEvent.doubleClick(splitter);
  expect(onRatioCommit).toHaveBeenCalledWith(44);
}

describe("PaneSplitter", () => {
  afterEach(() => {
    document.body.classList.remove("is-pane-resizing");
    cleanup();
  });
  it("converts a drag into a measured ratio", assertDragReportsMeasuredRatio);
  it("clamps a drag to the supported bounds", assertDragClampsToBounds);
  it("adjusts and commits from the keyboard", assertKeyboardAdjustsAndCommits);
  it("resets to the default on double-click", assertDoubleClickResetsAndExposesRange);
});
