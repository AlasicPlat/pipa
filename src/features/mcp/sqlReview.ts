/** How many lines of a proposal are shown before it is collapsed behind a toggle. */
export const SQL_PREVIEW_LINE_LIMIT = 12;

/** What the reviewer needs to know about one proposal's SQL before reading it. */
export interface SqlReviewSummary {
  /** Total line count, so the reviewer knows the size before expanding. */
  lineCount: number;
  /** Total character count, which catches a one-line statement that is still huge. */
  charCount: number;
  /** Whether the statement is long enough to collapse. */
  collapsible: boolean;
  /** The first {@link SQL_PREVIEW_LINE_LIMIT} lines, used while collapsed. */
  previewText: string;
  /** How many lines the preview hides. */
  hiddenLineCount: number;
  /** Number of `;`-separated statements, so a multi-statement proposal is obvious. */
  statementCount: number;
}

/**
 * Measures one proposal's SQL so the card can size and label it before the user reads it.
 *
 * Trailing whitespace is ignored when counting lines, so a statement that merely ends in a newline
 * is not reported as longer than it looks.
 * @param sql - Exact statement text proposed by the MCP client.
 * @returns The metrics and collapsed preview for this statement.
 */
export function summarizeSqlForReview(sql: string): SqlReviewSummary {
  const normalized = sql.replace(/\s+$/u, "");
  const lines = normalized.split("\n");
  const previewLines = lines.slice(0, SQL_PREVIEW_LINE_LIMIT);
  return {
    lineCount: lines.length,
    charCount: normalized.length,
    collapsible: lines.length > SQL_PREVIEW_LINE_LIMIT,
    previewText: previewLines.join("\n"),
    hiddenLineCount: Math.max(0, lines.length - previewLines.length),
    statementCount: countSqlStatements(normalized),
  };
}

/**
 * Counts how many statements one proposal would execute.
 *
 * Semicolons inside string literals, quoted identifiers, and comments are not separators, so they
 * are skipped; miscounting here would misreport the blast radius of an approval.
 * @param sql - Statement text to scan.
 * @returns The number of non-empty statements, at least 1 for any non-blank input.
 */
export function countSqlStatements(sql: string): number {
  let statements = 0;
  let hasContent = false;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === "'" || character === "\"" || character === "`") {
      index = skipQuoted(sql, index, character);
      hasContent = true;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      index = skipTo(sql, index, "\n");
      continue;
    }
    if (character === "#") {
      index = skipTo(sql, index, "\n");
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      index = skipTo(sql, index + 2, "*/");
      continue;
    }
    if (character === ";") {
      if (hasContent) {
        statements += 1;
        hasContent = false;
      }
      index += 1;
      continue;
    }
    if (character !== undefined && character.trim() !== "") {
      hasContent = true;
    }
    index += 1;
  }
  return hasContent ? statements + 1 : Math.max(statements, 0);
}

/**
 * Advances past one quoted run, honouring backslash escapes and doubled quotes.
 * @param sql - Full statement text.
 * @param start - Index of the opening quote.
 * @param quote - The quote character that opened the run.
 * @returns The index just past the closing quote, or the end of input when unterminated.
 */
function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    const character = sql[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) {
      // A doubled quote is an escaped quote rather than the end of the run.
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/**
 * Advances past everything up to and including one terminator.
 * @param sql - Full statement text.
 * @param start - Index to search from.
 * @param terminator - Text that ends the run.
 * @returns The index just past the terminator, or the end of input when absent.
 */
function skipTo(sql: string, start: number, terminator: string): number {
  const found = sql.indexOf(terminator, start);
  return found === -1 ? sql.length : found + terminator.length;
}
