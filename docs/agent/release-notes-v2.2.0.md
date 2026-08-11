# TraceMemo 2.2.0：正式品牌身份与安全升级迁移

TraceMemo（迹忆）原名 WechatExplorer。v2.2.0 不只更新用户可见名称，也正式启用新的应用身份、数据目录、Reader Skill 和默认 Agent 环境变量，同时为 v2.1.9 用户提供一次安全迁移路径。

## 新的产品身份

- 产品名与 Electron runtime name：`TraceMemo`；
- bundle/app identifier：`com.tracememo.app`；
- macOS userData：`~/Library/Application Support/TraceMemo`；
- macOS 日志：`~/Library/Logs/TraceMemo`；
- Reader Skill：`tracememo-reader`；
- Agent API Token 环境变量：`TRACEMEMO_API_TOKEN`；
- Agent Hub 凭据目录：`~/.tracememo/wechat-connector/accounts`。

## v2.1.9 升级迁移

首次启动 TraceMemo 时，如果检测到包含有效用户资产的旧数据目录，应用会询问是否立即迁移：

- `WechatExplorer`；
- v2.1.9 在区分大小写文件系统上可能使用的 `wechatexplorer`。

两个旧目录都有效时，应用确定性优先选择 `WechatExplorer` 并写入诊断日志，不合并目录。选择“以后迁移”不会删除或修改旧数据，下次启动仍可继续处理。

迁移遵循以下安全边界：

- 只复制明确列出的用户资产，不复制整个 Application Support；
- TraceMemo 已存在的文件或目录绝不覆盖；
- 每一项迁移可重复执行，已完成项会跳过；
- 迁移失败只清理本次创建的 staging，旧目录和旧文件始终保留；
- 不移动、不删除旧目录，不修改微信数据库或 Knowledge schema。

## 迁移的用户资产

- 设置、微信数据库连接路径和 AI Provider 元数据；
- Knowledge 本地索引；
- 报告历史、防撤回归档、图片理解结果和 Renderer Local Storage；
- Local HTTP API Token；
- AI Provider Key、微信数据库 Key 和图片解密 Key；
- Agent Hub credential 与同步状态。

Chromium Cache、Code Cache、GPUCache、临时文件、语音模型和其他可重建运行缓存不会为了品牌升级强制复制。

## Knowledge

Knowledge 以完整目录为单位复制。每个账号的 `knowledge.sqlite`、`knowledge.sqlite-wal` 和 `knowledge.sqlite-shm` 会一起进入同一个 staging；复制后先核对主库及 companion 文件，再对 staging 数据库执行 SQLite `integrity_check`。只有验证通过后才放入 TraceMemo 数据根。

迁移过程不会打开、修改或删除真实旧 Knowledge。失败时旧索引仍可用于重新迁移，不要求用户重新建立 2.47GB 级别的索引。

## Token 与加密 Key

旧 `safeStorage` 密文不会原样复制到新数据目录。TraceMemo 会启动一个隔离的 legacy helper：macOS 使用旧 `WechatExplorer` identity，helper 只在内存中解密并校验旧 Token/Key，再通过专用进程管道交给主进程重新加密；macOS 主进程使用 TraceMemo identity. 明文不会写入磁盘、环境变量或日志。

Token 格式、随机熵、加密方式和 rotation 行为没有变化。如果旧 API Token 因系统安全存储限制无法迁移，应用不会静默生成替代 Token，本地 API 会安全停用并提示用户重试迁移或在 API Center 主动重新生成。AI Provider Key、数据库 Key 和图片 Key 失败时也会明确记录为部分迁移，旧密文保持不变。

## API、Agent 与 Skill 兼容

Local HTTP API 继续使用 `127.0.0.1:6131` 和 `/api/v1/*`，Bearer Token 格式不变。

新安装和新文档默认使用 `TRACEMEMO_API_TOKEN`。已安装的旧 Reader Skill 可以在一个兼容版本内继续使用 `WECHATEXPLORER_API_TOKEN`。正式随应用分发的 Skill 已更名为 `tracememo-reader`，资源解析仍可读取旧 `wechatexplorer-reader` 目录作为 fallback。

Agent Hub 新凭据写入 `~/.tracememo`。如果迁移尚未完成且新目录没有凭据，connector 会只读回退到 `~/.wechatexplorer`；新版本不会清理或删除旧目录。

## 日志与 Documents

TraceMemo 新日志写入新的日志目录，“设置 → 关于 → 打开诊断日志目录”会打开当前 TraceMemo 日志。历史 WechatExplorer 日志保持原位置，不搬迁、不重命名、不删除。

`Documents/TraceMemo` 用于新导出和 Emoji 数据；历史 `Documents/WechatExplorer` 不删除，并继续提供兼容读取。

更多安全边界见[数据、隐私与安全](../user-guide/privacy.md)和[API 安全](./api-security.md)。
