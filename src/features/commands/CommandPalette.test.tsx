import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandPalette,
  fuzzyMatchScore,
  rankCommandPaletteItems,
  type CommandPaletteItem,
} from "./CommandPalette";

const ITEMS: readonly CommandPaletteItem[] = [
  { id: "new-query", type: "command", label: "新建 SQL 查询", keywords: ["create query"] },
  {
    id: "orders",
    type: "table",
    label: "customer_orders",
    detail: "生产主库 / app",
    keywords: ["订单", "mysql.example.com"],
    connectionId: "production-id",
  },
  {
    id: "production",
    type: "connection",
    label: "生产主库",
    detail: "mysql.example.com",
    connectionId: "production-id",
    lastUsedAt: 200,
  },
  {
    id: "query-1",
    type: "workspace",
    label: "查询 1",
    detail: "SELECT * FROM users",
    connectionId: "production-id",
    lastUsedAt: 100,
  },
];

/** Verifies fuzzy matching accepts ordered non-contiguous characters and rejects reversed input. */
function assertFuzzyScoring(): void {
  expect(fuzzyMatchScore("customer_orders", "ctord")).toBeGreaterThan(0);
  expect(fuzzyMatchScore("customer_orders", "zct")).toBeNull();
  expect(fuzzyMatchScore("生产主库", "主库")).toBeGreaterThan(0);
}

/** Verifies recency, field weighting, keywords, and source-order stability. */
function assertStableRanking(): void {
  expect(rankCommandPaletteItems(ITEMS, "").map(({ id }) => id)).toEqual([
    "production",
    "query-1",
    "new-query",
    "orders",
  ]);
  expect(rankCommandPaletteItems(ITEMS, "订单").map(({ id }) => id)).toEqual(["orders"]);
  expect(rankCommandPaletteItems(ITEMS, "查询").map(({ id }) => id)).toEqual(["query-1", "new-query"]);
  expect(rankCommandPaletteItems(ITEMS, "mysql.example.com customer").map(({ id }) => id)).toEqual(["orders"]);

  const tiedItems = ITEMS.slice(0, 2).map((item) => ({ ...item, label: "same", detail: undefined, keywords: undefined }));
  expect(rankCommandPaletteItems(tiedItems, "same").map(({ id }) => id)).toEqual(["new-query", "orders"]);
}

/** Verifies modal semantics, focus management, groups, and the empty state. */
function assertAccessibleSearch(): void {
  const { rerender } = render(
    <CommandPalette items={ITEMS} onClose={vi.fn()} onSelect={vi.fn()} open={false} />,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  rerender(<CommandPalette items={ITEMS} onClose={vi.fn()} onSelect={vi.fn()} open />);
  const input = screen.getByRole("combobox", { name: /搜索连接/ });
  expect(input).toHaveFocus();
  expect(screen.getByRole("dialog", { name: "快速打开" })).toBeVisible();
  expect(screen.getByRole("group", { name: "最近使用" })).toBeVisible();
  expect(screen.getByRole("group", { name: "命令" })).toBeVisible();

  fireEvent.change(screen.getByRole("combobox", { name: "按连接过滤" }), {
    target: { value: "production-id" },
  });
  const results = within(screen.getByRole("listbox", { name: "命令面板结果" }));
  expect(results.queryByRole("option", { name: /新建 SQL 查询/ })).not.toBeInTheDocument();
  expect(results.getByRole("option", { name: /^连接\s*生产主库/u })).toBeVisible();

  fireEvent.change(input, { target: { value: "不存在" } });
  expect(screen.getByRole("status")).toHaveTextContent("没有匹配结果");
  expect(results.queryAllByRole("option")).toHaveLength(0);
}

/** Verifies a connection-scoped table finder starts with the requested range selected. */
function assertInitialConnectionScope(): void {
  render(
    <CommandPalette
      initialConnectionId="production-id"
      items={ITEMS}
      onClose={vi.fn()}
      onSelect={vi.fn()}
      open
    />,
  );

  expect(screen.getByRole("combobox", { name: "按连接过滤" })).toHaveValue("production-id");
  const results = within(screen.getByRole("listbox", { name: "命令面板结果" }));
  expect(results.getByRole("option", { name: /customer_orders/u })).toBeVisible();
  expect(results.queryByRole("option", { name: /新建 SQL 查询/u })).not.toBeInTheDocument();
}

/** Verifies wrap-around arrows, Enter selection, Escape dismissal, and pointer selection. */
function assertKeyboardAndPointerActions(): void {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const { rerender } = render(
    <CommandPalette items={ITEMS} onClose={onClose} onSelect={onSelect} open />,
  );
  const input = screen.getByRole("combobox", { name: /搜索连接/ });
  const results = within(screen.getByRole("listbox", { name: "命令面板结果" }));

  expect(results.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(results.getByRole("option", { name: /customer_orders/ })).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSelect).toHaveBeenLastCalledWith(ITEMS[2]);
  expect(onClose).toHaveBeenCalledTimes(1);

  rerender(<CommandPalette items={ITEMS} onClose={onClose} onSelect={onSelect} open />);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);

  fireEvent.click(results.getByRole("option", { name: /新建 SQL 查询/ }));
  expect(onSelect).toHaveBeenLastCalledWith(ITEMS[0]);
  expect(onClose).toHaveBeenCalledTimes(3);
}

