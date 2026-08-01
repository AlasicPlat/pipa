# Pipa MCP 接入指南

Pipa 内置一个仅监听本机回环地址的 Streamable HTTP MCP 服务，让支持 MCP 的客户端读取 Pipa 中保存的 MySQL 连接、查看表结构、执行受限的只读查询，并离线分析一份或多份 MySQL Binlog。

默认地址：

```text
http://127.0.0.1:3847/mcp
```

当前版本的数据库与 Binlog MCP 工具面向 MySQL，不提供远程监听或 `stdio` 传输。Binlog 工具不依赖已保存的数据库连接。

## 1. 启动 MCP 服务

1. 启动 Pipa；只有数据库查询工具需要预先保存可用的 MySQL 连接，Binlog 工具无需连接。
2. 点击查询工作区顶部的 **MCP** 按钮，打开 **MCP 控制台**。
3. 如需修改默认端口，在“端口”输入框中填写 `1` 到 `65535` 之间的端口并点击“应用”。
4. 点击“启动”，确认状态变为“运行中”。
5. 复制面板中的 URL、Token 或完整的 Cursor 配置。

“是否指定连接”用于控制 MCP 的连接访问范围：

- 关闭时，`list_connections` 返回全部已保存连接，其他工具可使用其中任意受支持的 MySQL 连接。
- 开启时，必须选择至少一个“MCP 目标连接”；可同时勾选多个连接，`list_connections` 只返回这些连接，其他连接 ID 会被后端拒绝。
- 切换范围或目标连接列表会立即作用于现有 MCP 会话，不会重启服务或重新生成 Token。
- 返回的连接对象包含 `engine` 字段，例如 `my_sql` 或 `redis`，用于区分同名连接。

启动成功后，面板会显示：

- URL，例如 `http://127.0.0.1:3847/mcp`。
- 当前 Bearer Token。
- 可直接复制的 Cursor 配置片段。

服务启动状态会保存；如果保持启用，Pipa 下次启动时会自动启动 MCP。Token 只存在于当前进程内存中，每次启动服务、重新生成 Token 或在运行时更换端口后都会变化。Token 变化后必须更新 MCP 客户端配置。

## 2. 连接 Cursor

Cursor 支持 Streamable HTTP MCP。配置文件可放在以下位置：

- 全局配置：`~/.cursor/mcp.json`，适合个人电脑使用。
- 项目配置：项目根目录下的 `.cursor/mcp.json`，只对当前项目生效。

