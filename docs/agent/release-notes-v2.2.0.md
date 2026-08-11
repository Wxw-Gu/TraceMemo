# TraceMemo 2.2.0：品牌升级与本地数据兼容

2.2.0 将用户可见品牌从 WechatExplorer 升级为 TraceMemo（迹忆）。这次升级不搬迁或复制用户的 Application Support 数据；macOS 和 Windows 上的旧用户会继续使用原有数据根，以避免设置、密钥和本地索引失联。

## 升级后继续保留的内容

- 微信数据库连接设置和其他用户设置；
- AI Provider、模型配置和已加密 API Key；
- Local HTTP API Token；
- 微信数据库 Key 和图片解密 Key；
- Knowledge 本地索引，包括现有 SQLite、WAL 和 SHM 文件；
- 报告历史、防撤回归档和图片理解结果；
- Renderer Local Storage 和其他 Chromium session 数据；
- `~/.wechatexplorer/wechat-connector/accounts` 中的 Agent Hub 登录凭据。

应用启动时会在任何业务模块读取 Electron 路径或使用 `safeStorage` 之前选择数据根，并将 `userData` 与 `sessionData` 设置为同一目录：

- `WechatExplorer` 或 v2.1.9 使用的小写 `wechatexplorer` 目录包含有效用户资产时，继续使用对应旧目录；
- 只有 TraceMemo 新目录包含有效用户资产时，使用新目录；
- 多个旧目录或新旧目录同时包含有效用户资产时，不复制、不合并、不覆盖；两个大小写 legacy 目录均有效时确定性优先 `WechatExplorer` 并写入诊断日志；
- 两边都没有有效用户资产时，全新安装使用 TraceMemo 新目录。

仅有 `Local State`、Cache、Code Cache 或 GPUCache 等运行时文件，不会被判断为有效用户资产。

## 有意保留的兼容标识

内部 Electron runtime identity 在 macOS 上继续使用 `WechatExplorer`。前者用于兼容旧 `safeStorage` 密文，后者同时承担旧 `safeStorage` 与 WCDB 运行时兼容；它们都不是未完成的品牌替换。

以下历史标识也继续保留：

- bundle/app identifier：`com.wechatexplorer.app`；
- Reader Skill 目录和标识：`wechatexplorer-reader`；
- Agent 环境变量：`WECHATEXPLORER_API_TOKEN`；
- Agent Hub 凭据目录：`~/.wechatexplorer`；
- GitHub 仓库地址中的 `WechatExplorer`。

Local HTTP API 的 endpoint、默认端口 `6131`、Bearer Token 格式、加密方式和 rotation 行为没有因为品牌升级而改变。旧 Token 文件会从旧数据根继续读取，不会仅因升级而重新生成。

## Knowledge 与日志

Knowledge 不会被复制、移动或自动重建。旧用户继续直接使用原有 Knowledge 目录，因此不需要为了 v2.2.0 重新建立索引。

TraceMemo 的新诊断日志写入 TraceMemo 日志目录；WechatExplorer 历史日志保持原位置，不移动、不重命名、不删除。“打开诊断日志目录”会打开当前版本使用的 TraceMemo 日志。

更多安全边界见[数据、隐私与安全](../user-guide/privacy.md)和[API 安全](./api-security.md)。
