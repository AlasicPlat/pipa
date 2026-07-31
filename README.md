<div align="center">
  <img src="https://alasicplat.github.io/brand/alasic.png" width="72" height="72" alt="Alasic" />

  # Pipa（枇杷）

  **让数据库工作区保持清爽、专注。**

  面向 macOS 的本地优先数据库查询工作台，由 [Alasic333](https://github.com/AlasicPlat) 创建并维护。

  [![Latest release](https://img.shields.io/github/v/release/AlasicPlat/pipa?label=latest)](https://github.com/AlasicPlat/pipa/releases/latest)
  [![CI](https://github.com/AlasicPlat/pipa/actions/workflows/ci.yml/badge.svg)](https://github.com/AlasicPlat/pipa/actions/workflows/ci.yml)
  [![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
  ![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-111111?logo=apple&logoColor=white)

  [下载 Apple 芯片版](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-arm64.dmg)
  ·
  [下载 Intel 芯片版](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-x64.dmg)
</div>

<p align="center">
  <img src="https://alasicplat.github.io/images/pipa-cover.png" width="100%" alt="Pipa 数据库连接与查询工作区" />
</p>

## Pipa 是什么

Pipa 为日常数据库查询与故障排查提供一个安静、清晰的桌面工作区：集中整理连接，在独立标签中编写 SQL，以流式结果表格查看数据，离线分析 MySQL Binlog 事务，并通过受控的本机 MCP 服务让 AI 工具读取数据库结构和分析日志。

应用不依赖 Pipa 自建云端服务。它只会访问用户明确配置的数据库、本机回环地址上的 MCP 服务，以及用于检查和下载软件更新的 GitHub Releases；Monaco 编辑器等运行时代码均随应用本地打包。

## 当前能力

- 创建、测试、重命名和整理 MySQL、Redis 连接。
- 在绑定 MySQL 连接的查询标签中编写与执行 SQL。
- 离线导入一份或多份 MySQL Binlog，按事务查看 GTID/XID、表影响与 Before/After 行镜像，并按库、表和操作类型过滤。
- 为具备完整行镜像的已提交事务生成 review-first Reset SQL；无法安全还原的变更会明确跳过。
- 浏览 Redis 数据库与键，在不同 DB 之间切换，并执行 Redis 原生命令。
- 查看 String、Hash、List、Set、Sorted Set、Stream 与 RedisJSON 等键详情。
- 执行选中 SQL 或光标所在语句，并可取消运行中的查询。
- 流式展示查询结果，保留大整数和精确小数的原始语义。
- 在工作区之间切换时保留本次运行内的编辑器与查询结果状态。
- 结果区支持区域选择、搜索、排序、列宽调整，以及 CSV、TSV、JSON、Markdown、SQL INSERT 与 IN 列表导出。
- 通过 MCP 控制台向本机 AI 工具提供带连接作用域的数据库访问。
- 重启后恢复未保存的 SQL 与标签上下文；查询结果不会被永久保存。
- 跟随系统或手动切换亮色、暗色外观。

## 数据库支持

| 数据库 | 当前支持 |
| --- | --- |
| MySQL | 连接管理、连接测试、SQL 查询、离线 Binlog 分析与 MCP 只读访问 |
| Redis | 连接管理、数据库切换、键浏览、键详情与原生命令执行 |
| PostgreSQL | 界面位置已预留，连接与查询尚未开放 |
| MongoDB | 界面位置已预留，连接与查询尚未开放 |

## 下载、安装与更新

| Mac 类型 | 安装包 |
| --- | --- |
| Apple 芯片（M1 / M2 / M3 / M4 等） | [下载 `Pipa-macOS-arm64.dmg`](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-arm64.dmg) |
| Intel 芯片 | [下载 `Pipa-macOS-x64.dmg`](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-x64.dmg) |

下载后打开 DMG，将 Pipa 拖入“应用程序”文件夹即可。历史版本与更新说明可在 [Releases](https://github.com/AlasicPlat/pipa/releases) 查看。

新版本通过 GitHub Releases 发布。Pipa 会在应用内检查 `latest.json`，只安装由项目 updater 私钥签名且能通过内置公钥验证的更新包；Apple Developer ID 签名与公证则负责 macOS 安装和系统信任。两套签名相互独立，任何一套私钥都不会进入本仓库。

## MCP 集成

- MCP 服务只监听本机回环地址，使用 Bearer Token 鉴权，可在控制台启停或轮换 Token。
- 可向 MCP 开放全部已保存连接，或只指定一个目标连接；开启限制后，其他连接 ID 会被后端拒绝。
- 当前支持 MySQL 表列表、表结构和受 SQL 策略保护的只读查询。
- Binlog 工具无需数据库连接，可导入本机路径或 Base64 文件并查询摘要、事务时间线、行镜像与 Reset SQL。
- DML/DDL 不会由 MCP 直接执行，只会进入 Pipa 待确认队列。

完整接入方式和安全边界见 [MCP_CONNECTION_GUIDE.md](MCP_CONNECTION_GUIDE.md)。

## 本地数据与安全边界

- 连接配置、数据库密码、工作区和查询历史保存在应用数据目录内的 SQLCipher 加密数据库 `pipa-data.db`。
- 解锁主库所需的随机 root key 位于同一应用数据目录的 `pipa-bootstrap.db`。Unix 系统上目录尽可能限制为 `0700`，bootstrap 文件限制为 `0600`。
- 这套设计主要防止主数据库文件被单独复制或直接检查时泄露内容。能够读取当前用户整个应用数据目录的进程也能取得 bootstrap key 并解密主库；它不替代独立操作系统账号、FileVault 等磁盘加密和文件权限保护。
- 数据库密码、SQL、查询结果和连接数据不会写入浏览器存储。`localStorage` 只保存主题、快捷键和侧栏状态等非敏感 UI 偏好。
- 查询结果和 Binlog 分析只存在于当前进程内存，关闭相应工作区或退出应用后释放。
- MCP token 仅用于本机回环服务，支持随时轮换；日志和错误输出保持脱敏。
- Tauri WebView 使用限制性 CSP，编辑器脚本与 Worker 均从应用包加载。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中提交密码、连接串、私钥或未脱敏的结果数据。

## 本地开发

### 环境要求

- macOS，以及 Xcode Command Line Tools。
- Rust stable 工具链，包含 `cargo`、`rustfmt` 和 `clippy`。
- Node.js 20.19+ 或 22.12+，以及 pnpm 11。
- Docker Desktop 或等价的 Docker Engine，用于 MySQL 集成测试。

安装依赖并启动 Tauri 开发窗口：

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

### 完整验证

仓库内的 `infra/test/mysql.compose.yml` 提供隔离的 MySQL 8.4 测试实例。以下脚本会启动测试数据库，执行前端测试与构建、Rust 格式/测试/Clippy、生成绑定一致性检查和 debug 桌面打包，结束时自动停止容器：

```bash
./scripts/verify-foundation.sh
```

也可以按需单独执行：

```bash
pnpm test
pnpm build
pnpm bindings:check
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

测试容器使用的 `pipa` / `pipa_test_password` 只适用于仓库内的 `127.0.0.1:33306` 测试服务，不应用于任何其他环境。

## 架构

| 部分 | 职责 |
| --- | --- |
| `pipa-core` | 连接、查询、结果、错误模型、SQL 风险策略和适配器契约，并生成 TypeScript 边界类型。 |
| `pipa-binlog` | 流式解析本地 MySQL Binlog，校验完整性，组装事务与行镜像。 |
| `pipa-store` | 在 SQLCipher SQLite 中原子保存连接、密码、工作区、查询历史和 MCP 设置。 |
| `pipa-mysql` | 基于 SQLx 的 MySQL 连接测试、可取消查询、分批结果与无损值转换。 |
| `pipa-redis` | 基于有界 RESP 编解码的 Redis 连接、ACL 认证、数据库选择与命令执行。 |
| `src-tauri` | 组合本地存储与适配器，通过 Tauri IPC 提供命令，并托管本机 MCP 服务。 |

## 参与贡献

提交 Issue 或 Pull Request 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [行为准则](CODE_OF_CONDUCT.md)。发布和签名流程见 [docs/RELEASING.md](docs/RELEASING.md)。

Pipa 由 [Alasic333](https://github.com/AlasicPlat) 创建，完整作者与贡献者归属记录在 [AUTHORS.md](AUTHORS.md) 和 Git 历史中。

## 许可证

Pipa 源代码采用 [Apache License 2.0](LICENSE)。它允许使用、修改、分发和商业使用，并要求保留许可证与归属声明；贡献还受其中明确的专利授权条款约束。第三方组件遵循各自许可证，摘要见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

更多作品：[alasicplat.github.io](https://alasicplat.github.io)
