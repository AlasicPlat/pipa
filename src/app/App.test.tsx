import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the Pipa workspace landmarks", () => {
    render(<App />);
    expect(screen.getByRole("application", { name: "Pipa 数据库工作台" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "数据库连接" })).toBeVisible();
    expect(screen.getByRole("main", { name: "查询工作区" })).toBeVisible();
  });
});
