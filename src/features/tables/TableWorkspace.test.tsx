import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { resetAllShortcutBindings, updateShortcutBinding } from "../commands/shortcutRegistry";
import type { QuerySessionState } from "../query/useQuerySession";
import { TableWorkspace } from "./TableWorkspace";

const applyTableMutationsMock = vi.hoisted(() => vi.fn(async () => ({
  appliedMutations: 1,
  affectedRows: 1,
})));

vi.mock("../../lib/tauriClient", () => ({
  applyTableMutations: applyTableMutationsMock,
}));

const sessionMocks = vi.hoisted(() => {
  /** Creates a complete query state for one mocked table-workspace session. */
  function state(overrides: Partial<QuerySessionState>): QuerySessionState {
    return {
      queryId: null,
      connectionId: "connection-1",
      sql: "",
      columns: [],
      rows: [],
      running: false,
      cancelRequested: false,
      incomplete: false,
      affectedRows: 0,
      error: null,
      ...overrides,
    };
  }

  return {
    callIndex: 0,
    sessions: [
      {
        state: state({
          queryId: "schema-query",
          rows: [
            [
              { kind: "text", value: "id" },
              { kind: "text", value: "int" },
              { kind: "text", value: "NO" },
              { kind: "null" },
              { kind: "text", value: "PRI" },
              { kind: "text", value: "auto_increment" },
              { kind: "text", value: "" },
              { kind: "null" },
              { kind: "null" },
              { kind: "text", value: "" },
            ],
            [
              { kind: "text", value: "name" },
              { kind: "text", value: "varchar(50)" },
              { kind: "text", value: "YES" },
              { kind: "null" },
              { kind: "text", value: "" },
              { kind: "text", value: "" },
              { kind: "text", value: "utf8mb4" },
              { kind: "text", value: "utf8mb4_0900_ai_ci" },
              { kind: "text", value: "" },
              { kind: "text", value: "" },
            ],
          ],
        }),
        run: vi.fn(),
        cancel: vi.fn(),
      },
      {
        state: state({
          queryId: "data-query",
          columns: [
            { name: "id", databaseType: "INT", nullable: false },
            { name: "name", databaseType: "VARCHAR", nullable: true },
          ],
          rows: [
            [{ kind: "integer", value: "1" }, { kind: "text", value: "old" }],
            [{ kind: "integer", value: "2" }, { kind: "text", value: "second" }],
            [{ kind: "integer", value: "3" }, { kind: "text", value: "third" }],
          ],
        }),
        run: vi.fn(),
        cancel: vi.fn(),
      },
      {
        state: state({
          queryId: "ddl-query",
          columns: [
            { name: "Table", databaseType: "VARCHAR", nullable: false },
            { name: "Create Table", databaseType: "TEXT", nullable: false },
          ],
          rows: [[
            { kind: "text", value: "orders" },
            { kind: "text", value: "CREATE TABLE `orders` (`id` int PRIMARY KEY)" },
          ]],
        }),
        run: vi.fn(),
        cancel: vi.fn(),
      },
      {
        state: state({
          queryId: "index-query",
          rows: [[
            { kind: "text", value: "PRIMARY" },
            { kind: "integer", value: "0" },
            { kind: "null" },
            { kind: "text", value: "id" },
            { kind: "text", value: "BTREE" },
            { kind: "integer", value: "1" },
          ]],
        }),
        run: vi.fn(),
        cancel: vi.fn(),
      },
      {
        state: state({
          queryId: "count-query",
          rows: [[{ kind: "integer", value: "3" }]],
        }),
        run: vi.fn(),
        cancel: vi.fn(),
      },
      {
        state: state({ affectedRows: null }),
        run: vi.fn(),
        cancel: vi.fn(),
      },
    ],
  };
});

vi.mock("../query/useQuerySession", () => ({
  useQuerySession: () => {
    const session = sessionMocks.sessions[sessionMocks.callIndex % sessionMocks.sessions.length];
    sessionMocks.callIndex += 1;
    return session;
  },
}));

const PROFILE: ConnectionProfile = {
  id: "connection-1",
  name: "本地开发",
  engine: "my_sql",
  environment: "development",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  database: "shop",
  tlsMode: "preferred",
};

