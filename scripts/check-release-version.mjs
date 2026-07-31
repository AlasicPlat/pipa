import { readFileSync } from "node:fs";

/**
 * Extracts the package version from the root of one Cargo manifest.
 * @param {string} manifest - Cargo.toml source text.
 * @returns {string} The first package version.
 * Side effects: none.
 */
function readCargoPackageVersion(manifest) {
  const packageSection = manifest.match(/\[package\]([\s\S]*?)(?:\n\[|$)/u)?.[1];
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
  if (!version) {
    throw new Error("src-tauri/Cargo.toml does not declare a package version");
  }
  return version;
}

/**
 * Ensures the release tag and all application version sources agree exactly.
 * Parameters: none.
 * @returns {void}
 * Side effects: reads repository manifests and throws on an unsafe release mismatch.
 */
function main() {
  const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
  if (!tag?.startsWith("v")) {
    throw new Error("Provide a vX.Y.Z tag as GITHUB_REF_NAME or the first argument");
  }
  const expectedVersion = tag.slice(1);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion)) {
    throw new Error(`Release tag is not semantic versioning: ${tag}`);
  }

  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  const tauriVersion = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
  const cargoVersion = readCargoPackageVersion(readFileSync("src-tauri/Cargo.toml", "utf8"));
  const mismatches = [
    ["package.json", packageVersion],
    ["src-tauri/tauri.conf.json", tauriVersion],
    ["src-tauri/Cargo.toml", cargoVersion],
  ].filter(([, version]) => version !== expectedVersion);

  if (mismatches.length > 0) {
    throw new Error(`Release ${tag} does not match ${mismatches.map(([file, version]) => `${file} (${version})`).join(", ")}`);
  }
}

main();
