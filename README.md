# Pipa

Pipa 是一款本地优先的多数据库桌面查询工作台。当前支持 MySQL 连接管理与 SQL 查询、Redis 连接管理、流式结果处理、多格式导出，以及仅监听本机回环地址的 MCP 服务；连接配置、未保存的 SQL 和查询历史均保存在本机。

界面为 MySQL、PostgreSQL、MongoDB 和 Redis 提供严格分离的视觉分区。MySQL 支持新增连接、连接测试、保存和查询执行；Redis 支持连接管理与测试，命令工作台尚未开放；PostgreSQL 与 MongoDB 当前只预留界面位置。

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

- MySQL、PostgreSQL、MongoDB、Redis 连接分别位于独立分区，MySQL 与 Redis 支持连接管理和测试。
- 查询标签绑定创建时的 MySQL 连接；在侧栏选择其他连接不会重绑定已有标签。
- `Ctrl/Cmd + R` 执行编辑器选中内容；没有选区时执行光标所在语句，并阻止 WebView 刷新。
- 查询期间只显示简洁的“查询中…”与取消入口；流式结果底部只显示“正在加载更多…”。
- 查询可取消，结果以有界批次流式返回；大整数和 decimal 以字符串传输，避免 JavaScript 精度损失。
- 结果区支持单元格与区域选择、搜索、排序和列宽调整，并可复制或导出 CSV、TSV、JSON、Markdown、SQL INSERT 与 IN 列表。
- 工作区会恢复未保存的 SQL 与标签上下文，但不会恢复或永久保存查询结果。

## MCP 本地服务

- MCP 控制台提供本机 Streamable HTTP 地址、Bearer Token、服务启停和 Token 轮换，并支持紧凑/展开两种操作布局。
- “是否指定连接”关闭时，`list_connections` 返回全部已保存连接；开启时只返回选中的目标连接，后端同时拒绝其他连接 ID。
- 连接元数据包含 `engine` 字段，可区分 MySQL、PostgreSQL、MongoDB 和 Redis 的同名连接。
- 当前 MCP 数据库工具支持 MySQL 表列表、表结构和只读查询；DML/DDL 只能提交到 Pipa 待确认队列，由用户在控制台确认后执行。

完整接入方式和安全边界见 [`MCP_CONNECTION_GUIDE.md`](MCP_CONNECTION_GUIDE.md)。

## Rust 架构

| 部分 | 职责 |
| --- | --- |
| `pipa-core` | 与框架无关的连接、查询、结果、错误模型、SQL 风险策略和数据库适配器契约，并生成 TypeScript 边界类型。 |
| `pipa-store` | 在 SQLCipher 加密 SQLite 中原子保存连接配置与密码，并持久化工作区、查询历史和 MCP 设置。 |
| `pipa-mysql` | 基于 SQLx 的 MySQL 连接测试、可取消查询、结果分批和数据库值的无损传输转换。 |
| `src-tauri` | 组合本地存储与数据库适配器，通过类型化 Tauri IPC 提供命令，并托管带连接作用域和确认队列的本机 MCP 服务。 |

## 本地数据与安全策略

- 连接配置、数据库密码、工作区和查询历史保存在应用数据目录内的 `pipa-data.db`；该数据库由 SQLCipher 整库加密，配置与密码在同一事务中保存。
- 随机 32-byte SQLCipher root key 单独保存在未加密的 `pipa-bootstrap.db`，因为解锁主库的 key 不能存进主库自身。Bootstrap 先在同目录私有临时库中完整事务提交并同步，再以不覆盖已有文件的方式原子发布；进程崩溃最多留下启动时会忽略的唯一临时文件，不会留下半初始化的最终文件。
- Unix 系统上应用数据目录尽可能限制为 `0700`，bootstrap 最终文件和临时文件限制为 `0600`，并使用 DELETE journal 与 FULL 同步。
- 本地威胁模型明确接受：能够读取当前用户应用数据目录的进程，也能取得 bootstrap root key 并解密主库。SQLCipher 主要防止数据库文件被单独复制或直接检查时泄露内容；它不替代操作系统账号、磁盘加密和文件权限保护。
- Pipa 不访问系统钥匙串，也不迁移旧版密钥或连接。旧 `pipa.db`、`pipa.db-wal` 和 `pipa.db-shm` 会被原样忽略并保留为备份；升级后需要在新数据库中重新添加连接。
- 数据库密码不会写入日志或前端持久化存储，错误与 Debug 输出保持脱敏。
- 不使用 `localStorage`、`sessionStorage`、浏览器持久化或云端同步保存应用数据。
- 查询结果只存在于当前运行内存中，默认不持久化；重启仅恢复未保存的 SQL 和标签上下文。
- 日志和错误只应包含脱敏后的诊断信息，不包含密码或完整结果数据。

## 常见问题

- `docker compose ... up --wait` 失败：确认 Docker 守护进程正在运行，且宿主机端口 `33306` 未被占用。
- Tauri 启动或打包失败：确认已安装 Xcode Command Line Tools、Rust stable、`rustfmt` 和 `clippy`。
- 旧版本升级后看不到原连接：这是新本地密钥策略的预期行为，请重新添加连接；旧 `pipa.db` 及其 sidecar 不会被修改或删除。
