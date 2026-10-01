import { describe, expect, it } from "vitest";

import {
  countSqlStatements,
  summarizeSqlForReview,
  SQL_PREVIEW_LINE_LIMIT,
} from "./sqlReview";

describe("summarizeSqlForReview", () => {
  it("leaves a short statement expanded", () => {
    const summary = summarizeSqlForReview("UPDATE users SET name = 'x';");
    expect(summary.lineCount).toBe(1);
    expect(summary.charCount).toBe("UPDATE users SET name = 'x';".length);
    expect(summary.collapsible).toBe(false);
    expect(summary.hiddenLineCount).toBe(0);
  });

  it("collapses a statement past the preview limit", () => {
    const lines = Array.from({ length: SQL_PREVIEW_LINE_LIMIT + 5 }, (_, index) => `-- ${index}`);
    const summary = summarizeSqlForReview(lines.join("\n"));
    expect(summary.lineCount).toBe(SQL_PREVIEW_LINE_LIMIT + 5);
    expect(summary.collapsible).toBe(true);
    expect(summary.hiddenLineCount).toBe(5);
    expect(summary.previewText.split("\n")).toHaveLength(SQL_PREVIEW_LINE_LIMIT);
  });

  it("does not count trailing whitespace as another line", () => {
    const summary = summarizeSqlForReview("SELECT 1;\n\n  ");
    expect(summary.lineCount).toBe(1);
    expect(summary.collapsible).toBe(false);
  });

  it("keeps a statement exactly at the limit expanded", () => {
    const lines = Array.from({ length: SQL_PREVIEW_LINE_LIMIT }, () => "SELECT 1;");
    expect(summarizeSqlForReview(lines.join("\n")).collapsible).toBe(false);
  });
});

describe("countSqlStatements", () => {
  it("counts terminated and unterminated statements alike", () => {
    expect(countSqlStatements("SELECT 1;")).toBe(1);
    expect(countSqlStatements("SELECT 1")).toBe(1);
    expect(countSqlStatements("SELECT 1; SELECT 2;")).toBe(2);
    expect(countSqlStatements("SELECT 1; SELECT 2")).toBe(2);
  });

  it("ignores empty statements from redundant semicolons", () => {
    expect(countSqlStatements("SELECT 1;;;")).toBe(1);
    expect(countSqlStatements(";")).toBe(0);
    expect(countSqlStatements("   ")).toBe(0);
  });

  it("does not split on a semicolon inside a string literal", () => {
    expect(countSqlStatements("UPDATE t SET note = 'a;b';")).toBe(1);
    expect(countSqlStatements('UPDATE t SET note = "a;b";')).toBe(1);
  });

  it("does not split on a semicolon inside a quoted identifier", () => {
    expect(countSqlStatements("SELECT `we;ird` FROM t;")).toBe(1);
  });

  it("honours escaped and doubled quotes", () => {
    expect(countSqlStatements("SELECT 'it\\'s; fine';")).toBe(1);
    expect(countSqlStatements("SELECT 'it''s; fine';")).toBe(1);
  });

  it("does not split on a semicolon inside a comment", () => {
    expect(countSqlStatements("SELECT 1; -- trailing; note\n")).toBe(1);
    expect(countSqlStatements("SELECT 1; # trailing; note\n")).toBe(1);
    expect(countSqlStatements("SELECT 1 /* a; b */;")).toBe(1);
  });

  it("counts a realistic multi-statement migration", () => {
    const migration = [
      "-- add the column first;",
      "ALTER TABLE orders ADD COLUMN note varchar(80) NULL;",
      "UPDATE orders SET note = 'imported; batch 1' WHERE id < 100;",
      "ALTER TABLE orders MODIFY note varchar(80) NOT NULL",
    ].join("\n");
    expect(countSqlStatements(migration)).toBe(3);
    expect(summarizeSqlForReview(migration).statementCount).toBe(3);
  });

  it("treats an unterminated literal as one statement instead of looping", () => {
    expect(countSqlStatements("SELECT 'unterminated; ")).toBe(1);
    expect(countSqlStatements("SELECT 1 /* unterminated;")).toBe(1);
  });
});
