import { describe, expect, it } from "vitest";

import {
  orderWorkspaceTabs,
  resolveWorkspaceTabCycle,
  resolveWorkspaceTabJump,
} from "./workspaceNavigation";

describe("orderWorkspaceTabs", () => {
  it("renders query tabs, then table tabs, then utility tabs", () => {
    expect(orderWorkspaceTabs({
      queryTabIds: ["q1", "q2"],
      tableTabIds: ["t1"],
      utilityTabIds: ["u1"],
    })).toEqual([
      { id: "q1", type: "query" },
      { id: "q2", type: "query" },
      { id: "t1", type: "table" },
      { id: "u1", type: "utility" },
    ]);
  });

  it("returns nothing when no workspace is open", () => {
    expect(orderWorkspaceTabs({ queryTabIds: [], tableTabIds: [], utilityTabIds: [] })).toEqual([]);
  });
});

describe("resolveWorkspaceTabJump", () => {
  const tabs = orderWorkspaceTabs({
    queryTabIds: ["q1", "q2"],
    tableTabIds: ["t1"],
    utilityTabIds: [],
  });

  it("treats the position as one-based", () => {
    expect(resolveWorkspaceTabJump(tabs, 1)).toEqual({ id: "q1", type: "query" });
    expect(resolveWorkspaceTabJump(tabs, 3)).toEqual({ id: "t1", type: "table" });
  });

  it("maps position 9 to the last tab even when fewer tabs are open", () => {
    expect(resolveWorkspaceTabJump(tabs, 9)).toEqual({ id: "t1", type: "table" });
  });

  it("returns undefined for a position past the end", () => {
    expect(resolveWorkspaceTabJump(tabs, 4)).toBeUndefined();
    expect(resolveWorkspaceTabJump([], 1)).toBeUndefined();
  });
});

describe("resolveWorkspaceTabCycle", () => {
  const tabs = orderWorkspaceTabs({
    queryTabIds: ["q1", "q2"],
    tableTabIds: ["t1"],
    utilityTabIds: [],
  });

  it("moves to the next tab and wraps at the end", () => {
    expect(resolveWorkspaceTabCycle(tabs, "q1", false)).toEqual({ id: "q2", type: "query" });
    expect(resolveWorkspaceTabCycle(tabs, "t1", false)).toEqual({ id: "q1", type: "query" });
  });

  it("moves to the previous tab and wraps at the start", () => {
    expect(resolveWorkspaceTabCycle(tabs, "q2", true)).toEqual({ id: "q1", type: "query" });
    expect(resolveWorkspaceTabCycle(tabs, "q1", true)).toEqual({ id: "t1", type: "table" });
  });

  it("falls back to the first tab when the active id is unknown", () => {
    expect(resolveWorkspaceTabCycle(tabs, null, false)).toEqual({ id: "q2", type: "query" });
  });

  it("does nothing when fewer than two tabs are open", () => {
    const single = orderWorkspaceTabs({ queryTabIds: ["q1"], tableTabIds: [], utilityTabIds: [] });
    expect(resolveWorkspaceTabCycle(single, "q1", false)).toBeUndefined();
  });
});
