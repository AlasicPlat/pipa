import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Removes generator-owned trailing whitespace from every TypeScript binding deterministically.
 * Parameters: none.
 * @returns {void}
 * Side effects: rewrites generated files under `src/bindings` only when normalized content differs.
 */
function main() {
  const bindingDirectory = "src/bindings";
  for (const fileName of readdirSync(bindingDirectory).filter((entry) => entry.endsWith(".ts")).sort()) {
    const filePath = join(bindingDirectory, fileName);
    const source = readFileSync(filePath, "utf8");
    const formatted = `${source.replaceAll(/[ \t]+$/gmu, "").trimEnd()}\n`;
    if (formatted !== source) {
      writeFileSync(filePath, formatted, "utf8");
    }
  }
}

main();
