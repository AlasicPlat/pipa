import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 确定性移除所有 TypeScript 绑定中由生成器产生的行尾空白。
 * 参数：无。
 * @returns {void}
 * 副作用：仅在规范化内容不同时重写 `src/bindings` 下的生成文件。
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
