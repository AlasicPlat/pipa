<div align="center">
  <img src="https://alasicplat.github.io/brand/alasic.png" width="72" height="72" alt="Alasic" />

  # Pipa（枇杷）

  **让数据库工作区保持清爽、专注。**

  面向 macOS 的本地优先数据库查询工作台。

  [![Latest release](https://img.shields.io/github/v/release/AlasicPlat/pipa?label=latest)](https://github.com/AlasicPlat/pipa/releases/latest)
  ![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-111111?logo=apple&logoColor=white)

  [下载 Apple 芯片版](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-arm64.dmg)
  ·
  [下载 Intel 芯片版](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-x64.dmg)
</div>

<p align="center">
  <img src="https://alasicplat.github.io/images/pipa-cover.png" width="100%" alt="Pipa 数据库连接与查询工作区" />
</p>

## Pipa 是什么

Pipa 为日常数据库查询提供一个安静、清晰的桌面工作区：集中整理连接，在独立标签中编写 SQL，并以流式结果表格查看数据。连接信息、未保存的 SQL 与查询历史保存在本机，不依赖云端账号。

## 当前能力

- 创建、测试、重命名和整理 MySQL、Redis 连接。
- 在绑定 MySQL 连接的查询标签中编写与执行 SQL。
- 执行选中 SQL 或光标所在语句，并可取消运行中的查询。
- 流式展示查询结果，保留大整数和精确小数的原始语义。
- 复制结果或导出 CSV。
- 重启后恢复未保存的 SQL 与标签上下文；查询结果不会被永久保存。
- 跟随系统或手动切换亮色、暗色外观。

## 数据库支持

| 数据库 | 当前支持 |
| --- | --- |
| MySQL | 连接管理、连接测试与 SQL 查询 |
| Redis | 连接管理与连接测试；命令工作台尚未开放 |
| PostgreSQL | 界面位置已预留，连接与查询尚未开放 |
| MongoDB | 界面位置已预留，连接与查询尚未开放 |

## 下载与安装

| Mac 类型 | 安装包 |
| --- | --- |
| Apple 芯片（M1 / M2 / M3 / M4 等） | [下载 `Pipa-macOS-arm64.dmg`](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-arm64.dmg) |
| Intel 芯片 | [下载 `Pipa-macOS-x64.dmg`](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-x64.dmg) |

下载后打开 DMG，将 Pipa 拖入“应用程序”文件夹即可。历史版本与更新说明可在 [Releases](https://github.com/AlasicPlat/pipa/releases) 查看。

当前 v0.2.4 的两个安装包均已完成 Developer ID 签名并通过 Apple 公证。

## 本地数据与隐私

Pipa 不提供云端同步，也不会上传连接配置、密码、SQL 或查询结果。连接信息与工作区数据保存在本机加密数据库中；查询结果只存在于当前运行内存。

## 关于本仓库

本仓库仅用于公开发布 Pipa 安装包和版本说明，不包含源代码。

如遇问题，可在 [Issues](https://github.com/AlasicPlat/pipa/issues) 中说明 Pipa 版本、macOS 版本、芯片类型和数据库类型。请勿提交真实密码、连接串或未脱敏的查询结果。

---

更多作品：[alasicplat.github.io](https://alasicplat.github.io)
