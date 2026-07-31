# 安全策略

## 支持版本

安全修复仅面向最新发布的 Pipa 版本。用户应更新到 [Releases 页面](https://github.com/AlasicPlat/pipa/releases/latest)展示的最新版本。

## 报告漏洞

请使用仓库 **Security** 页签下的 GitHub 私密漏洞报告入口，并提供受影响版本、macOS 架构、影响、复现步骤和最小化概念验证。

不要创建包含凭据、连接串、数据库内容、更新器或 Apple 签名材料、MCP Bearer Token，或尚未修复利用方式的公开 Issue。如果私密漏洞报告入口暂时不可用，请先私下联系 [@AlasicPlat](https://github.com/AlasicPlat)，再共享敏感细节。

你应在七天内收到确认。维护者会验证报告、协调修复和披露时间，并在报告者未要求匿名时予以致谢。

## 安全模型

- Pipa 以本地优先，但会连接用户配置的数据库，并通过 GitHub Releases 获取签名更新。
- MCP 只绑定回环接口，并要求使用可轮换的 Bearer Token。
- 连接数据保存在 SQLCipher 数据库中。bootstrap key 位于同一私有应用数据目录，因此 Pipa 不宣称能够抵御有权读取整个目录的其他进程。
- 查询结果和 Binlog 分析仅保留在进程内存中，默认不持久化。
- 更新归档必须通过 Tauri 签名验证；macOS 发布包还必须经过 Developer ID 签名与公证。

运行细节与依赖风险接受记录位于 `docs/security/`。
