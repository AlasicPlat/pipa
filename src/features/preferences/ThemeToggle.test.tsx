import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeMenu, ThemeToggle } from "./ThemeToggle";

afterEach(cleanup);

describe("ThemeMenu", () => {
  it("exposes all appearance choices and the current value", () => {
    render(<ThemeMenu preference="system" onChange={() => undefined} />);

    expect(screen.getByRole("menuitemradio", { name: /跟随系统/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /亮色/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemradio", { name: /暗色/ })).toHaveAttribute("aria-checked", "false");
  });
});

describe("ThemeToggle", () => {
  it("opens the appearance menu and applies one choice", () => {
    const onChange = vi.fn();
    render(<ThemeToggle preference="system" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "界面外观：跟随系统" });

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /暗色/ }));

    expect(onChange).toHaveBeenCalledWith("dark");
    expect(screen.queryByRole("menu", { name: "选择界面外观" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("dismisses the menu with Escape and restores trigger focus", () => {
    render(<ThemeToggle preference="light" onChange={() => undefined} />);
    const trigger = screen.getByRole("button", { name: "界面外观：亮色" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("dismisses the menu after an outside pointer interaction", () => {
    render(
      <div>
        <ThemeToggle preference="dark" onChange={() => undefined} />
        <button type="button">其他操作</button>
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "界面外观：暗色" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "其他操作" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
