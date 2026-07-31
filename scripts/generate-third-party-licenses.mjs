import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu;

/**
 * 转义单个表格单元格，同时保持其可读内容不变。
 * @param {unknown} value - 要写入 Markdown 的值。
 * @returns {string} 单行且不会破坏竖线分隔的单元格。
 * 副作用：无。
 */
function markdownCell(value) {
  return String(value ?? "UNKNOWN").replaceAll("|", "\\|").replaceAll(/\s+/gu, " ").trim();
}

/**
 * 规范化上游声明的格式，但不改变其法律文本。
 * @param {string} value - 原始 UTF-8 归属文件内容。
 * @returns {string} 使用 LF 分行且没有行尾空白的文本。
 * 副作用：无。
 */
function normalizeAttributionText(value) {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * 从已安装包目录读取顶层许可证和声明文件。
 * @param {string} packageRoot - 从包元数据获取的绝对目录。
 * @returns {Array<{name: string, text: string}>} 顺序稳定的归属文件列表。
 * 副作用：读取已安装依赖的文件。
 */
function readAttributionFiles(packageRoot) {
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      text: normalizeAttributionText(readFileSync(join(packageRoot, entry.name), "utf8")),
    }))
    .filter((entry) => entry.text.length > 0);
}

/**
 * 将 pnpm 的许可证分组转换为每个版本一条的已安装包记录。
 * @returns {Array<{ecosystem: string, name: string, version: string, license: string, root: string}>} 生产 npm 依赖记录。
 * 副作用：调用 pnpm 并读取其已安装包索引。
 */
function loadNpmPackages() {
  const groupedLicenses = JSON.parse(execFileSync(
    "pnpm",
    ["licenses", "list", "--prod", "--json"],
    { encoding: "utf8" },
  ));

  return Object.entries(groupedLicenses).flatMap(([license, packages]) => packages.flatMap((packageEntry) =>
    packageEntry.versions.map((version, index) => ({
      ecosystem: "npm",
      name: packageEntry.name,
      version,
      license,
      root: packageEntry.paths[index] ?? packageEntry.paths[0],
    })),
  ));
}

/**
 * 加载 Cargo.lock 解析出的所有 registry 依赖，包括特定目标的 crate。
 * @returns {Array<{ecosystem: string, name: string, version: string, license: string, root: string}>} Rust 依赖记录。
 * 副作用：调用 Cargo，可能填充本地 registry 缓存。
 */
function loadCargoPackages() {
  const metadata = JSON.parse(execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ));

  return metadata.packages
    .filter((packageEntry) => packageEntry.source !== null)
    .map((packageEntry) => ({
      ecosystem: "Cargo",
      name: packageEntry.name,
      version: packageEntry.version,
      license: packageEntry.license ?? "UNKNOWN",
      root: dirname(packageEntry.manifest_path),
    }));
}

/**
 * 生成纳入版本控制的依赖清单和去重后的原始归属文本。
 * 参数：无。
 * @returns {void}
 * 副作用：调用包管理器、读取依赖许可证文件，并重写仓库中的两份报告。
 */
function main() {
  const packages = [...loadNpmPackages(), ...loadCargoPackages()]
    .sort((left, right) => `${left.ecosystem}:${left.name}:${left.version}`.localeCompare(`${right.ecosystem}:${right.name}:${right.version}`));
  const attributionGroups = new Map();
  const missingAttribution = [];

  for (const packageEntry of packages) {
    const attributionFiles = readAttributionFiles(packageEntry.root);
    if (attributionFiles.length === 0) {
      missingAttribution.push(packageEntry);
      continue;
    }
    for (const attributionFile of attributionFiles) {
      const digest = createHash("sha256").update(attributionFile.text).digest("hex");
      const currentGroup = attributionGroups.get(digest) ?? {
        text: attributionFile.text,
        packages: [],
      };
      currentGroup.packages.push(`${packageEntry.ecosystem}:${packageEntry.name}@${packageEntry.version} (${attributionFile.name})`);
      attributionGroups.set(digest, currentGroup);
    }
  }

  const inventory = [
    "# 第三方许可证",
    "",
    "本文件根据生产 pnpm 依赖图和完整 Cargo.lock 依赖图生成。各依赖作者保留其版权；Pipa 的 Apache-2.0 许可证不会替代任何第三方许可证。",
    "",
    "依赖变更后请运行 `pnpm licenses:generate`。发布构建会同时打包本清单和保留原文的归属文件 `THIRD_PARTY_LICENSES.txt`。",
    "",
    "| 生态 | 包 | 版本 | 声明的许可证 |",
    "| --- | --- | --- | --- |",
    ...packages.map((packageEntry) => `| ${markdownCell(packageEntry.ecosystem)} | ${markdownCell(packageEntry.name)} | ${markdownCell(packageEntry.version)} | ${markdownCell(packageEntry.license)} |`),
  ];

  if (missingAttribution.length > 0) {
    inventory.push(
      "",
      "## 仅含元数据的条目",
      "",
      "以下已安装包声明了许可证标识符，但没有提供顶层许可证或声明文件。公开发布前请人工复核：",
      "",
      ...missingAttribution.map((packageEntry) => `- ${packageEntry.ecosystem}:${packageEntry.name}@${packageEntry.version} — ${packageEntry.license}`),
    );
  }

  const notices = [
    "PIPA 第三方许可证与归属文本",
    "根据 pnpm-lock.yaml 和 Cargo.lock 生成，请勿手工编辑。",
    "",
    ...[...attributionGroups.values()]
      .sort((left, right) => left.packages[0].localeCompare(right.packages[0]))
      .flatMap((group) => [
        "================================================================================",
        group.packages.sort().join("\n"),
        "--------------------------------------------------------------------------------",
        group.text,
        "",
      ]),
  ];

  writeFileSync("THIRD_PARTY_LICENSES.md", `${inventory.join("\n").trimEnd()}\n`, "utf8");
  writeFileSync("THIRD_PARTY_LICENSES.txt", `${notices.join("\n").trimEnd()}\n`, "utf8");
}

main();
