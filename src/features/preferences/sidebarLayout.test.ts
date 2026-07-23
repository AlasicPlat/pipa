import { afterEach, describe, expect, it } from "vitest";
import {
  loadEngineSectionCollapseOverrides,
  loadSidebarCollapsed,
  persistEngineSectionCollapseOverrides,
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
});
