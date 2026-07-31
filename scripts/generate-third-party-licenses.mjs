import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu;

/**
 * Escapes one table cell without changing its human-readable content.
 * @param {unknown} value - Value written into Markdown.
 * @returns {string} A single-line, pipe-safe cell.
 * Side effects: none.
 */
function markdownCell(value) {
  return String(value ?? "UNKNOWN").replaceAll("|", "\\|").replaceAll(/\s+/gu, " ").trim();
}

/**
 * Normalizes upstream notice formatting without changing its legal text.
 * @param {string} value - Raw UTF-8 attribution file content.
 * @returns {string} LF-delimited text without trailing line whitespace.
 * Side effects: none.
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
 * Reads top-level license and notice files from an installed package directory.
 * @param {string} packageRoot - Absolute package directory discovered from package metadata.
 * @returns {Array<{name: string, text: string}>} Stable list of attribution files.
 * Side effects: reads installed dependency files.
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
 * Converts pnpm's license grouping into one installed-package record per version.
 * @returns {Array<{ecosystem: string, name: string, version: string, license: string, root: string}>} Production npm dependency records.
 * Side effects: invokes pnpm and reads its installed package index.
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
 * Loads every registry dependency resolved by Cargo.lock, including target-specific crates.
 * @returns {Array<{ecosystem: string, name: string, version: string, license: string, root: string}>} Rust dependency records.
 * Side effects: invokes Cargo, which may populate its local registry cache.
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
 * Produces the checked-in dependency inventory and deduplicated verbatim attribution texts.
 * Parameters: none.
 * @returns {void}
 * Side effects: invokes package managers, reads dependency license files, and rewrites two repository reports.
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
    "# Third-party licenses",
    "",
    "This file is generated from the production pnpm graph and the complete Cargo.lock graph. Dependency authors retain their respective copyrights; Pipa's Apache-2.0 license does not replace any third-party license.",
    "",
    "Run `pnpm licenses:generate` after dependency changes. Release builds bundle this inventory and the verbatim attribution file `THIRD_PARTY_LICENSES.txt`.",
    "",
    "| Ecosystem | Package | Version | Declared license |",
    "| --- | --- | --- | --- |",
    ...packages.map((packageEntry) => `| ${markdownCell(packageEntry.ecosystem)} | ${markdownCell(packageEntry.name)} | ${markdownCell(packageEntry.version)} | ${markdownCell(packageEntry.license)} |`),
  ];

  if (missingAttribution.length > 0) {
    inventory.push(
      "",
      "## Metadata-only entries",
      "",
      "The following installed packages declared a license identifier but did not expose a top-level license/notice file. Review them manually before a public release:",
      "",
      ...missingAttribution.map((packageEntry) => `- ${packageEntry.ecosystem}:${packageEntry.name}@${packageEntry.version} — ${packageEntry.license}`),
    );
  }

  const notices = [
    "PIPA THIRD-PARTY LICENSE AND ATTRIBUTION TEXTS",
    "Generated from pnpm-lock.yaml and Cargo.lock; do not edit manually.",
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
