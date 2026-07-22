import { describe, expect, it } from "vitest";
import { sqlToExecute } from "./sqlSelection";

/**
 * Verifies that an explicit non-whitespace selection wins over cursor extraction.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: none.
 */
function assertSelectionPrecedence(): void {
  expect(sqlToExecute("select 1;\nselect 2;", { start: 0, end: 8 }, 18)).toBe("select 1");
  expect(sqlToExecute("select 1;", { start: 0, end: 3 }, 4)).toBe("sel");
  expect(sqlToExecute("select 1;", { start: 2, end: 2 }, 4)).toBe("select 1");
}

/**
 * Verifies that delimiters inside SQL quotes and identifiers do not split statements.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: none.
 */
function assertQuotedDelimiterHandling(): void {
  expect(sqlToExecute("select ';' as value;\nselect 2;", null, 27)).toBe("select 2");
  expect(sqlToExecute('select ";" as value;\nselect 2;', null, 27)).toBe("select 2");
  expect(sqlToExecute("select `semi;column`;\nselect 2;", null, 29)).toBe("select 2");
  expect(sqlToExecute("select 'it\\'s;safe';\nselect 2;", null, 28)).toBe("select 2");
}

/**
 * Verifies that line and block comments may contain harmless semicolons.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: none.
 */
function assertCommentDelimiterHandling(): void {
  expect(sqlToExecute("select 1 /* ; */;\nselect 2;", null, 25)).toBe("select 2");
  expect(sqlToExecute("select 1 -- ;\n;\nselect 2;", null, 27)).toBe("select 2");
  expect(sqlToExecute("select 1 # ;\n;\nselect 2;", null, 26)).toBe("select 2");
}

/**
 * Verifies empty areas and edge cursor positions return the nearest non-empty statement.
 * Parameters: none.
 * @returns Nothing (`void`).
 * Side effects: none.
 */
function assertCursorEdgeHandling(): void {
  expect(sqlToExecute("  ;\n select 2 ;  ", null, 0)).toBe("");
  expect(sqlToExecute("  ;\n select 2 ;  ", null, 8)).toBe("select 2");
  expect(sqlToExecute("select 1;\n", null, 999)).toBe("");
}

describe("sqlToExecute", () => {
  it("prefers a non-empty selection", assertSelectionPrecedence);
  it("ignores semicolons inside quoted values and identifiers", assertQuotedDelimiterHandling);
  it("ignores semicolons inside comments", assertCommentDelimiterHandling);
  it("handles empty statements and cursor edges", assertCursorEdgeHandling);
});
