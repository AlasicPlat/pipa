# Pipa 的 GitHub 与个人网站说明

本文档供项目维护与发布使用，说明 Pipa 的私有源码仓库、公开安装包仓库和个人网站之间的关系。文档只记录仓库结构、公开链接和操作约定，不应写入 Apple ID、密码、证书私钥、数据库凭据或 GitHub Token。

## 仓库关系

| 用途 | 仓库 | 可见性 | 本地目录 |
| --- | --- | --- | --- |
| Pipa 源码 | [`AlasicPlat/pipa-source`](https://github.com/AlasicPlat/pipa-source) | 私有 | `/Users/alasic/pipa` |
| Pipa 安装包 | [`AlasicPlat/pipa`](https://github.com/AlasicPlat/pipa) | 公开 | 无固定工作目录 |
| 个人网站 | [`AlasicPlat/AlasicPlat.github.io`](https://github.com/AlasicPlat/AlasicPlat.github.io) | 公开 | `/Users/alasic/AlasicPlat.github.io` |

三个仓库的职责必须保持分离：

- `pipa-source` 保存完整源码、测试和构建配置。
- `pipa` 只保存公开 README、Release 说明和 DMG 安装包，不复制源码。
- `AlasicPlat.github.io` 展示产品文案、截图，并链接到 `pipa` 的公开 Release。

## 当前自动化边界

- `pipa-source` 当前没有 `.github/workflows/`，测试、构建、签名和发布在本机执行。
- `pipa` 不负责构建，只作为公开下载与版本记录仓库。
- 个人网站通过 `.github/workflows/deploy.yml` 自动部署；推送到网站仓库 `main` 后会触发 GitHub Pages。
- Developer ID 证书来自本机钥匙串，Apple 公证使用本机保存的 `alasic-notary` profile。
- 不得把证书私钥、应用专用密码、公证凭据、数据库密码或 Token 提交到任何仓库。

## 版本与安装包约定

发布前同步修改以下版本：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- 版本变更影响依赖锁定信息时，同时提交 `Cargo.lock` 或前端锁文件。

公开 Release 使用 `vX.Y.Z` 标签。每个版本发布两份 DMG：

| 架构 | Release 资产名 | 稳定下载地址 |
| --- | --- | --- |
| Apple 芯片 | `Pipa-macOS-arm64.dmg` | <https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-arm64.dmg> |
| Intel 芯片 | `Pipa-macOS-x64.dmg` | <https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-x64.dmg> |

资产名是公开接口。网站和 README 使用 `releases/latest/download/...`，因此新版本必须继续使用这两个名字。

## 发布流程

### 1. 验证源码并推送私有仓库

常规发布至少运行：

```bash
pnpm test
pnpm build
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

`crates/pipa-mysql/tests/mysql_adapter.rs` 需要本地 MySQL 测试服务。需要完整验证时，先启动 `infra/test/mysql.compose.yml`，或运行仓库提供的完整验证脚本。检查通过后提交并推送 `pipa-source/main`。

### 2. 准备两个 Rust 架构目标

Pipa 默认使用 stable Rust 工具链：

```bash
rustup target add aarch64-apple-darwin
rustup target add x86_64-apple-darwin
```

### 3. 构建签名 DMG

`src-tauri/tauri.conf.json` 中的签名身份为：

```text
Developer ID Application: zhilong Lin (4BH553X7SC)
```

分别构建两个架构：

```bash
pnpm tauri build --target aarch64-apple-darwin --bundles dmg
pnpm tauri build --target x86_64-apple-darwin --bundles dmg
```

典型输出位置：

```text
target/aarch64-apple-darwin/release/bundle/dmg/Pipa_<version>_aarch64.dmg
target/x86_64-apple-darwin/release/bundle/dmg/Pipa_<version>_x64.dmg
```

使用 `lipo -archs` 检查两个原生二进制分别为 `arm64` 和 `x86_64`。对每个最终 DMG 再执行一次带时间戳的签名并验证：

```bash
codesign --force \
  --sign "Developer ID Application: zhilong Lin (4BH553X7SC)" \
  --timestamp \
  "<dmg-path>"
codesign --verify --strict --verbose=2 "<dmg-path>"
```

### 4. Apple 公证与 Gatekeeper 验证

对两份 DMG 分别执行：

```bash
xcrun notarytool submit "<dmg-path>" \
  --keychain-profile "alasic-notary" \
  --wait

xcrun stapler staple "<dmg-path>"
xcrun stapler validate "<dmg-path>"
spctl -a -vv -t install "<dmg-path>"
```

只有在 `notarytool` 返回 `Accepted`、Stapler 验证成功且 `spctl` 显示 `source=Notarized Developer ID` 后，才能上传。

### 5. 创建公开 Release

先把两个已公证 DMG 复制到临时发布目录并改为稳定资产名，再创建 Release。不要把发布目录提交到源码仓库。

```bash
gh release create "v<version>" \
  "Pipa-macOS-arm64.dmg" \
  "Pipa-macOS-x64.dmg" \
  --repo AlasicPlat/pipa \
  --title "Pipa v<version>" \
  --notes-file "<release-notes.md>" \
  --latest
```

公开 Release 说明保持面向用户，只写本次变化和架构选择，不加入 SHA、公证过程、数据库配置或内部构建路径。

### 6. 发布后检查

```bash
gh release view --repo AlasicPlat/pipa
curl -I -L \
  https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-arm64.dmg
curl -I -L \
  https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-x64.dmg
```

确认两个链接最终返回 `200`，并检查公开 README 中的下载入口仍然有效。

## 个人网站关联

生产网站：<https://alasicplat.github.io>

Pipa 在网站仓库中的维护位置：

| 内容 | 位置 |
| --- | --- |
| 产品名称、文案、功能标签和下载链接 | `src/data/site.ts` 中 `slug: "pipa"` 的记录 |
| 亮色截图 | `public/images/pipa-light.png` |
| 暗色截图 | `public/images/pipa-dark.png` |
| 页面结构与下载按钮 | `src/pages/index.astro` |
| 页面样式 | `src/styles/global.css` |
| Pages 部署 | `.github/workflows/deploy.yml` |

当前网站的主下载按钮指向 Apple 芯片资产，版本记录按钮指向公开 Release 页面。Intel 用户可从 Release 页面下载 `Pipa-macOS-x64.dmg`。如果网站增加架构选择，应同时调整 `src/data/site.ts` 的产品数据与 `src/pages/index.astro` 的按钮结构。

只发布新版本且稳定资产名不变时，不需要修改网站链接。以下情况需要同步网站：

- 产品定位、简介、数据库支持范围或功能标签发生变化；
- 亮色或暗色产品截图更新；
- 公开仓库地址或 Release 资产名变化；
- 下载按钮需要新增 Intel 或其他架构入口。

网站修改后运行：

```bash
cd /Users/alasic/AlasicPlat.github.io
npm ci
npm run build
git push origin main
```

推送后使用 `gh run list` 或 `gh run watch` 确认 `Deploy to GitHub Pages` 成功。

## 内容一致性检查

发布或修改产品文案时，应同时核对：

1. `pipa-source/README.md`：面向源码维护者的功能范围和数据库支持边界。
2. `AlasicPlat/pipa/README.md`：面向下载用户的介绍、支持矩阵和双架构入口。
3. `AlasicPlat.github.io/src/data/site.ts`：网站上的短文案、功能标签和下载链接。
4. `AlasicPlat.github.io/public/images/pipa-light.png` 与 `pipa-dark.png`：网站和公开 README 使用的产品截图。

公开 README 当前通过网站地址引用截图。如果网站图片路径改变，必须同步修改 `AlasicPlat/pipa/README.md`。
