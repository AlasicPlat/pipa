# 为 Pipa 贡献代码

感谢你帮助改进 Pipa。提交贡献即表示你同意该贡献按 Apache License 2.0 授权。

## 提交变更前

- 需要产品讨论的行为变更请先创建 Issue；安全问题必须改按 `SECURITY.md` 私下报告。
- 保持变更聚焦，不要在同一个 Pull Request 中混入无关格式调整或重构。
- 绝不要提交真实凭据、连接串、数据库转储、证书或签名密钥。
- 添加或更新测试，用于复现缺陷或验证新行为。
- 为函数、类和不明显的逻辑编写说明，包括参数、返回值和副作用。

## 开发环境

安装 Node.js 20.19+ 或 22.12+、pnpm 11、Rust stable、Xcode Command Line Tools 和 Docker，然后运行：

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

使用 `./scripts/verify-project.sh` 执行完整本地门禁，其中包含 MySQL 集成服务。较小变更可先运行相关测试，最后执行：

```bash
pnpm test
pnpm build
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

如果 Rust 传输类型发生变化，请运行 `pnpm bindings:generate` 并提交生成的 `src/bindings` 文件。CI 会拒绝生成绑定漂移。

## 提交与 Pull Request

提交标题应简短、使用祈使语气并描述结果。推荐使用 `fix:`、`feat:`、`docs:`、`test:`、`build:` 和 `chore:` 等约定前缀。机械生成的改动应与产生它的源码变更放在同一提交中。

Pull Request 应说明问题、所选方案、已执行的验证、用户可见影响，以及安全或迁移方面的考虑。界面变更在截图能明显帮助评审时应附上截图。
