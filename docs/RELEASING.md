# 发布指南

Pipa 只使用一个规范仓库 [`AlasicPlat/pipa`](https://github.com/AlasicPlat/pipa) 保存源码、Issue、标签和 GitHub Releases。发布包由 GitHub Actions 根据受保护的 `vX.Y.Z` 标签构建；维护者不得在已有标签下上传未签名的替换资产。

## 签名边界

Pipa 使用两套相互独立的签名系统：

- Apple Developer ID 签名与公证为应用和 DMG 建立 macOS 系统信任。
- Tauri Updater 签名使用内置在 `src-tauri/tauri.conf.json` 中的公钥验证 `.app.tar.gz` 更新归档。

Apple 证书及其密码、公证凭据和 Tauri updater 私钥均属于秘密。它们只能保存在 GitHub Actions 加密 Secrets 和受访问控制的离线备份中。只有 updater 公钥可以进入 Git。

仓库需要配置以下 Secrets：

| Secret | 用途 |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 编码的 Developer ID Application 证书包 |
| `APPLE_CERTIFICATE_PASSWORD` | 证书包密码 |
| `APPLE_SIGNING_IDENTITY` | 签名时选择的 Developer ID Application 身份 |
| `APPLE_ID` | `notarytool` 使用的 Apple 账号 |
| `APPLE_PASSWORD` | Apple 专用密码 |
| `APPLE_TEAM_ID` | Apple Developer 团队标识符 |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater 私钥的完整内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater 密钥加密时使用的密码 |

绝不要在日志中打印 Secret 值、将其放入仓库目录、附加到 Release，或传递给由不受信任 Pull Request 触发的工作流。

## 准备发布

1. 确认 `main` 上的 CI 为绿色，且没有未解决的高严重度安全问题。
2. 在可信的 macOS 开发机上运行 `./scripts/verify-project.sh`。
3. 将 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 更新为同一个语义化版本，然后刷新锁文件。
4. 在发布提交中加入面向用户的更新说明，或在打标签前准备好草稿。
5. 将版本提交合入受保护的 `main`。

只能从已评审的 `main` 提交创建并推送附注标签：

```bash
git tag -a "vX.Y.Z" -m "Pipa vX.Y.Z"
git push origin "vX.Y.Z"
```

发布工作流会构建 Apple 芯片和 Intel 包，对其签名并公证，生成 Tauri updater 归档与签名，上传共享的 `latest.json`，并创建 GitHub Release 草稿。草稿状态允许维护者在资产成为 updater 的 `latest` 端点前完成核验。

## 验证草稿

发布前确认以下各项：

- `Pipa-macOS-arm64.dmg` 包含 `arm64` 可执行文件。
- `Pipa-macOS-x64.dmg` 包含 `x86_64` 可执行文件。
- 两个 DMG 均通过 `codesign --verify`、`spctl` Gatekeeper 评估和公证 stapler 校验。
- 两个 `.app.tar.gz` 归档都有匹配的 `.sig` 文件。
- `latest.json` 引用了对应标签版本、两个 macOS 目标和正确的 GitHub Release 资产。
- 已发布旧版本能通过临时测试端点或预发布通道发现草稿，拒绝故意设置的无效签名，安装有效包，并在不丢失持久化工作区数据的情况下重启。

验证完成后发布草稿，并确认以下稳定链接返回预期文件：

```text
https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-arm64.dmg
https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-x64.dmg
https://github.com/AlasicPlat/pipa/releases/latest/download/latest.json
```

不要删除或替换已发布标签。如果某个版本存在问题，应发布更高的补丁版本，确保 updater 签名、Git 历史和用户安装始终可审计。

## 未公证测试版

Apple Developer 会员或协议失效时，可以在维护者明确选择后发布未公证测试版。前提是现有 Developer ID 证书仍可签名。此渠道只提供手动安装的 DMG，不生成 updater 归档、签名或 `latest.json`，也不能替代正式版。

从 `main` 手动触发发布工作流，指定已合入 `main`、版本号一致且尚未公开发布的标签：

```bash
gh workflow run release.yml --ref main -f tag=vX.Y.Z
```

工作流保留 Developer ID 签名，跳过 Apple 公证，并创建标为 Pre-release 的草稿。两个架构均构建成功后，下载 DMG，核对应用版本和架构，验证 DMG 与应用的代码签名。此渠道预期不能通过公证及 Gatekeeper 检查，不应将其误报为通过。

发布说明必须标注“未公证测试版”，提供两个架构的下载说明，并链接 [Apple 的手动允许打开说明](https://support.apple.com/zh-cn/102445)。发布草稿时保留 Pre-release 标记且设置 `--latest=false`；发布后确认 `/releases/latest` 和稳定更新端点仍指向原正式版。不得覆盖已公开发布的版本，也不得把未公证包混入正式版草稿。

CI 与发布构建固定使用 Rust 1.98.1，以避开 Rust 1.99 Clippy 对 `async-trait` 宏的已知误报（[rust-clippy#17529](https://github.com/rust-lang/rust-clippy/issues/17529)）。升级时应同时更新两个工作流并重新验证。

## 轮换 updater 密钥

丢失 updater 私钥会导致现有客户端无法接受后续更新。如果怀疑密钥泄露，应停止发布、保留证据，并发布一个正常经过 Apple 签名的过渡版本，使其应用配置信任替换后的公钥。无法安装过渡版本的用户必须手动更新。请在发布说明和 `SECURITY.md` 中记录密钥轮换。