/**
 * Verifies visual DML and DDL edits surface their exact SQL before submission.
 * Parameters: none.
 * @returns A promise that resolves after schema state is applied.
 * Side effects: renders and edits one mocked table workspace.
 */
async function assertVisualChangePreviews(): Promise<void> {
  expect(updateShortcutBinding("selectRows", "Alt+A")).toBe(true);
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  expect(screen.queryByLabelText("name 第 1 行")).not.toBeInTheDocument();
  const dataGrid = screen.getByRole("table", { name: "orders 数据" });
  for (const row of screen.getAllByRole("row")) {
    expect(row).toHaveStyle({
      gridTemplateColumns: "42px repeat(2, minmax(150px, 1fr))",
      minWidth: "342px",
    });
  }
  fireEvent.keyDown(dataGrid, { key: "a", altKey: true });
  expect(screen.getByRole("checkbox", { name: "选择第 1 行" })).toBeChecked();
  fireEvent.doubleClick(screen.getByText("old"));
  expect(screen.getByRole("dialog", { name: "编辑单元格" })).toBeVisible();
  fireEvent.change(screen.getByLabelText("name 第 1 行"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  expect(screen.getByText(/UPDATE `shop`.`orders` SET `name` = CONVERT\(X'6E6577' USING utf8mb4\) WHERE `id` = 1;/)).toBeVisible();

  fireEvent.click(screen.getByRole("tab", { name: /表结构 DDL/ }));
  expect(screen.getByText("PRIMARY")).toBeVisible();
  fireEvent.change(screen.getByLabelText("id 类型"), { target: { value: "bigint" } });
  expect(screen.getByText(/CHANGE COLUMN `id` `id` bigint NOT NULL AUTO_INCREMENT/)).toBeVisible();
}

/** Verifies row selection follows the documented keyboard interaction model. */
async function assertKeyboardRowSelection(): Promise<void> {
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  const firstRow = screen.getByText("old").closest<HTMLElement>("[role='row']");
  expect(firstRow).not.toBeNull();
  firstRow?.focus();
  fireEvent.keyDown(firstRow!, { key: " " });
  expect(screen.getByRole("checkbox", { name: "选择第 1 行" })).toBeChecked();
  expect(screen.getByText(/已选择 1 \/ 当前页 3 行/)).toBeVisible();

  fireEvent.keyDown(firstRow!, { key: "ArrowDown", shiftKey: true });
  expect(screen.getByRole("checkbox", { name: "选择第 1 行" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "选择第 2 行" })).toBeChecked();

  const secondRow = screen.getByText("second").closest<HTMLElement>("[role='row']");
  fireEvent.keyDown(secondRow!, { key: "Escape" });
  expect(screen.getByRole("checkbox", { name: "选择第 1 行" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "选择第 2 行" })).not.toBeChecked();
}

/** Verifies pagination is a fixed sibling of the independently scrolling grid. */
async function assertPaginationOutsideScrollableGrid(): Promise<void> {
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  const dataEditor = screen.getByRole("region", { name: "数据编辑器" });
  const dataGrid = screen.getByRole("table", { name: "orders 数据" });
  const pagination = screen.getByLabelText("数据分页");

  expect(dataGrid.parentElement).toBe(dataEditor);
  expect(pagination.parentElement).toBe(dataEditor);
  expect(dataGrid.nextElementSibling).toBe(pagination);
  expect(dataEditor.lastElementChild).toBe(pagination);
}

/** Verifies dragging a header edge updates every data row's shared grid template. */
async function assertResizableDataColumns(): Promise<void> {
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  const resizeHandle = screen.getByRole("separator", { name: "调整 name 列宽" });
  fireEvent.mouseDown(resizeHandle, { button: 0, clientX: 100 });
  fireEvent.pointerMove(document, { clientX: 220 });

  for (const row of screen.getAllByRole("row")) {
    expect(row).toHaveStyle({
      gridTemplateColumns: "42px minmax(150px, 1fr) 270px",
      minWidth: "462px",
    });
  }
  fireEvent.pointerUp(document);
}

/** Verifies scoped find focuses the visible data search and marks matching cells. */
async function assertCurrentPageDataSearch(): Promise<void> {
  expect(updateShortcutBinding("find", "Alt+K")).toBe(true);
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  const workspace = screen.getByRole("region", { name: "orders 表工作区" });
  const searchInput = screen.getByRole("searchbox", { name: "查找当前页数据" });
  fireEvent.keyDown(workspace, { key: "k", altKey: true });
  expect(searchInput).toHaveFocus();

  fireEvent.change(searchInput, { target: { value: "SECOND" } });
  expect(screen.getByText("1 个匹配")).toBeVisible();
  expect(screen.getByText("second").closest("[role='cell']")).toHaveClass("is-search-match");
  expect(screen.getByText("third").closest("[role='cell']")).not.toHaveClass("is-search-match");
}

/** Verifies Escape exits editing before selection and Cmd/Ctrl+S submits dirty DML. */
async function assertEditingEscapeAndSaveShortcut(): Promise<void> {
  const onDirtyChange = vi.fn();
  render(<TableWorkspace onDirtyChange={onDirtyChange} profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  fireEvent.doubleClick(screen.getByText("old"));
  const editor = screen.getByLabelText("name 第 1 行");
  fireEvent.change(editor, { target: { value: "new" } });
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

  fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.queryByLabelText("name 第 1 行")).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "选择第 1 行" })).toBeChecked();
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);

  fireEvent.doubleClick(screen.getByText("old"));
  fireEvent.change(screen.getByLabelText("name 第 1 行"), { target: { value: "saved" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  const dataEditor = screen.getByRole("region", { name: "数据编辑器" });
  expect(screen.getByText(/待提交 DML/)).toBeVisible();
  expect(dataEditor.lastElementChild).toBe(screen.getByLabelText("数据分页"));
  const workspace = screen.getByRole("region", { name: "orders 表工作区" });
  fireEvent.keyDown(workspace, { key: "s", metaKey: true });
  expect(applyTableMutationsMock).toHaveBeenCalledWith(expect.objectContaining({
    connectionId: "connection-1",
    mutations: [expect.objectContaining({ type: "update" })],
  }));
}

/** Verifies production saves require the existing second confirmation gesture. */
async function assertProductionSaveConfirmation(): Promise<void> {
  render(<TableWorkspace profile={{ ...PROFILE, environment: "production" }} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  fireEvent.doubleClick(screen.getByText("old"));
  fireEvent.change(screen.getByLabelText("name 第 1 行"), { target: { value: "reviewed" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  const workspace = screen.getByRole("region", { name: "orders 表工作区" });
  fireEvent.keyDown(workspace, { key: "s", ctrlKey: true });
  expect(applyTableMutationsMock).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /确认在生产环境提交/ })).toBeVisible();
  fireEvent.keyDown(workspace, { key: "s", ctrlKey: true });
  expect(applyTableMutationsMock).toHaveBeenCalledTimes(1);
}

/** Verifies changing a staged insert invalidates an already armed production confirmation. */
async function assertProductionConfirmationTracksLatestInsert(): Promise<void> {
  render(<TableWorkspace profile={{ ...PROFILE, environment: "production" }} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /新增行/ }));
  const nameInput = screen.getByLabelText("新增行 1 name");
  fireEvent.change(nameInput, { target: { value: "first" } });
  const workspace = screen.getByRole("region", { name: "orders 表工作区" });
  fireEvent.keyDown(workspace, { key: "s", ctrlKey: true });
  expect(screen.getByRole("button", { name: /确认在生产环境提交/ })).toBeVisible();

  fireEvent.change(nameInput, { target: { value: "latest" } });
  expect(screen.getByRole("button", { name: /提交 1 项/ })).toBeVisible();
  fireEvent.keyDown(workspace, { key: "s", ctrlKey: true });
  expect(applyTableMutationsMock).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /确认在生产环境提交/ })).toBeVisible();
}

