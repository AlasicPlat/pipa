import { describe, expect, it } from "vitest";

import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import {
  formatConnectionConfigExport,
  getConnectionActionError,
  getConnectionDeletionError,
} from "./connectionErrors";

const profile: ConnectionProfile = {
  id: "conn-1",
  name: "本地 MySQL",
  engine: "my_sql",
  environment: "development",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  database: "shop",
  tlsMode: "disabled",
};

describe("getConnectionDeletionError", () => {
  it("prefers the backend message", () => {
    expect(getConnectionDeletionError({ message: "连接仍被占用" })).toBe("连接仍被占用");
  });

  it("states that nothing was removed when the rejection carries no message", () => {
    expect(getConnectionDeletionError("opaque failure"))
      .toBe("删除失败。连接和相关数据均未从当前界面移除，请重试。");
    expect(getConnectionDeletionError(null))
      .toBe("删除失败。连接和相关数据均未从当前界面移除，请重试。");
  });

  it("reads the message off a thrown Error", () => {
    expect(getConnectionDeletionError(new Error("boom"))).toBe("boom");
  });

  it("ignores a non-string message field", () => {
    expect(getConnectionDeletionError({ message: 42 }))
      .toBe("删除失败。连接和相关数据均未从当前界面移除，请重试。");
  });
});

describe("getConnectionActionError", () => {
  it("prefers the backend message over the fallback", () => {
    expect(getConnectionActionError({ message: "端口不可达" }, "重试")).toBe("端口不可达");
  });

  it("uses the caller's fallback otherwise", () => {
    expect(getConnectionActionError("opaque", "复制失败")).toBe("复制失败");
  });
});

describe("formatConnectionConfigExport", () => {
  it("exports how to reach the server without the identifier", () => {
    const exported: unknown = JSON.parse(formatConnectionConfigExport(profile));
    expect(exported).toEqual({
      engine: "my_sql",
      name: "本地 MySQL",
      environment: "development",
      host: "127.0.0.1",
      port: 3306,
      username: "root",
      database: "shop",
      tlsMode: "disabled",
    });
  });

  it("never carries a credential field", () => {
    const exported = formatConnectionConfigExport(profile);
    expect(exported).not.toMatch(/password|secret|credential/iu);
  });
});
