import { describe, expect, it } from "vitest";
import type { CellValue } from "../../bindings/CellValue";
import {
  buildResultView,
  compareCellValues,
  cycleColumnSort,
  rowMatchesSearch,
} from "./resultView";

const ROWS: CellValue[][] = [
  [{ kind: "integer", value: "10" }, { kind: "text", value: "banana" }],
  [{ kind: "integer", value: "2" }, { kind: "text", value: "apple" }],
  [{ kind: "null" }, { kind: "text", value: "carrot" }],
];

describe("resultView", () => {
  it("compares numeric-looking cells numerically and keeps NULLs last", () => {
    expect(compareCellValues({ kind: "integer", value: "2" }, { kind: "integer", value: "10" })).toBeLessThan(0);
    expect(compareCellValues({ kind: "null" }, { kind: "text", value: "a" })).toBeGreaterThan(0);
  });

  it("filters rows by case-insensitive search", () => {
    expect(rowMatchesSearch(ROWS[1] ?? [], "app")).toBe(true);
    expect(rowMatchesSearch(ROWS[0] ?? [], "app")).toBe(false);
  });

  it("builds a filtered and sorted view while retaining source indexes", () => {
    const view = buildResultView(ROWS, {
      search: "app",
      sort: { columnIndex: 0, direction: "asc" },
    });
    expect(view.map((row) => row.sourceIndex)).toEqual([1]);
    expect(view[0]?.cells[1]).toEqual({ kind: "text", value: "apple" });
  });

  it("cycles column sort states", () => {
    expect(cycleColumnSort(null, 1)).toEqual({ columnIndex: 1, direction: "asc" });
    expect(cycleColumnSort({ columnIndex: 1, direction: "asc" }, 1)).toEqual({
      columnIndex: 1,
      direction: "desc",
    });
    expect(cycleColumnSort({ columnIndex: 1, direction: "desc" }, 1)).toBeNull();
    expect(cycleColumnSort({ columnIndex: 0, direction: "asc" }, 2)).toEqual({
      columnIndex: 2,
      direction: "asc",
    });
  });
});