/** Verifies schema drafts participate in dirty reporting and the save shortcut. */
async function assertDdlDirtyStateAndSaveShortcut(): Promise<void> {
  const onDirtyChange = vi.fn();
  render(<TableWorkspace onDirtyChange={onDirtyChange} profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: /表结构 DDL/ }));
  fireEvent.change(screen.getByLabelText("id 类型"), { target: { value: "bigint" } });
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

  const workspace = screen.getByRole("region", { name: "orders 表工作区" });
  fireEvent.keyDown(workspace, { key: "s", ctrlKey: true });
  expect(sessionMocks.sessions[5].run).toHaveBeenCalledWith(expect.stringContaining("ALTER TABLE `shop`.`orders`"));

  fireEvent.click(screen.getByRole("button", { name: "撤销全部" }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
}

/** Verifies page reads are primary-key ordered and refresh cannot replace a dirty row snapshot. */
async function assertStableOrderingAndDirtyRefreshLock(): Promise<void> {
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  await waitFor(() => expect(sessionMocks.sessions[1].run).toHaveBeenCalledWith(
    "SELECT `id`, `name` FROM `shop`.`orders` ORDER BY `id` LIMIT 50 OFFSET 0;",
  ));
  fireEvent.doubleClick(screen.getByText("old"));
  fireEvent.change(screen.getByLabelText("name 第 1 行"), { target: { value: "dirty" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

  expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "刷新" })).toHaveAttribute("title", "请先提交或撤销当前变更");
}

/** Verifies inserted cells distinguish omitted DEFAULT from an explicit SQL NULL. */
async function assertInsertDefaultAndNullStates(): Promise<void> {
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "新增行" }));
  expect(screen.getByLabelText("新增行 1 id")).toHaveAttribute("placeholder", "DEFAULT");
  fireEvent.click(screen.getByRole("button", { name: "name 设为 NULL" }));
  fireEvent.click(screen.getByRole("button", { name: "提交 1 项" }));

  await waitFor(() => expect(applyTableMutationsMock).toHaveBeenCalledWith(expect.objectContaining({
    mutations: [{
      type: "insert",
      values: [{ name: "name", value: { kind: "null" } }],
    }],
  })));
}

