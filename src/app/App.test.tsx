import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../bindings/ConnectionProfile";
import { listConnections, loadWorkspace, saveWorkspace } from "../lib/tauriClient";
import { App } from "./App";

vi.mock("../lib/tauriClient", () => ({
  listConnections: vi.fn(),
  loadWorkspace: vi.fn(),
  recordQueryHistory: vi.fn(),
  saveMySqlConnection: vi.fn(),
  saveWorkspace: vi.fn(),
  testMySqlConnection: vi.fn(),
}));

vi.mock("../features/query/useQuerySession", () => ({
  useQuerySession: () => ({
    state: {
      queryId: null,
      connectionId: null,
      sql: "",
      columns: [],
      rows: [],
      running: false,
      cancelRequested: false,
      incomplete: false,
      affectedRows: null,
      error: null,
    },
    run: vi.fn(),
    cancel: vi.fn(),
  }),
}));

vi.mock("@monaco-editor/react", () => ({
  default: () => <div aria-label="SQL 编辑器" />,
}));

const DEVELOPMENT_PROFILE: ConnectionProfile = {
  id: "connection-development",
  name: "开发主库",
  engine: "my_sql",
  environment: "development",
  host: "127.0.0.1",
  port: 3306,
  username: "developer",
  database: "pipa_dev",
  tlsMode: "preferred",
};

const PRODUCTION_PROFILE: ConnectionProfile = {
  ...DEVELOPMENT_PROFILE,
  id: "connection-production",
  name: "生产主库",
  environment: "production",
  host: "mysql.production.internal",
  database: "pipa",
};

const MONGODB_PROFILE: ConnectionProfile = {
  ...DEVELOPMENT_PROFILE,
  id: "connection-mongodb",
  name: "文档开发库",
  engine: "mongo_db",
  port: 27017,
  database: "documents",
};

/**
 * Verifies that the Pipa root exposes the required workspace landmarks.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the App component into the jsdom test document.
 */
function assertPipaWorkspaceLandmarks(): void {
  render(<App />);
  expect(screen.getByRole("application", { name: "Pipa 数据库工作台" })).toBeVisible();
  expect(screen.getByRole("navigation", { name: "数据库连接" })).toBeVisible();
  expect(screen.getByRole("main", { name: "查询工作区" })).toBeVisible();
}

/** Verifies navigator selection never silently rebinds the restored query-tab context. */
async function assertRestoredTabConnectionIsImmutable(): Promise<void> {
  render(<App />);
  const productionRow = await screen.findByRole("button", { name: /生产主库/ });
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();

  fireEvent.click(productionRow);
  await waitFor(() => expect(productionRow).toHaveAttribute("aria-selected", "true"));

  expect(screen.getByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "生产主库 查询工作区" })).not.toBeInTheDocument();
}

/** Verifies a selected MySQL connection creates a new bound tab without rebinding old tabs. */
async function assertNewQueryUsesSelectedConnectionWithoutRebinding(): Promise<void> {
  render(<App />);
  const productionRow = await screen.findByRole("button", { name: /生产主库/ });
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();

  fireEvent.click(productionRow);
  await waitFor(() => expect(productionRow).toHaveAttribute("aria-selected", "true"));
  fireEvent.click(
    screen.getByRole("button", {
      name: "在当前已选 MySQL 连接 生产主库 中新建查询",
    }),
  );

  expect(await screen.findByRole("region", { name: "生产主库 查询工作区" })).toBeVisible();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(screen.getByRole("tab", { name: "生产主库 · 查询 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  fireEvent.click(screen.getByRole("tab", { name: "恢复的查询" }));
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "生产主库 查询工作区" })).not.toBeInTheDocument();
}

/** Verifies a non-MySQL navigator selection cannot create a misleading SQL query tab. */
async function assertNonMySqlSelectionCannotCreateQuery(): Promise<void> {
  render(<App />);
  const mongodbRow = await screen.findByRole("button", { name: /文档开发库/ });
  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();

  fireEvent.click(mongodbRow);
  await waitFor(() => expect(mongodbRow).toHaveAttribute("aria-selected", "true"));
  expect(
    screen.getByRole("button", { name: "请选择 MySQL 连接后新建查询" }),
  ).toBeDisabled();
  fireEvent.keyDown(document, { key: "t", ctrlKey: true });

  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
}

/** Verifies restore failure is actionable and retry restores the original immutable tab. */
async function assertRecoveryFailureRequiresSuccessfulRetry(): Promise<void> {
  vi.mocked(loadWorkspace)
    .mockRejectedValueOnce(new Error("locked"))
    .mockResolvedValueOnce([
      {
        id: "restored-tab",
        connectionId: DEVELOPMENT_PROFILE.id,
        title: "恢复的查询",
        sqlText: "SELECT * FROM inventory;",
        position: 0,
      },
    ]);
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "无法恢复上次工作区" }),
  ).toBeVisible();
  expect(saveWorkspace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重新恢复" }));

  expect(await screen.findByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  const productionRow = screen.getByRole("button", { name: /生产主库/ });
  fireEvent.click(productionRow);
  await waitFor(() => expect(productionRow).toHaveAttribute("aria-selected", "true"));
  expect(screen.getByRole("region", { name: "开发主库 查询工作区" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "生产主库 查询工作区" })).not.toBeInTheDocument();
  expect(saveWorkspace).not.toHaveBeenCalled();
}

/**
 * Registers the App smoke tests with Vitest.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: registers one test case in the active Vitest suite.
 */
function registerAppTests(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listConnections).mockResolvedValue([
      DEVELOPMENT_PROFILE,
      PRODUCTION_PROFILE,
      MONGODB_PROFILE,
    ]);
    vi.mocked(loadWorkspace).mockResolvedValue([
      {
        id: "restored-tab",
        connectionId: DEVELOPMENT_PROFILE.id,
        title: "恢复的查询",
        sqlText: "SELECT * FROM inventory;",
        position: 0,
      },
    ]);
  });
  afterEach(cleanup);
  it("renders the Pipa workspace landmarks", assertPipaWorkspaceLandmarks);
  it("keeps a restored tab bound while another sidebar connection is selected", assertRestoredTabConnectionIsImmutable);
  it("creates a selected-connection tab without rebinding restored tabs", assertNewQueryUsesSelectedConnectionWithoutRebinding);
  it("does not create a SQL tab for a non-MySQL selection", assertNonMySqlSelectionCannotCreateQuery);
  it("blocks workspace replacement until an explicit recovery retry succeeds", assertRecoveryFailureRequiresSuccessfulRetry);
}

describe("App", registerAppTests);
