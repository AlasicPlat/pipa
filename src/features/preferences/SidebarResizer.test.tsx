import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarResizer } from "./SidebarResizer";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "./sidebarLayout";

interface RenderedResizer {
  onWidthChange: ReturnType<typeof vi.fn>;
  onWidthCommit: ReturnType<typeof vi.fn>;
  resizer: HTMLElement;
}

/**
 * 在带固定左边界的侧边栏后渲染分隔线。
 * @param width - 控件当前显示的宽度。
 * @returns 分隔线与宽度回调。
 * Side effects: 为侧边栏模拟布局边界。
 */
function renderResizer(width = 316): RenderedResizer {
  const onWidthChange = vi.fn();
  const onWidthCommit = vi.fn();
  render(
    <div>
      <aside data-testid="sidebar" />
      <SidebarResizer
        onWidthChange={onWidthChange}
        onWidthCommit={onWidthCommit}
        width={width}
      />
    </div>,
  );
  screen.getByTestId("sidebar").getBoundingClientRect = () => ({
    bottom: 600,
    height: 500,
    left: 58,
    right: 374,
    top: 100,
    width: 316,
    x: 58,
    y: 100,
    toJSON: () => ({}),
  }) as DOMRect;
  return {
    onWidthChange,
    onWidthCommit,
    resizer: screen.getByRole("separator", { name: "调整连接侧边栏宽度" }),
  };
}

/** 验证拖动会按侧边栏左边界计算宽度，并且只在结束时提交。 */
function assertDragMeasuresAndCommitsWidth(): void {
  const { onWidthChange, onWidthCommit, resizer } = renderResizer();
  resizer.setPointerCapture = vi.fn();
  resizer.hasPointerCapture = () => true;
  resizer.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(resizer, { button: 0, pointerId: 1 });
  fireEvent.pointerMove(resizer, { clientX: 358, pointerId: 1 });
  expect(onWidthChange).toHaveBeenLastCalledWith(300);
  expect(onWidthCommit).not.toHaveBeenCalled();

  fireEvent.pointerUp(resizer, { pointerId: 1 });
  expect(onWidthCommit).toHaveBeenCalledWith(300);
  expect(document.body).not.toHaveClass("is-sidebar-resizing");
  expect(document.body.style.cursor).toBe("");
}

/** 验证拖动宽度不会越过允许的最小值和最大值。 */
function assertDragClampsToBounds(): void {
  const { onWidthChange, resizer } = renderResizer();
  resizer.setPointerCapture = vi.fn();

  fireEvent.pointerDown(resizer, { button: 0, pointerId: 1 });
  fireEvent.pointerMove(resizer, { clientX: 10_000, pointerId: 1 });
  expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_WIDTH_MAX);
  fireEvent.pointerMove(resizer, { clientX: -10_000, pointerId: 1 });
  expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_WIDTH_MIN);
}

/** 验证键盘操作会同步预览并持久化目标宽度。 */
function assertKeyboardAdjustsAndCommits(): void {
  const { onWidthChange, onWidthCommit, resizer } = renderResizer(300);

  fireEvent.keyDown(resizer, { key: "ArrowLeft" });
  expect(onWidthChange).toHaveBeenLastCalledWith(284);
  expect(onWidthCommit).toHaveBeenLastCalledWith(284);

  fireEvent.keyDown(resizer, { key: "ArrowRight", shiftKey: true });
  expect(onWidthChange).toHaveBeenLastCalledWith(364);
  fireEvent.keyDown(resizer, { key: "Home" });
  expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_WIDTH_MIN);
  fireEvent.keyDown(resizer, { key: "End" });
  expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_WIDTH_MAX);
}

/** 验证双击恢复默认宽度，并暴露完整的无障碍范围。 */
function assertDoubleClickResetsAndExposesRange(): void {
  const { onWidthCommit, resizer } = renderResizer(420);

  expect(resizer).toHaveAttribute("aria-valuenow", "420");
  expect(resizer).toHaveAttribute("aria-valuemin", String(SIDEBAR_WIDTH_MIN));
  expect(resizer).toHaveAttribute("aria-valuemax", String(SIDEBAR_WIDTH_MAX));
  expect(resizer).toHaveAttribute("aria-orientation", "vertical");

  fireEvent.doubleClick(resizer);
  expect(onWidthCommit).toHaveBeenCalledWith(SIDEBAR_WIDTH_DEFAULT);
}

describe("SidebarResizer", () => {
  afterEach(() => {
    document.body.classList.remove("is-sidebar-resizing");
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    cleanup();
  });
  it("converts a drag into a measured width", assertDragMeasuresAndCommitsWidth);
  it("clamps a drag to the supported bounds", assertDragClampsToBounds);
  it("adjusts and commits from the keyboard", assertKeyboardAdjustsAndCommits);
  it("resets to the default on double-click", assertDoubleClickResetsAndExposesRange);
});
