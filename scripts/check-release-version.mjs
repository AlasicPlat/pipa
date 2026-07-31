import { readFileSync } from "node:fs";

/**
 * 从 Cargo 清单的根 package 中提取版本号。
 * @param {string} manifest - Cargo.toml 源文本。
 * @returns {string} 第一个 package 的版本号。
 * 副作用：无。
 */
function readCargoPackageVersion(manifest) {
  const packageSection = manifest.match(/\[package\]([\s\S]*?)(?:\n\[|$)/u)?.[1];
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
  if (!version) {
    throw new Error("src-tauri/Cargo.toml 未声明 package 版本");
  }
  return version;
}

/**
 * 确保发布标签与所有应用版本来源完全一致。
 * 参数：无。
 * @returns {void}
 * 副作用：读取仓库清单；发现不安全的版本不一致时抛出错误。
 */
function main() {
  const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
  if (!tag?.startsWith("v")) {
    throw new Error("请通过 GITHUB_REF_NAME 或第一个参数提供 vX.Y.Z 标签");
  }
  const expectedVersion = tag.slice(1);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion)) {
    throw new Error(`发布标签不符合语义化版本：${tag}`);
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
    throw new Error(`发布版本 ${tag} 与以下文件不一致：${mismatches.map(([file, version]) => `${file} (${version})`).join(", ")}`);
  }
}

main();