/** Verifies table results expose the complete shared shortcut set by pointer and keyboard. */
function assertTableContextActions(): void {
  const onClose = vi.fn();
  const onRequestTableAction = vi.fn();
  render(
    <CommandPalette
      items={ITEMS}
      onClose={onClose}
      onRequestTableAction={onRequestTableAction}
      onSelect={vi.fn()}
      open
    />,
  );

  const table = screen.getByRole("option", { name: /customer_orders/u });
  fireEvent.contextMenu(table, { clientX: 120, clientY: 160 });
  expect(screen.getByRole("menu", { name: "customer_orders 表操作" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "复制表名" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "重命名表…" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "复制表…" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "置顶表" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "在新窗口中打开表" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "显示 CREATE TABLE 语法…" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "拷贝 CREATE TABLE 语法" })).toBeVisible();
  fireEvent.click(screen.getByRole("menuitem", { name: "导出" }));
  expect(screen.getByRole("menu", { name: "customer_orders 导出格式" })).toBeVisible();
  fireEvent.click(screen.getByRole("menuitem", { name: "导出 JSON…" }));
  expect(onRequestTableAction).toHaveBeenLastCalledWith(
    "production-id",
    "customer_orders",
    "export_json",
  );

  fireEvent.contextMenu(table, { clientX: 120, clientY: 160 });
  fireEvent.click(screen.getByRole("menuitem", { name: "清空表…" }));
  expect(onRequestTableAction).toHaveBeenLastCalledWith(
    "production-id",
    "customer_orders",
    "truncate",
  );
  expect(onClose).not.toHaveBeenCalled();

  const search = screen.getByRole("combobox", { name: /搜索连接/u });
  fireEvent.change(search, { target: { value: "customer_orders" } });
  fireEvent.keyDown(search, { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: "删除表…" }));
  expect(onRequestTableAction).toHaveBeenLastCalledWith(
    "production-id",
    "customer_orders",
    "drop",
  );
}

describe("CommandPalette", () => {
  afterEach(cleanup);
  it("scores fuzzy matches", assertFuzzyScoring);
  it("ranks results stably", assertStableRanking);
  it("renders an accessible searchable modal", assertAccessibleSearch);
  it("starts in the requested connection scope", assertInitialConnectionScope);
  it("supports keyboard and pointer actions", assertKeyboardAndPointerActions);
  it("requests table actions from result context menus", assertTableContextActions);
});
