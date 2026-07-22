# Pipa

Pipa 是一款本地优先的多数据库桌面查询工作台。本仓库当前交付的是 **MySQL 基础垂直切片**：可以测试、保存和选择 MySQL 连接，在绑定连接的查询标签中执行 SQL，以流式结果表格查看返回值，取消运行中的查询，并在重启后恢复未保存的 SQL 工作区。

界面已经为 MySQL、PostgreSQL、MongoDB 和 Redis 提供严格分离的视觉分区。当前里程碑只有 MySQL 的新增连接、连接测试、保存和查询执行可用；PostgreSQL、MongoDB 与 Redis 的操作入口和查询执行尚未开放。

## 环境要求

- macOS，以及 Xcode Command Line Tools。
- Rust stable 工具链（包含 `cargo`, `rustfmt` 和 `clippy`）。
- Node.js 20.19+（20.x）或 22.12+ 的兼容版本，以及 pnpm。
- Docker Desktop 或等价的 Docker Engine，且支持 Docker Compose v2 和 `--wait`。

首次安装依赖：

```bash
pnpm install --frozen-lockfile
```

## 本地开发

开发模式会启动 Vite 前端和原生 Tauri 窗口：

```bash
pnpm tauri dev
```

应用本身没有远程服务依赖。只有在测试连接或执行查询时，才会访问用户明确配置的数据库。

## MySQL 测试服务

仓库内的 [`infra/test/mysql.compose.yml`](infra/test/mysql.compose.yml) 提供 MySQL 8.4 测试实例：

| 配置 | 值 |
| --- | --- |
| 主机 | `127.0.0.1` |
| 端口 | `33306` |
| 数据库 | `pipa_test` |
| 用户名 | `pipa` |
| 密码 | `pipa_test_password` |
| root 密码 | `pipa_test_root_password` |

单独启动或停止服务：

```bash
docker compose -f infra/test/mysql.compose.yml up -d --wait
docker compose -f infra/test/mysql.compose.yml down
```

这些凭据仅用于仓库内的本地测试容器，不应用于其他环境。

## 完整验证

运行一个命令即可启动测试 MySQL、执行前端与 Rust 质量门禁并构建 debug 桌面包；无论成功、失败或中断，脚本都会停止测试容器：

```bash
./scripts/verify-foundation.sh
```

成功构建后的桌面 bundle 位于 Cargo 工作区的 `target/debug/bundle/`。在 macOS 上，原生应用通常位于 `target/debug/bundle/macos/Pipa.app`，安装镜像位于 `target/debug/bundle/dmg/`。

## 当前交互

- MySQL、PostgreSQL、MongoDB、Redis 连接分别位于独立分区，当前连接使用强化选中态。
- 查询标签绑定创建时的 MySQL 连接；在侧栏选择其他连接不会重绑定已有标签。
- `Ctrl/Cmd + R` 执行编辑器选中内容；没有选区时执行光标所在语句，并阻止 WebView 刷新。
- 查询期间只显示简洁的“查询中…”与取消入口；流式结果底部只显示“正在加载更多…”。
- 查询可取消，结果以有界批次流式返回；大整数和 decimal 以字符串传输，避免 JavaScript 精度损失。
- 工作区会恢复未保存的 SQL 与标签上下文，但不会恢复或永久保存查询结果。

## Rust 架构

| 部分 | 职责 |
| --- | --- |
| `pipa-core` | 与框架无关的连接、查询、结果、错误模型和数据库适配器契约，并生成 TypeScript 边界类型。 |
| `pipa-store` | SQLCipher 加密 SQLite 中的非秘密连接配置、工作区和查询历史，以及系统钥匙串中的数据库密码。 |
| `pipa-mysql` | 基于 SQLx 的 MySQL 连接测试、可取消查询、结果分批和数据库值的无损传输转换。 |
| `src-tauri` | 组合存储与 MySQL 适配器，管理查询生命周期和取消令牌，并通过类型化 Tauri IPC 向 React 界面提供命令。 |

## 本地数据与安全策略

- 非秘密连接配置、工作区和查询历史保存在应用数据目录内的 SQLCipher 加密 SQLite 数据库中。
- 数据库密码和 SQLite 加密密钥只保存在操作系统钥匙串中；密码不写入 SQLite、日志或前端持久化存储。
- 不使用 `localStorage`、`sessionStorage`、浏览器持久化或云端同步保存应用数据。
- 查询结果只存在于当前运行内存中，默认不持久化；重启仅恢复未保存的 SQL 和标签上下文。
- 日志和错误只应包含脱敏后的诊断信息，不包含密码或完整结果数据。

## 常见问题

- `docker compose ... up --wait` 失败：确认 Docker 守护进程正在运行，且宿主机端口 `33306` 未被占用。
- Tauri 启动或打包失败：确认已安装 Xcode Command Line Tools、Rust stable、`rustfmt` 和 `clippy`。
- 应用启动时报安全存储错误：确认当前登录会话允许应用访问 macOS 钥匙串；Pipa 不会回退到明文凭据文件。
