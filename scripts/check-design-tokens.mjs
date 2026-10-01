#!/usr/bin/env node
/**
 * Guards the two rules the visual language depends on, documented at the top of tokens.css:
 *
 * 1. TOKEN ONLY — no literal px radius, px font size, rem font size, or hex colour outside
 *    tokens.css.
 * 2. ENCLOSURE BUDGET — the number of full-border rules that are neither an overlay nor an
 *    interactive control may not grow.
 *
 * Rule 2 is a ratchet rather than a hard ban: a handful of legitimate cases remain, so the check
 * fails only when the count increases. Lower the baseline when you remove one.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Full-border rules that are neither overlays nor controls. Ratchet downward only. */
const ENCLOSURE_BASELINE = 2;

const OVERLAY = /palette|dialog|menu|panel$|picker|library|viewer|editor$|toast|card$|backdrop|popover|suggest|switcher__panel|export-panel/;
const CONTROL = /button|input|select|textarea|switch|checkbox|search|trigger|kbd|option|\bform\b|record|__cancel|__collapse|__danger|-global$|__toolbar$|__icon$|__note$|__applied$/;

/**
 * Lists every stylesheet that must follow the token rules.
 * @returns Paths relative to the repository root, excluding tokens.css itself.
 */
function styleSheets() {
  const files = ["src/app/app.css"];
  const featureRoot = "src/features";
  for (const feature of readdirSync(featureRoot)) {
    const dir = join(featureRoot, feature);
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".css")) {
        files.push(join(dir, entry));
      }
    }
  }
  return files;
}

const violations = [];
let enclosures = 0;

for (const file of styleSheets()) {
  const css = readFileSync(file, "utf8");
  const lineOf = (index) => css.slice(0, index).split("\n").length;

  // Only a single-value radius must be tokenized; a shorthand (tab tops, accent bars) is a shape,
  // not a corner scale, and has no token.
  for (const match of css.matchAll(/border-radius: (\d+)px;/g)) {
    violations.push(`${file}:${lineOf(match.index)} literal radius ${match[1]}px`);
  }
  for (const match of css.matchAll(/font-size: (\d+(?:\.\d+)?)(px|rem)/g)) {
    violations.push(`${file}:${lineOf(match.index)} literal font-size ${match[1]}${match[2]}`);
  }
  for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    violations.push(`${file}:${lineOf(match.index)} literal colour ${match[0]}`);
  }

  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, rawSelector, body] = match;
    if (!/border:\s*1px solid(?!\s*transparent)/.test(body)) {
      continue;
    }
    const selector = rawSelector.trim().split("\n").pop().trim();
    if (!OVERLAY.test(selector) && !CONTROL.test(selector)) {
      enclosures += 1;
      if (process.env.VERBOSE) {
        console.log(`  enclosure ${file}:${lineOf(match.index)} ${selector}`);
      }
    }
  }
}

let failed = false;
if (violations.length > 0) {
  failed = true;
  console.error(`✗ ${violations.length} token violation(s):`);
  for (const violation of violations.slice(0, 40)) {
    console.error(`  ${violation}`);
  }
  if (violations.length > 40) {
    console.error(`  …and ${violations.length - 40} more`);
  }
}

if (enclosures > ENCLOSURE_BASELINE) {
  failed = true;
  console.error(
    `✗ enclosure budget exceeded: ${enclosures} full-border rules are neither overlay nor control `
      + `(baseline ${ENCLOSURE_BASELINE}). Use whitespace, a surface step, or an accent bar instead. `
      + `Run with VERBOSE=1 to list them.`,
  );
} else if (enclosures < ENCLOSURE_BASELINE) {
  console.log(
    `note: enclosures down to ${enclosures}; lower ENCLOSURE_BASELINE in this script to lock it in.`,
  );
}

if (failed) {
  process.exit(1);
}
console.log(`✓ design tokens clean; ${enclosures} enclosure(s) within the budget.`);