/** Verifies a failed typed transaction retains the exact local change set for correction/retry. */
async function assertFailedTypedCommitKeepsChanges(): Promise<void> {
  applyTableMutationsMock.mockRejectedValueOnce({
    code: "query",
    message: "The staged row no longer exists or its key is not unique",
    technicalDetails: null,
    retryable: true,
  });
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  fireEvent.doubleClick(screen.getByText("old"));
  fireEvent.change(screen.getByLabelText("name 第 1 行"), { target: { value: "retry-me" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  fireEvent.click(screen.getByRole("button", { name: "提交 1 项" }));

  expect(await screen.findByText(/The staged row no longer exists/u)).toBeVisible();
  expect(screen.getByText(/待提交 DML/u)).toBeVisible();
  expect(screen.getByText("retry-me")).toBeVisible();
}

describe("TableWorkspace", () => {
  beforeEach(() => {
    sessionMocks.callIndex = 0;
    for (const session of sessionMocks.sessions) {
      session.run.mockClear();
      session.cancel.mockClear();
    }
    applyTableMutationsMock.mockReset();
    applyTableMutationsMock.mockResolvedValue({ appliedMutations: 1, affectedRows: 1 });
  });
  afterEach(() => {
    cleanup();
    resetAllShortcutBindings();
  });
  it("previews graphical DML and DDL changes before submission", assertVisualChangePreviews);
  it("selects contiguous rows with Space and Shift+Arrow keys", assertKeyboardRowSelection);
  it("keeps pagination outside the independently scrolling data grid", assertPaginationOutsideScrollableGrid);
  it("resizes data columns by dragging their header edges", assertResizableDataColumns);
  it("finds values within the current data page", assertCurrentPageDataSearch);
  it("exits the smallest edit layer and saves dirty DML with Cmd/Ctrl+S", assertEditingEscapeAndSaveShortcut);
  it("keeps production saves behind a second confirmation", assertProductionSaveConfirmation);
  it("invalidates production confirmation when an insert changes", assertProductionConfirmationTracksLatestInsert);
  it("reports and saves dirty DDL", assertDdlDirtyStateAndSaveShortcut);
  it("orders pages by primary key and locks refresh while dirty", assertStableOrderingAndDirtyRefreshLock);
  it("keeps DEFAULT distinct from explicit NULL on inserts", assertInsertDefaultAndNullStates);
  it("retains staged values when a typed transaction fails", assertFailedTypedCommitKeepsChanges);
});
