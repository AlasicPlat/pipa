import { describe, expect, it } from "vitest";

import {
  quoteRedisArgument,
  redisDatabaseFromWorkspaceTitle,
  redisKeyInspectionCommands,
  redisKeyWorkspaceTitle,
} from "./redisKeyWorkspace";

describe("quoteRedisArgument", () => {
  it("quotes a plain key without altering it", () => {
    expect(quoteRedisArgument("user:1")).toBe('"user:1"');
  });

  it("escapes backslashes before quotes so the result stays parseable", () => {
    expect(quoteRedisArgument("a\\b")).toBe('"a\\\\b"');
    expect(quoteRedisArgument('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("escapes control characters rather than breaking the line", () => {
    expect(quoteRedisArgument("a\nb\rc\td")).toBe('"a\\nb\\rc\\td"');
  });

  it("preserves non-ASCII content verbatim", () => {
    expect(quoteRedisArgument("用户:1")).toBe('"用户:1"');
  });
});

describe("redisKeyInspectionCommands", () => {
  it("only issues non-mutating commands", () => {
    const commands = redisKeyInspectionCommands("user:1");
    expect(commands).toBe('TYPE "user:1";\nTTL "user:1";\nMEMORY USAGE "user:1";');
    expect(commands).not.toMatch(/\b(DEL|SET|EXPIRE|FLUSH|RENAME)\b/u);
  });
});

describe("redis workspace titles", () => {
  it("round-trips the logical database through the title", () => {
    const title = redisKeyWorkspaceTitle("缓存", "3", "user:1");
    expect(title).toBe("缓存 · DB 3 · user:1");
    expect(redisDatabaseFromWorkspaceTitle(title)).toBe("3");
  });

  it("reports no database for a generic workspace title", () => {
    expect(redisDatabaseFromWorkspaceTitle("缓存 · 查询 1")).toBeNull();
    expect(redisDatabaseFromWorkspaceTitle("缓存 · DB x · user:1")).toBeNull();
  });

  it("recovers a multi-digit database", () => {
    expect(redisDatabaseFromWorkspaceTitle(redisKeyWorkspaceTitle("c", "12", "k"))).toBe("12");
  });
});
