import { afterEach, describe, expect, it } from "vitest";
import {
  loadEngineSectionCollapseOverrides,
  loadExpandedConnectionIds,
  loadSidebarCollapsed,
  persistEngineSectionCollapseOverrides,
  persistExpandedConnectionIds,
  persistSidebarCollapsed,
} from "./sidebarLayout";

afterEach(() => {
  window.localStorage.clear();
});

describe("sidebarLayout", () => {
  it("defaults to expanded and persists collapsed preference", () => {
    expect(loadSidebarCollapsed()).toBe(false);
    persistSidebarCollapsed(true);
    expect(window.localStorage.getItem("pipa.sidebar-collapsed.v1")).toBe("1");
    expect(loadSidebarCollapsed()).toBe(true);
    persistSidebarCollapsed(false);
    expect(loadSidebarCollapsed()).toBe(false);
  });

  it("persists per-engine section collapse overrides", () => {
    expect(loadEngineSectionCollapseOverrides().size).toBe(0);
    persistEngineSectionCollapseOverrides(new Map([["my_sql", true], ["redis", false]]));
    expect(loadEngineSectionCollapseOverrides().get("my_sql")).toBe(true);
    expect(loadEngineSectionCollapseOverrides().get("redis")).toBe(false);
  });

  it("restores which connection drawers were left open", () => {
    expect(loadExpandedConnectionIds().size).toBe(0);
    persistExpandedConnectionIds(new Set(["connection-a", "connection-b"]));
    expect([...loadExpandedConnectionIds()]).toEqual(["connection-a", "connection-b"]);
    persistExpandedConnectionIds(new Set());
    expect(loadExpandedConnectionIds().size).toBe(0);
  });

  it("ignores malformed or non-string persisted expansion entries", () => {
    window.localStorage.setItem("pipa.expanded-connections.v1", '["ok", 7, "", null]');
    expect([...loadExpandedConnectionIds()]).toEqual(["ok"]);
    window.localStorage.setItem("pipa.expanded-connections.v1", "{ not json");
    expect(loadExpandedConnectionIds().size).toBe(0);
  });
});
