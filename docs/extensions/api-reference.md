# 扩展 API 参考（v1）

## manifest.json

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `manifestVersion` | 是 | 固定 `1` |
| `id` | 是 | 反向域名，小写；禁止 `com.tracememo.` / `tracememo.` / `tm.` 前缀 |
| `name` | 是 | 展示名，≤ 64 字 |
| `version` | 是 | `x.y.z`（可带 prerelease） |
| `apiVersion` | 是 | 必须为 `1` |
| `minAppVersion` | 否 | 低于该版本拒绝安装 |
| `description` / `author` / `homepage` | 否 | 展示用；homepage 仅接受 http(s) |
| `permissions` | 是 | 见权限表；未知权限直接判 manifest 非法 |
| `entrypoints.page` | 二选一 | 页面 HTML 相对路径 |
| `entrypoints.background` | 二选一 | 后台入口相对路径 |
| `subscriptions` | 条件 | 申请 `messages.subscribe` 时必填 |
| `contributions.pages` | 否 | `[{ id, title, entry? }]`，`id` 形如 `settings` |
| `contributions.automationActions` | 否 | `[{ id, title, description? }]`，有此项必须提供 background |

路径规则：相对路径、不允许 `..`、反斜杠、盘符、控制字符、Windows 保留名；
安装时还会用 realpath 复核入口仍在扩展目录内。

## 权限

| 权限 | 风险 | 能力 |
| --- | --- | --- |
| `messages.subscribe` | 高 | 接收 `message.received` |
| `messages.query` | 高 | `tm.messages.query` |
| `contacts.list` | 中 | 配置页读取群列表（`contacts.listGroups`），不含聊天内容 |
| `wechat.send.text` | 高 | `tm.wechat.send`（文本）与自动化 `reply` |
| `wechat.send.image` | 高 | `tm.wechat.send({ type: 'image' })` |
| `wechat.send.video` | 高 | `tm.wechat.send({ type: 'video' })`，原生 Host 走 `/SendMsg` video |
| `ai.chat` | 中 | `tm.ai.chat` |
| `storage` | 低 | `tm.storage.*` 与页面存储 |
| `automation.action` | 中 | `tm.automation.registerAction` |

安装时只自动授予**低风险**权限；其余在「启用」确认后授予。停用后回落到低风险集合。

## 后台 API

### tm.extension

- `id: string`
- `dataDir: string`（扩展私有数据目录，媒体文件写这里才能通过发送校验）
- `permissions: string[]`（当前已授予）

### tm.events

- `on('message.received', handler): () => void`
- `off('message.received', handler): void`

事件字段见 `TraceMemoMessageEvent`：`eventId / accountId / conversationId / messageId /
senderId? / senderName? / isGroup / isSelf / type / text? / mentionsMe / timestamp(ms)`。

### tm.messages.query

```ts
await tm.messages.query({ conversationId, startTime?, endTime?, limit? })
// → { messages: [{ messageId, conversationId, senderId?, senderName?, isSelf, type, text?, timestamp }] }
```

- 时间参数是 **epoch 毫秒**；默认最近 24 小时。
- 单次窗口最多 7 天，`limit` 上限 200。
- 数据库未连接时抛 `DATABASE_NOT_READY`。

### tm.wechat.send

```ts
// 文本
await tm.wechat.send({ to, text, at?, dedupeKey? })

// 图片
await tm.wechat.send({ type: 'image', to, path: '/abs/path/cover.png', dedupeKey? })

// 视频（原生 Host 以 {toWxid, type:'video', msg:<路径>} 提交）
await tm.wechat.send({ type: 'video', to, path: '/abs/path/clip.mp4', dedupeKey? })
// → { actionId, status: 'sent' }
```

按顺序检查：权限 → 参数（文本 ≤ 2000 字）→ manifest 会话范围 → 频率
（同扩展 2 秒一条、每分钟 10 条）→ 本机发送能力 → 授权校验 → Gateway。
任何一步不通过都抛带错误码的异常，不会「静默丢弃」。

