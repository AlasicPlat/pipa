import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutHelpDialog } from "./ShortcutHelpDialog";
import { reloadShortcutBindings, resetAllShortcutBindings } from "./shortcutRegistry";

/** Verifies the closed state does not force shortcut onboarding. */
function assertClosedState(): void {
  render(<ShortcutHelpDialog onClose={vi.fn()} open={false} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
}

/** Verifies the dialog is semantic, grouped, and ready for immediate search. */
function assertOpenState(): void {
  render(<ShortcutHelpDialog onClose={vi.fn()} open />);

  expect(screen.getByRole("dialog", { name: "快捷键帮助" })).toBeVisible();
  expect(screen.getByRole("searchbox", { name: "搜索快捷键" })).toHaveFocus();
  expect(screen.getByRole("heading", { name: "全局与工作区" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "SQL 查询" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "连接与表树" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "表数据工作台" })).toBeVisible();
  expect(screen.getByText("执行 SQL")).toBeVisible();
  expect(screen.getByLabelText("Ctrl/Cmd + R").querySelectorAll("kbd")).toHaveLength(2);
}

/** Verifies fuzzy discovery terms filter both commands and their containing groups. */
function assertSearchFiltering(): void {
  render(<ShortcutHelpDialog onClose={vi.fn()} open />);
  const search = screen.getByRole("searchbox", { name: "搜索快捷键" });

  fireEvent.change(search, { target: { value: "右键" } });
  expect(screen.getByText("打开上下文菜单")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "SQL 查询" })).not.toBeInTheDocument();

  fireEvent.change(search, { target: { value: "不存在的操作" } });
  expect(screen.getByText("没有匹配的快捷键")).toBeVisible();
}

/** Verifies Escape and explicit close affordances use the same close callback. */
function assertCloseActions(): void {
  const onClose = vi.fn();
  render(<ShortcutHelpDialog onClose={onClose} open />);

  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "关闭快捷键帮助" }));
  expect(onClose).toHaveBeenCalledTimes(2);
}

describe("ShortcutHelpDialog", () => {
  afterEach(() => {
    cleanup();
    resetAllShortcutBindings();
  });
  it("stays hidden until explicitly opened", assertClosedState);
  it("shows grouped shortcuts and focuses search", assertOpenState);
  it("filters shortcuts using actions, descriptions, and aliases", assertSearchFiltering);
  it("closes from Escape and its visible close button", assertCloseActions);

  it("opens settings from the help entry and records a safe shortcut", () => {
    window.localStorage.clear();
    reloadShortcutBindings();
    render(<ShortcutHelpDialog onClose={vi.fn()} open />);

    fireEvent.click(screen.getByRole("button", { name: "修改快捷键" }));
    expect(screen.getByRole("heading", { name: "快捷键设置" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "修改新建 SQL" }));
    expect(screen.getByText("请按下新组合键")).toBeVisible();
    fireEvent.keyDown(document, { key: "n", metaKey: true, shiftKey: true });
    expect(screen.getByRole("button", { name: "修改新建 SQL" })).toHaveTextContent("Ctrl/CmdShiftN");
    expect(window.localStorage.getItem("pipa.shortcut-bindings.v1")).toContain("Mod+Shift+N");
  });

  it("explains unsafe and conflicting bindings without replacing the current value", () => {
    render(<ShortcutHelpDialog initialView="settings" onClose={vi.fn()} open />);
    fireEvent.click(screen.getByRole("button", { name: "修改新建 SQL" }));
    fireEvent.keyDown(document, { key: "k" });
    expect(screen.getByRole("alert")).toHaveTextContent("请使用含 Ctrl/Cmd/Alt 的组合键");

    fireEvent.keyDown(document, { key: "w", metaKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("与“关闭当前工作区”快捷键冲突");
    expect(screen.getByRole("button", { name: "修改新建 SQL" })).toHaveTextContent("请按下新组合键");
  });

  it("restores one binding or every binding to defaults", () => {
    render(<ShortcutHelpDialog initialView="settings" onClose={vi.fn()} open />);
    fireEvent.click(screen.getByRole("button", { name: "修改新建 SQL" }));
    fireEvent.keyDown(document, { key: "n", altKey: true });
    const resetOne = screen.getByRole("button", { name: "恢复新建 SQL默认快捷键" });
    expect(resetOne).toBeEnabled();
    fireEvent.click(resetOne);
    expect(resetOne).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "修改新建 SQL" }));
    fireEvent.keyDown(document, { key: "n", altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "全部恢复默认" }));
    expect(screen.getByRole("button", { name: "全部恢复默认" })).toBeDisabled();
  });
});
