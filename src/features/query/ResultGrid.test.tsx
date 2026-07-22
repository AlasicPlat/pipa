import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";
import { ResultGrid } from "./ResultGrid";

const virtualizerState = vi.hoisted(() => ({ called: false }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => {
    virtualizerState.called = true;
    return {
      getTotalSize: () => 34,
      getVirtualItems: () => [{ index: 0, key: "row-0", size: 34, start: 0 }],
    };
  },
}));

const COLUMNS: QueryColumn[] = [
  { name: "integer", databaseType: "BIGINT", nullable: false },
  { name: "decimal", databaseType: "DECIMAL", nullable: false },
  { name: "json", databaseType: "JSON", nullable: true },
  { name: "binary", databaseType: "BLOB", nullable: true },
  { name: "missing", databaseType: "TEXT", nullable: true },
];
const ROW: CellValue[] = [
  { kind: "integer", value: "9007199254740993" },
  { kind: "decimal", value: "12.3400" },
  { kind: "json", value: { compact: true } },
  { kind: "binary", value: "AAEC" },
  { kind: "null" },
];

/**
 * Verifies virtualization and transport-safe presentation of database values.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the virtual result grid in jsdom.
 */
function assertLosslessVirtualRows(): void {
  render(<ResultGrid columns={COLUMNS} rows={[ROW]} running={false} incomplete={false} />);

  expect(virtualizerState.called).toBe(true);
  expect(screen.getByText("9007199254740993")).toBeVisible();
  expect(screen.getByText("12.3400")).toBeVisible();
  expect(screen.getByText('{"compact":true}')).toBeVisible();
  expect(screen.getByText("Binary")).toBeVisible();
  expect(screen.getByText("NULL")).toHaveClass("result-cell--null");
}

/**
 * Verifies deliberately minimal streaming feedback at the result boundary.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: renders the running result grid in jsdom.
 */
function assertMinimalStreamingFeedback(): void {
  render(<ResultGrid columns={COLUMNS} rows={[ROW]} running incomplete={false} />);

  expect(screen.getByText("正在加载更多…")).toBeVisible();
  expect(screen.queryByText(/行|耗时|阶段|连接中/)).not.toBeInTheDocument();
}

describe("ResultGrid", () => {
  it("virtualizes rows and renders lossless cell values", assertLosslessVirtualRows);
  it("shows only minimal bottom streaming feedback", assertMinimalStreamingFeedback);
});
