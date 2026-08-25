import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadFocusedConnectionId,
  loadFocusedDatabases,
  persistFocusedConnectionId,
  persistFocusedDatabases,
} from "./workspaceFocus";

/** Registers the workspace focus persistence tests. */
function registerWorkspaceFocusTests(): void {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("round-trips the focused connection", () => {
    expect(loadFocusedConnectionId()).toBeNull();

    persistFocusedConnectionId("connection-1");
    expect(loadFocusedConnectionId()).toBe("connection-1");

    // Clearing the focus must forget it rather than store an empty string.
    persistFocusedConnectionId(null);
    expect(loadFocusedConnectionId()).toBeNull();
  });

  it("round-trips per-connection schema choices", () => {
    expect(loadFocusedDatabases()).toEqual({});

    persistFocusedDatabases({ "connection-1": "orders", "connection-2": "analytics" });

    expect(loadFocusedDatabases()).toEqual({
      "connection-1": "orders",
      "connection-2": "analytics",
    });
  });

  it("ignores malformed stored values instead of failing to launch", () => {
    window.localStorage.setItem("pipa.focused-databases.v1", "not json");
    expect(loadFocusedDatabases()).toEqual({});

    window.localStorage.setItem("pipa.focused-databases.v1", JSON.stringify(["orders"]));
    expect(loadFocusedDatabases()).toEqual({});

    // Non-string and empty entries are dropped, valid ones are kept.
    window.localStorage.setItem(
      "pipa.focused-databases.v1",
      JSON.stringify({ "connection-1": 7, "connection-2": "", "connection-3": "shop" }),
    );
    expect(loadFocusedDatabases()).toEqual({ "connection-3": "shop" });
  });

  it("survives unavailable storage", () => {
    // jsdom exposes these on the prototype, so the spy must target it to intercept the calls.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadFocusedConnectionId()).toBeNull();
    expect(loadFocusedDatabases()).toEqual({});
    expect(() => persistFocusedConnectionId("connection-1")).not.toThrow();
    expect(() => persistFocusedDatabases({ "connection-1": "orders" })).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
}

describe("workspaceFocus", registerWorkspaceFocusTests);
