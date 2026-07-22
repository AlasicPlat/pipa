export interface SqlSelection {
  start: number;
  end: number;
}

type ScannerState =
  | "normal"
  | "single_quote"
  | "double_quote"
  | "backtick"
  | "line_comment"
  | "block_comment";

/**
 * Reports whether the character after `--` satisfies MySQL's comment introducer rule.
 * @param character - Character immediately following the second dash, if present.
 * @returns `true` only for whitespace or ASCII control characters; end-of-input is not enough.
 * Side effects: none.
 */
function isMySqlDashCommentFollower(character: string | undefined): boolean {
  return character !== undefined && /[\s\u0000-\u001f\u007f]/u.test(character);
}

/**
 * Returns selected SQL or the statement containing the cursor without mutating editor state.
 * @param sql - Complete editor text using JavaScript/Monaco UTF-16 offsets.
 * @param selection - Optional half-open selection range; non-whitespace selections take priority.
 * @param cursorOffset - Cursor offset used when there is no meaningful selection.
 * @returns Trimmed SQL without the normal-state delimiter, or an empty string for an empty statement.
 * Side effects: none. The single-pass scanner supports backslash and doubled-quote escaping, MySQL
 * `#`/`--` line comments, and non-nested block comments.
 */
export function sqlToExecute(
  sql: string,
  selection: SqlSelection | null,
  cursorOffset: number,
): string {
  if (selection) {
    const selectedSql = sql.slice(selection.start, selection.end).trim();
    if (selectedSql) {
      return selectedSql;
    }
  }

  const cursor = Math.max(0, Math.min(cursorOffset, Math.max(0, sql.length - 1)));
  let statementStart = 0;
  let state: ScannerState = "normal";

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const nextCharacter = sql[index + 1];

    if (state === "line_comment") {
      if (character === "\n" || character === "\r") {
        state = "normal";
      }
      continue;
    }

    if (state === "block_comment") {
      if (character === "*" && nextCharacter === "/") {
        state = "normal";
        index += 1;
      }
      continue;
    }

    if (state !== "normal") {
      const quote = state === "single_quote" ? "'" : state === "double_quote" ? '"' : "`";
      if (character === "\\") {
        index += 1;
      } else if (character === quote && nextCharacter === quote) {
        index += 1;
      } else if (character === quote) {
        state = "normal";
      }
      continue;
    }

    if (character === "'") {
      state = "single_quote";
    } else if (character === '"') {
      state = "double_quote";
    } else if (character === "`") {
      state = "backtick";
    } else if (character === "#") {
      state = "line_comment";
    } else if (
      character === "-" &&
      nextCharacter === "-" &&
      isMySqlDashCommentFollower(sql[index + 2])
    ) {
      state = "line_comment";
      index += 1;
    } else if (character === "/" && nextCharacter === "*") {
      state = "block_comment";
      index += 1;
    } else if (character === ";") {
      if (cursor <= index) {
        return sql.slice(statementStart, index).trim();
      }
      statementStart = index + 1;
    }
  }

  return sql.slice(statementStart).trim();
}
