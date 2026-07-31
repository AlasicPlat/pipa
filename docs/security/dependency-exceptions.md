# 依赖安全例外

负责人：[@AlasicPlat](https://github.com/AlasicPlat)

下次强制复核日期：**2026-10-31**，并且每次公开发布前都必须复核。

`scripts/audit-rust.sh` 会执行一次 macOS 产品依赖图审计和一次完整锁文件审计。列入例外并不表示安全公告不成立，而是基于可达性作出的限时决策。新的漏洞 ID 仍会自动使 CI 失败。

## RUSTSEC-2026-0194 与 RUSTSEC-2026-0195 — quick-xml 0.39.4

- 状态：仅对跨平台锁文件接受至 2026-10-31。
- 路径：`tauri-plugin-clipboard-manager -> arboard -> wl-clipboard-rs -> wayland-scanner -> quick-xml`。
- 可达性：受影响的解析器是 Linux Wayland 构建期/proc-macro 依赖。它不存在于受支持的 Apple 芯片和 Intel macOS 运行时依赖图中，Pipa 也不会向其传入用户 XML。
- 上游约束：`wayland-scanner 0.31.10` 要求 `quick-xml = "0.39"`；修复后的解析器从 0.41 开始。
- 退出条件：当 Tauri clipboard/Wayland 依赖链接受 quick-xml 0.41+ 时升级，或在发布任何 Linux 版本前移除此例外。

## RUSTSEC-2023-0071 — rsa 0.10.0-rc.18

- 状态：对当前 MySQL 认证路径接受至 2026-10-31。
- 路径：`pipa-mysql -> sqlx-mysql -> rsa`。
- 可达性：在没有传输层 TLS 的情况下协商 `caching_sha2_password` 时，SQLx 使用该依赖以 MySQL 服务器公钥加密密码。Pipa 不加载 RSA 私钥，也不执行私钥操作；Marvin 安全公告关注的是私钥操作中的计时泄漏。
- 缓解措施：TLS 模式仍可用，在不受信任网络中应强制使用。Pipa 不会通过 IPC 或 MCP 暴露 RSA 私钥操作。
- 退出条件：通过 SQLx 采用上游恒定时间 RSA 版本；如果产品兼容性允许，也可以强制 TLS 并移除 SQLx 的 `rsa` feature。

## Linux 提示性警告

完整锁文件当前通过 Tauri 的 Linux WebKit/GTK 依赖图包含已停止维护的 GTK3 绑定，以及针对 `glib 0.18.5` 的 `RUSTSEC-2024-0429`。Pipa 只发布 macOS 包，因此这些 crate 不会编译进受支持产品。提示性警告会继续显示在 CI 中，而不会被全局隐藏。将 Linux 加入受支持目标前，必须解决这些警告或单独重新评审。

## 2026-07-31 审查中已解决

- `RUSTSEC-2026-0221`：已在 `Cargo.lock` 中将 `event-listener` 从 5.4.1 更新到修复后的 5.4.2。
- 当前 macOS 依赖图已使用修复后的 `quick-xml 0.41`；只有 Linux Wayland 构建链仍保留 0.39.4。