配置位置以 [Cursor MCP 官方文档](https://docs.cursor.com/context/model-context-protocol) 为准。

推荐直接点击 Pipa MCP 控制台中的“复制配置”，再把 `pipa` 节点合并到已有的 `mcpServers` 中。不要覆盖文件中已有的其他 MCP 服务。

手动配置示例：

```json
{
  "mcpServers": {
    "pipa": {
      "url": "http://127.0.0.1:3847/mcp",
      "headers": {
        "Authorization": "Bearer <PIPA_MCP_TOKEN>"
      }
    }
  }
}
```

将 `<PIPA_MCP_TOKEN>` 替换为 Pipa 面板当前显示的 Token。保存配置后，在 Cursor 的 **Settings → Tools & MCP** 中确认 `pipa` 已启用；必要时重新加载 Cursor 窗口。

> 不要把真实 Token 提交到 Git。由于 Token 会随服务重启而变化，项目级 `.cursor/mcp.json` 更适合作为本地文件使用；个人使用时优先选择全局配置。

## 3. 连接其他 MCP 客户端

其他客户端需要同时满足：

- 支持 Streamable HTTP MCP。
- 支持为 HTTP 请求添加自定义 Header。
- 能访问 Pipa 所在电脑的 `127.0.0.1`。

使用以下参数：

| 参数 | 值 |
| --- | --- |
| Transport | Streamable HTTP |
| URL | `http://127.0.0.1:3847/mcp`，或面板显示的实际 URL |
| Header | `Authorization: Bearer <PIPA_MCP_TOKEN>` |

Pipa 只监听 `127.0.0.1`，因此虚拟机、容器、SSH 远端、云端 Agent 或另一台电脑不能直接通过该地址连接。不要为了远程连接而把服务暴露到公网。

## 4. 验证联通性

### 检查监听端口

macOS：

```bash
lsof -nP -iTCP:3847 -sTCP:LISTEN
```

正常情况下可以看到 `pipa-app` 监听 `127.0.0.1:3847`。

### 检查鉴权

不带 Token 的请求应返回 `401 Unauthorized`：

```bash
curl --noproxy 127.0.0.1 -i --max-time 5 \
  http://127.0.0.1:3847/mcp
```

### 执行 MCP 初始化握手

以下命令中的 Token 仅作占位。避免把真实 Token 留在 shell 历史、日志或截图中。

```bash
curl --noproxy 127.0.0.1 -i --max-time 10 \
  -H "Authorization: Bearer <PIPA_MCP_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": {
        "name": "pipa-connectivity-check",
        "version": "1.0.0"
      }
    }
  }' \
  http://127.0.0.1:3847/mcp
```

正常响应包括：

- HTTP `200 OK`。
- `content-type: text/event-stream`。
- `mcp-session-id` 响应头。
- JSON-RPC `initialize` 结果。

日常使用不需要手动执行这些命令，MCP 客户端会自动完成初始化和会话管理。

## 5. 可用工具

| 工具 | 用途 | 是否直接执行 SQL |
| --- | --- | --- |
| `list_connections` | 按当前 MCP 连接范围列出非密码连接信息（包含 `engine` 类型标识） | 否 |
| `list_tables` | 对指定 MySQL 连接执行 `SHOW FULL TABLES` | 是，只读 |
| `describe_table` | 查看指定 MySQL 表结构 | 是，只读 |
| `run_readonly_query` | 执行通过安全策略的只读 SQL | 是，只读 |
| `propose_sql` | 把 SQL 放入 Pipa 的待确认队列 | 否 |
| `binlog_import` | 按顺序导入多份本机路径或多份 Base64 文件，立即返回 `analysisId` | 否 |
| `binlog_get_summary` | 轮询解析状态、文件摘要、表聚合与诊断 | 否 |
| `binlog_list_transactions` | 按库、表、操作类型过滤并分页读取事务时间线 | 否 |
| `binlog_get_transaction` | 按序号读取事务及 Before/After 行镜像 | 否 |
| `binlog_get_reset_sql` | 为已提交事务生成但不执行 Reset SQL | 否 |
| `binlog_close` | 取消未完成解析并释放临时文件与内存结果 | 否 |

调用数据库工具前，客户端通常应先调用 `list_connections`，取得当前范围内目标连接的 `connection_id`。开启“是否指定连接”后，尝试使用未选中的连接 ID 会被拒绝。

只读查询结果最多返回 200 行。结果超过限制时会标记为截断，并取消继续读取数据库结果。

### Binlog 多文件导入

`binlog_import` 必须且只能选择一种输入：

- `file_paths`：Pipa 所在电脑上的有序文件路径，适合大文件，单次最多 256 个。
- `files`：包含 `name` 与 `content_base64` 的有序数组，适合客户端直接上传；单次最多 32 个，解码后合计不超过 64 MiB。

内联上传示例：

```json
{
  "files": [
    {
      "name": "mysql-bin.000001",
      "content_base64": "<BASE64_BYTES>"
    },
    {
      "name": "mysql-bin.000002",
      "content_base64": "<BASE64_BYTES>"
    }
  ]
}
```

大文件的本机路径示例：

```json
{
  "file_paths": [
    "/var/lib/mysql/mysql-bin.000001",
    "/var/lib/mysql/mysql-bin.000002"
  ]
}
```

导入是异步的：保存 `binlog_import` 返回的 `analysisId`，通过 `binlog_get_summary` 轮询，状态不再是 `importing` 后再调用事务工具。使用完毕应调用 `binlog_close`。内联文件保存在私有临时目录中，并在解析结束后自动删除。

Reset SQL 按原事务的逆序生成，但不会执行或进入 SQL 确认队列。Binlog 不携带主键定义，因此 UPDATE/DELETE 定位使用所有可重建当前值的 `<=>` 条件与 `LIMIT 1`；执行前仍必须人工检查。DDL、未提交事务、缺失真实列名或不完整的 DELETE Before 镜像会返回 warning，而不会生成具有误导性的 SQL。

## 6. SQL 安全策略

MCP 自动执行使用多层限制：

1. 只允许可可靠识别的单条只读 SQL。
2. 使用大小写不敏感的危险关键字正则拒绝写入、DDL、权限、事务、锁、文件、管理命令及副作用函数。
3. MySQL 会话本身设置为数据库强制只读。
4. 查询结果达到行数限制后主动取消上游读取。

例如以下 SQL 不会由 MCP 自动执行：

```sql
DELETE FROM users;
DROP TABLE users;
SELECT * FROM users FOR UPDATE;
SELECT GET_LOCK('example', 10);
SELECT SLEEP(10);
SELECT LOAD_FILE('/path/to/file');
```

DML、DDL 或其他需要修改数据库的 SQL 应调用 `propose_sql`。该工具只创建待确认项，不执行 SQL。用户需要在 Pipa MCP 控制台中检查内容并点击“确认执行”；也可以直接忽略该提案。

Pipa MCP 控制台中的“手动 SQL”由用户在桌面应用内主动执行，不走 MCP 自动执行的只读限制。

## 7. Token 与权限

- Token 是 256-bit 随机值，仅保存在 Pipa 当前进程内存中。
- 所有 MCP HTTP 请求都必须携带 `Authorization: Bearer <TOKEN>`。
- 服务停止后，旧 Token 立即失效。
- 点击“重新生成 Token”会重启服务并使旧 Token 失效。
- 运行时修改端口会重启服务，因此也会生成新 Token。
- 不要把 Token 放进仓库、Issue、聊天记录、日志或截图。
- 怀疑 Token 泄露时，立即在 MCP 控制台点击“重新生成 Token”，然后更新客户端配置。

虽然服务只监听本机回环地址，同一系统用户下的其他本地进程仍可能尝试访问它。应继续使用操作系统账号隔离、磁盘加密和最小权限数据库账号。

## 8. 常见问题

### `Connection refused` 或无法连接

1. 确认 Pipa 正在运行。
2. 打开 MCP 控制台，确认状态是“运行中”。
3. 确认客户端 URL 与面板显示完全一致。
4. 使用 `lsof` 检查端口。
5. 如果端口被占用，在 Pipa 中更换端口并重新复制配置。

### 返回 `401 Unauthorized`

- 确认 Header 名称是 `Authorization`。
- 确认值以 `Bearer ` 开头，且后面没有多余引号或换行。
- Pipa 重启、MCP 重启、Token 重新生成或端口变更后，重新复制配置。
- 更新配置后重新加载 MCP 客户端。

### 本机请求被代理拦截

某些代理工具会接管 `127.0.0.1` 请求。为本机地址设置代理例外：

```bash
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="127.0.0.1,localhost"
```

命令行测试也可以使用：

```bash
curl --noproxy 127.0.0.1 ...
```

### 客户端看不到工具

1. 确认配置文件位于客户端实际读取的位置。
2. 检查 JSON 是否有效，以及 `pipa` 是否位于 `mcpServers` 下。
3. 在客户端设置中启用 `pipa`。
4. 重新加载客户端窗口。
5. 检查客户端的 MCP 日志是否包含 `401`、端口错误或代理错误。

### 工具存在，但数据库操作失败

- 当前 MCP 工具只支持 MySQL 连接。
- 先调用 `list_connections`，使用返回的 UUID 作为 `connection_id`。
- 在 Pipa 工作台中先测试该数据库连接。
- 确认数据库网络、TLS、账号权限和密码仍然有效。
- 如果 SQL 命中了只读或危险关键字策略，改用 `propose_sql` 并在 Pipa 中确认。

### Binlog 上传或解析失败

- `files` 与 `file_paths` 不能同时提供，也不能同时为空。
- 内联上传必须使用标准 Base64，文件名只能是普通文件名，不能包含目录或 `..`。
- 超过 64 MiB 的内联内容应改用 Pipa 主机上的 `file_paths`。
- 多份文件按参数顺序解析；应按 Binlog 序号升序传入连续文件。
- 解析结束后调用 `binlog_get_summary` 查看 CRC32、截断、兼容性等诊断。

### 写入 SQL 没有立即执行

这是预期的安全行为。写入或结构变更必须进入“待确认 SQL”队列，并由用户在 Pipa 中明确确认后执行。
