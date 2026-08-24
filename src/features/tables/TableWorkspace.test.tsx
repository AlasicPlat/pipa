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
        state: state({
          queryId: "charset-query",
          rows: [
            [
              { kind: "text", value: "utf8mb4" },
              { kind: "text", value: "utf8mb4_0900_ai_ci" },
              { kind: "text", value: "Yes" },
            ],
            [
              { kind: "text", value: "utf8mb4" },
              { kind: "text", value: "utf8mb4_general_ci" },
              { kind: "text", value: "No" },
            ],
            [
              { kind: "text", value: "latin1" },
              { kind: "text", value: "latin1_swedish_ci" },
              { kind: "text", value: "Yes" },
            ],
          ],
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
  expect(screen.getByLabelText("待提交 DML（实际执行使用参数绑定）")).toHaveValue(
    "START TRANSACTION;\nUPDATE `shop`.`orders` SET `name` = 'new' WHERE `id` = 1;\nCOMMIT;",
  );

  fireEvent.click(screen.getByRole("tab", { name: /表结构 DDL/ }));
  expect(screen.getByText("PRIMARY")).toBeVisible();
  const typeInput = screen.getByLabelText("id 类型");
  fireEvent.change(typeInput, { target: { value: "bigint" } });
  fireEvent.keyDown(typeInput, { key: "Enter" });
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
  const dataEditor = screen.getByRole("tabpanel", { name: "数据编辑器" });
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
  const dataEditor = screen.getByRole("tabpanel", { name: "数据编辑器" });
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
  const typeInput = screen.getByLabelText("id 类型");
  fireEvent.change(typeInput, { target: { value: "bigint" } });
  fireEvent.keyDown(typeInput, { key: "Enter" });
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

  const workspace = screen.getByRole("region", { name: "orders 表工作区" });
  fireEvent.keyDown(workspace, { key: "s", ctrlKey: true });
  expect(sessionMocks.sessions[6].run).toHaveBeenCalledWith(expect.stringContaining("ALTER TABLE `shop`.`orders`"));

  fireEvent.click(screen.getByRole("button", { name: "撤销全部" }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
}

/**
 * 验证字段注释编辑生成普通字符串 DDL，并将同一条 SQL 交给执行会话。
 * 参数：无。
 * @returns 完成页面交互和异步结构加载后的 Promise。
 * Side effects: 渲染并操作模拟表结构工作区。
 */
async function assertCommentDdlUsesQuotedString(): Promise<void> {
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: /表结构 DDL/ }));
  fireEvent.click(screen.getByRole("button", { name: "编辑 name 注释" }));
  fireEvent.change(screen.getByLabelText("name 注释"), {
    target: { value: "客户 O'Reilly\\archive" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存注释" }));

  const expectedDdl = "ALTER TABLE `shop`.`orders` CHANGE COLUMN `name` `name` varchar(50) CHARACTER SET `utf8mb4_0900_ai_ci` NULL COMMENT '客户 O''Reilly\\\\archive';";
  expect(screen.getByLabelText("待执行 DDL")).toHaveValue(expectedDdl);

  fireEvent.click(screen.getByRole("button", { name: "执行 1 条 DDL" }));
  expect(sessionMocks.sessions[6].run).toHaveBeenCalledWith(expectedDdl);
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

/** Verifies the quick filter pushes a WHERE clause into both the page read and the exact count. */
async function assertQuickFilterAppliesWhereClause(): Promise<void> {
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  expect(screen.getByText("未启用筛选，当前展示全表数据")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "展开数据筛选条件" }));

  // A freshly seeded condition has no value yet, so it must not read as a validation failure.
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /提交筛选/ })).toBeDisabled();

  fireEvent.change(screen.getByLabelText("第 1 个条件的字段"), { target: { value: "name" } });
  fireEvent.change(screen.getByLabelText("第 1 个条件的比较符"), { target: { value: "CONTAINS" } });
  fireEvent.change(screen.getByLabelText("第 1 个条件的值"), { target: { value: "O'Reilly" } });
  fireEvent.click(screen.getByRole("button", { name: /提交筛选/ }));

  const expectedWhere = "WHERE `name` LIKE '%O''Reilly%' ESCAPE '\\\\'";
  await waitFor(() => expect(sessionMocks.sessions[1].run).toHaveBeenCalledWith(
    `SELECT \`id\`, \`name\` FROM \`shop\`.\`orders\` ${expectedWhere} ORDER BY \`id\` LIMIT 50 OFFSET 0;`,
  ));
  expect(sessionMocks.sessions[4].run).toHaveBeenCalledWith(
    `SELECT COUNT(*) AS total_rows FROM \`shop\`.\`orders\` ${expectedWhere};`,
  );
  expect(screen.getByText("筛选后 3 行")).toBeVisible();
  expect(screen.getByRole("button", { name: "展开数据筛选条件" })).toHaveTextContent("1");

  fireEvent.click(screen.getByRole("button", { name: "添加条件" }));
  fireEvent.change(screen.getByLabelText("第 2 个条件的连接方式"), { target: { value: "OR" } });
  fireEvent.change(screen.getByLabelText("第 2 个条件的字段"), { target: { value: "id" } });
  fireEvent.change(screen.getByLabelText("第 2 个条件的比较符"), { target: { value: ">=" } });
  fireEvent.change(screen.getByLabelText("第 2 个条件的值"), { target: { value: "abc" } });
  expect(screen.getByRole("alert")).toHaveTextContent("id 需要数值");
  expect(screen.getByRole("button", { name: /提交筛选/ })).toBeDisabled();

  fireEvent.change(screen.getByLabelText("第 2 个条件的值"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: /提交筛选/ }));
  await waitFor(() => expect(sessionMocks.sessions[1].run).toHaveBeenCalledWith(
    "SELECT `id`, `name` FROM `shop`.`orders` " +
      "WHERE `name` LIKE '%O''Reilly%' ESCAPE '\\\\' OR `id` >= 10 ORDER BY `id` LIMIT 50 OFFSET 0;",
  ));

  fireEvent.click(screen.getByRole("button", { name: "清除筛选条件" }));
  await waitFor(() => expect(sessionMocks.sessions[1].run).toHaveBeenCalledWith(
    "SELECT `id`, `name` FROM `shop`.`orders` ORDER BY `id` LIMIT 50 OFFSET 0;",
  ));
  expect(screen.getByText("未启用筛选，当前展示全表数据")).toBeVisible();
}