媒体路径额外约束：

- 必须是**绝对路径**的普通文件，realpath 后仍位于**扩展数据目录**或**系统临时目录**；
- 大小 1B–100MB；
- 图片扩展名：jpg/jpeg/png/gif/webp/bmp；视频扩展名：mp4/mov/m4v；
- 视频走 `type: 'video'`，不复用图片通道；发送失败不会降级成图片。

### tm.ai.chat

```ts
await tm.ai.chat([{ role: 'user', content: '...' }])
// → { text }
```

使用 TraceMemo 已配置的 AI Provider；扩展拿不到 API Key。

### tm.storage

```ts
await tm.storage.set('config', { ... })
await tm.storage.get('config')
await tm.storage.remove('config')
await tm.storage.list()
```

键：`[A-Za-z0-9._-]{1,64}`；单值 ≤ 256KB，总量 ≤ 1MB；只接受 JSON 值。

### tm.automation.registerAction

```ts
tm.automation.registerAction({ id, title, description?, inputSchema?, handler })
```

`id`：`[a-z0-9][a-z0-9._-]{1,63}`。`handler` 返回：

```ts
{ success: boolean, output?: object, reply?: { type: 'text', text, at? }, error?: string }
```

`inputSchema` 只支持 `object` + `string|number|boolean` 属性的浅校验；必填项缺失会直接拒绝。

执行超时默认 15 秒（宿主可配，最大 60 秒），超时返回 `ACTION_TIMEOUT`。

### tm.capabilities.get

返回只读快照：`enabled / permissions / platform / databaseReady / send{...} / ai{...}`。

### tm.log

`info / warn / error`，写入扩展日志（详情页可见，最多保留 200 条，单行 ≤ 500 字）。

## 页面桥

页面 → 宿主：

```ts
{ source: 'tracememo-extension-page', extensionId, requestId, method, params }
```

宿主 → 页面：

```ts
{ source: 'tracememo-extension-host', requestId, ok: true, result }
{ source: 'tracememo-extension-host', requestId, ok: false, error: { code, message } }
```

页面方法白名单：`storage.get|set|remove|list`、`capabilities.get`、`contacts.listGroups`、`extension.info`。
页面不能发送微信消息、不能查询消息、不能调用 AI。

## 错误码

| 码 | 含义 |
| --- | --- |
| `EXTENSION_NOT_FOUND` | 扩展不存在 / 已卸载 |
| `EXTENSION_DISABLED` | 扩展未启用 |
| `EXTENSION_INCOMPATIBLE` | apiVersion 或 minAppVersion 不满足 |
| `EXTENSION_INVALID_MANIFEST` | manifest 不合法 |
| `EXTENSION_INVALID_PATH` | 入口 / 资源路径越界 |
| `EXTENSION_HOST_UNAVAILABLE` | 后台进程未运行 |
| `PERMISSION_DENIED` | 未授予权限，或超出声明范围 |
| `CAPABILITY_UNAVAILABLE` | 本机能力不具备（未绑定 / 未就绪） |
| `LICENSE_REQUIRED` | 无有效授权 |
| `DATABASE_NOT_READY` | 微信数据库未连接 |
| `SEND_NOT_SUPPORTED` | 当前平台或内容类型不支持 |
| `ACTION_TIMEOUT` | 处理超时 |
| `ACTION_FAILED` | 执行失败 |
| `RATE_LIMITED` | 触发频率限制 |
| `INVALID_REQUEST` | 参数非法 |
| `STORAGE_LIMIT_EXCEEDED` | 存储超限 |

## 自动化动作输入

规则里保存的静态 `input` 会与宿主注入字段合并，同名键以宿主为准：

```json
{
  "url": "https://example.com/video",
  "conversationId": "xxx@chatroom",
  "isGroup": true,
  "accountId": "wxid_self",
  "message": { "eventId": "message:...", "text": "...", "mentionsMe": false }
}
```
