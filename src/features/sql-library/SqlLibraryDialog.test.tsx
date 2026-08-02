import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteCommonSql,
  deleteSqlFolder,
  loadSqlLibrary,
  saveCommonSql,
  saveSqlFolder,
} from "../../lib/tauriClient";
import { SqlLibraryDialog } from "./SqlLibraryDialog";
import type { CommonSql, SqlFolder } from "./types";

vi.mock("../../lib/tauriClient", () => ({
  deleteCommonSql: vi.fn(),
  deleteSqlFolder: vi.fn(),
  loadSqlLibrary: vi.fn(),
  saveCommonSql: vi.fn(),
  saveSqlFolder: vi.fn(),
}));

const FOLDER: SqlFolder = {
  id: "10000000-0000-4000-8000-000000000001",
  engine: "my_sql",
  name: "报表",
  updatedAt: "2026-08-02T08:00:00Z",
};

const ENTRY: CommonSql = {
  id: "20000000-0000-4000-8000-000000000001",
  engine: "my_sql",
  folderId: FOLDER.id,
  name: "近 7 天订单",
  sqlText: "SELECT * FROM orders WHERE created_at >= NOW() - INTERVAL 7 DAY;",
  updatedAt: "2026-08-02T08:05:00Z",
};

/** Verifies directory creation, saving the active editor, and deliberate editor replacement. */
async function assertCreatesAndUsesCommonSql(): Promise<void> {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <SqlLibraryDialog
      currentSql={ENTRY.sqlText}
      engine="my_sql"
      onApply={onApply}
      onClose={onClose}
    />,
  );

  expect(await screen.findByRole("dialog", { name: "常用 SQL" })).toBeVisible();
  expect(loadSqlLibrary).toHaveBeenCalledWith("my_sql");
  fireEvent.change(screen.getByRole("textbox", { name: "新目录名称" }), {
    target: { value: FOLDER.name },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存目录" }));
  await waitFor(() => expect(saveSqlFolder).toHaveBeenCalledWith(expect.objectContaining({
    engine: "my_sql",
    name: FOLDER.name,
  })));

  fireEvent.click(screen.getByRole("button", { name: "保存当前 SQL" }));
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
    target: { value: ENTRY.name },
  });
  expect(screen.getByRole("combobox", { name: "目录" })).toHaveValue(FOLDER.id);
  expect(screen.getByRole("textbox", { name: "SQL 内容" })).toHaveValue(ENTRY.sqlText);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(saveCommonSql).toHaveBeenCalledWith(expect.objectContaining({
    engine: "my_sql",
    folderId: FOLDER.id,
    name: ENTRY.name,
    sqlText: ENTRY.sqlText,
  })));
  fireEvent.click(await screen.findByRole("button", { name: "替换编辑器" }));
  expect(onApply).toHaveBeenCalledWith(ENTRY.sqlText);
  expect(onClose).toHaveBeenCalledTimes(1);
}

/** Verifies directory deletion retains its entries and moves them to the uncategorized view. */
async function assertDeletingFolderRetainsEntries(): Promise<void> {
  vi.mocked(loadSqlLibrary).mockResolvedValueOnce({ folders: [FOLDER], entries: [ENTRY] });
  render(
    <SqlLibraryDialog
      currentSql="SELECT 1;"
      engine="my_sql"
      onApply={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  const article = await screen.findByRole("article");
  expect(within(article).getByText(FOLDER.name)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: `删除目录 ${FOLDER.name}` }));
  await waitFor(() => expect(deleteSqlFolder).toHaveBeenCalledWith(FOLDER.id));
  expect(within(screen.getByRole("article")).getByText("未分类")).toBeVisible();
  expect(deleteCommonSql).not.toHaveBeenCalled();
}

/** Verifies the code textarea disables smart text and stores typed double quotes as ASCII. */
async function assertKeepsCodeQuotesStraight(): Promise<void> {
  const currentSql = "SCAN 0 MATCH placeholder COUNT 10";
  render(
    <SqlLibraryDialog
      currentSql={currentSql}
      engine="redis"
      onApply={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  await screen.findByRole("dialog", { name: "常用 SQL" });
  fireEvent.click(screen.getByRole("button", { name: "保存当前 SQL" }));
  const sqlEditor = screen.getByRole("textbox", { name: "SQL 内容" });
  expect(sqlEditor).toHaveAttribute("autocapitalize", "off");
  expect(sqlEditor).toHaveAttribute("autocorrect", "off");
  expect(sqlEditor).toHaveAttribute("spellcheck", "false");

  const placeholderStart = currentSql.indexOf("placeholder");
  (sqlEditor as HTMLTextAreaElement).setSelectionRange(
    placeholderStart,
    placeholderStart + "placeholder".length,
  );
  fireEvent.keyDown(sqlEditor, { key: "”" });
  expect(sqlEditor).toHaveValue(currentSql.replace("placeholder", '"'));
}

/** Verifies double-clicking a reusable SQL row replaces the active editor and closes the dialog. */
async function assertDoubleClickAppliesCommonSql(): Promise<void> {
  const onApply = vi.fn();
  const onClose = vi.fn();
  vi.mocked(loadSqlLibrary).mockResolvedValueOnce({ folders: [FOLDER], entries: [ENTRY] });
  render(
    <SqlLibraryDialog
      currentSql="SELECT 1;"
      engine="my_sql"
      onApply={onApply}
      onClose={onClose}
    />,
  );

  const article = await screen.findByRole("article");
  expect(article).toHaveAttribute("title", "双击替换编辑器");
  fireEvent.doubleClick(within(article).getByRole("button", { name: `编辑 ${ENTRY.name}` }));
  expect(onApply).not.toHaveBeenCalled();
  fireEvent.doubleClick(article);
  expect(onApply).toHaveBeenCalledWith(ENTRY.sqlText);
  expect(onClose).toHaveBeenCalledTimes(1);
}

/** Registers deterministic API responses for every SQL-library mutation. */
function registerSqlLibraryTests(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(loadSqlLibrary).mockResolvedValue({ folders: [], entries: [] });
    vi.mocked(saveSqlFolder).mockImplementation(async (input) => ({
      ...input,
      id: FOLDER.id,
      updatedAt: FOLDER.updatedAt,
    }));
    vi.mocked(saveCommonSql).mockImplementation(async (input) => ({
      ...input,
      id: ENTRY.id,
      updatedAt: ENTRY.updatedAt,
    }));
    vi.mocked(deleteSqlFolder).mockResolvedValue(undefined);
    vi.mocked(deleteCommonSql).mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it("creates a directory and saves the active editor as common SQL", assertCreatesAndUsesCommonSql);
  it("retains SQL when its directory is deleted", assertDeletingFolderRetainsEntries);
  it("keeps typed command quotes as straight ASCII characters", assertKeepsCodeQuotesStraight);
  it("applies a common SQL entry when its row is double-clicked", assertDoubleClickAppliesCommonSql);
}

describe("SqlLibraryDialog", registerSqlLibraryTests);