/** Verifies the quick filter refuses to run while staged DML edits would be invalidated. */
async function assertQuickFilterLockedWhileDirty(): Promise<void> {
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "展开数据筛选条件" }));
  fireEvent.change(screen.getByLabelText("第 1 个条件的字段"), { target: { value: "id" } });
  fireEvent.change(screen.getByLabelText("第 1 个条件的值"), { target: { value: "2" } });

  fireEvent.doubleClick(screen.getByText("old"));
  fireEvent.change(screen.getByLabelText("name 第 1 行"), { target: { value: "dirty" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

  const submit = screen.getByRole("button", { name: /提交筛选/ });
  expect(submit).toBeDisabled();
  expect(submit).toHaveAttribute("title", "请先提交或撤销当前数据变更");
  sessionMocks.sessions[1].run.mockClear();
  fireEvent.click(submit);
  expect(sessionMocks.sessions[1].run).not.toHaveBeenCalled();
}

/** Verifies the view tabs follow the WAI-ARIA tabs pattern with roving focus. */
async function assertViewTabsKeyboardNavigation(): Promise<void> {
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  const dataTab = screen.getByRole("tab", { name: /数据 DML/ });
  const structureTab = screen.getByRole("tab", { name: /表结构 DDL/ });
  const rawTab = screen.getByRole("tab", { name: /原始 DDL/ });

  // Roving tabindex: exactly one tab is reachable with Tab at any time.
  expect(dataTab).toHaveAttribute("tabindex", "0");
  expect(structureTab).toHaveAttribute("tabindex", "-1");
  expect(dataTab).toHaveAttribute("aria-controls", screen.getByRole("tabpanel", { name: "数据编辑器" }).id);

  dataTab.focus();
  fireEvent.keyDown(dataTab, { key: "ArrowRight" });
  expect(structureTab).toHaveFocus();
  expect(structureTab).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel", { name: "表结构编辑器" })).toBeVisible();

  fireEvent.keyDown(structureTab, { key: "End" });
  expect(rawTab).toHaveFocus();
  expect(screen.getByRole("tabpanel", { name: "原始 DDL" })).toBeVisible();

  // Wrapping keeps the ring traversable in both directions.
  fireEvent.keyDown(rawTab, { key: "ArrowRight" });
  expect(dataTab).toHaveFocus();
  fireEvent.keyDown(dataTab, { key: "ArrowLeft" });
  expect(rawTab).toHaveFocus();

  fireEvent.keyDown(rawTab, { key: "Home" });
  expect(dataTab).toHaveFocus();
  expect(dataTab).toHaveAttribute("aria-selected", "true");
}

/** Verifies each tab flags only the uncommitted edits made inside its own panel. */
async function assertPerPanelDirtyMarkers(): Promise<void> {
  render(<TableWorkspace profile={PROFILE} tableName="orders" />);

  expect(await screen.findByText(/主键 id/)).toBeVisible();
  expect(screen.queryByLabelText(/项未提交变更/)).not.toBeInTheDocument();

  fireEvent.doubleClick(screen.getByText("old"));
  fireEvent.change(screen.getByLabelText("name 第 1 行"), { target: { value: "changed" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

  // The data tab owns the staged DML edit; the structure tab must stay clean.
  expect(screen.getByRole("tab", { name: /数据 DML/ })).toContainElement(
    screen.getByLabelText("1 项未提交变更"),
  );
  expect(screen.getByRole("tab", { name: /表结构 DDL/ }).querySelector(".table-view-nav__dirty")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "撤销全部" }));
  expect(screen.queryByLabelText(/项未提交变更/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("tab", { name: /表结构 DDL/ }));
  const typeInput = screen.getByLabelText("id 类型");
  fireEvent.change(typeInput, { target: { value: "bigint" } });
  fireEvent.keyDown(typeInput, { key: "Enter" });
  expect(screen.getByRole("tab", { name: /表结构 DDL/ })).toContainElement(
    screen.getByLabelText("1 项未提交变更"),
  );
  expect(screen.getByRole("tab", { name: /数据 DML/ }).querySelector(".table-view-nav__dirty")).toBeNull();
}

/** Verifies a filtered result with no rows explains itself and offers a one-click reset. */
async function assertFilteredEmptyState(): Promise<void> {
  const dataSession = sessionMocks.sessions[1];
  const originalRows = dataSession.state.rows;
  dataSession.state = { ...dataSession.state, rows: [] };
  try {
    render(<TableWorkspace profile={PROFILE} tableName="orders" />);

    expect(await screen.findByText(/主键 id/)).toBeVisible();
    expect(screen.getByText("当前表还没有数据")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "展开数据筛选条件" }));
    fireEvent.change(screen.getByLabelText("第 1 个条件的字段"), { target: { value: "name" } });
    fireEvent.change(screen.getByLabelText("第 1 个条件的值"), { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: /提交筛选/ }));

    const emptyState = screen.getByText("没有符合筛选条件的数据").closest<HTMLElement>("[role='row']");
    expect(emptyState).not.toBeNull();
    expect(emptyState).toHaveTextContent("WHERE name 等于 missing");

    dataSession.run.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选条件并展示全表数据" }));
    await waitFor(() => expect(dataSession.run).toHaveBeenCalledWith(
      "SELECT `id`, `name` FROM `shop`.`orders` ORDER BY `id` LIMIT 50 OFFSET 0;",
    ));
    expect(screen.getByText("当前表还没有数据")).toBeVisible();
  } finally {
    dataSession.state = { ...dataSession.state, rows: originalRows };
  }
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
  it("executes field comments as quoted strings instead of hex literals", assertCommentDdlUsesQuotedString);
  it("orders pages by primary key and locks refresh while dirty", assertStableOrderingAndDirtyRefreshLock);
  it("keeps DEFAULT distinct from explicit NULL on inserts", assertInsertDefaultAndNullStates);
  it("retains staged values when a typed transaction fails", assertFailedTypedCommitKeepsChanges);
  it("filters the data page and exact count with a WHERE clause", assertQuickFilterAppliesWhereClause);
  it("blocks filter submission while staged DML changes exist", assertQuickFilterLockedWhileDirty);
  it("moves between view tabs with arrow, Home, and End keys", assertViewTabsKeyboardNavigation);
  it("marks uncommitted changes on the owning panel tab only", assertPerPanelDirtyMarkers);
  it("explains an empty filtered result and resets it in one click", assertFilteredEmptyState);
});
