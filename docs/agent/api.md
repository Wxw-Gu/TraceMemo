# TraceMemo Local HTTP API

本文面向需要自己写集成的开发者。普通用户请先阅读[Agent 接入概览](./overview.md)。

## 基本信息

- 默认地址：`http://127.0.0.1:6131`
- API 前缀：`/api/v1`
- 默认只监听 loopback；不要把它当作公网服务。
- `/api/v1/health` 无需 Token；其他端点需要 `Authorization: Bearer <TOKEN>`。
- 请求体使用 JSON；响应为 JSON。

## 最小请求

```bash
# 健康检查
curl http://127.0.0.1:6131/api/v1/health

# 读取数据
export TRACEMEMO_API_TOKEN="<从 API Center 复制的 Token>"
curl -H "Authorization: Bearer $TRACEMEMO_API_TOKEN" \
  "http://127.0.0.1:6131/api/v1/recent_chat?limit=20"
```

不要把 Token 放入 URL、Skill 文件、仓库或命令历史可被共享的脚本中。

新配置必须优先使用 `TRACEMEMO_API_TOKEN`。已安装的旧 Reader Skill 可在 v2.2.0 兼容期内继续读取 `WECHATEXPLORER_API_TOKEN`；如果两个变量都存在，以新变量为准。

## 端点

| 方法 | 路径                         | 作用                                   | 参数/请求体                                                     |
| ---- | ---------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| GET  | `/api/v1/health`             | 服务与数据库健康状态                   | 无                                                              |
| GET  | `/api/v1/current_time`       | 本机时间、时区和 Unix 时间戳           | 无                                                              |
| GET  | `/api/v1/contact`            | 联系人和群聊列表                       | `filter`、`type=user\|group`                                    |
| GET  | `/api/v1/chatroom`           | 群聊列表                               | `keyword`                                                       |
| GET  | `/api/v1/recent_chat`        | 最近会话                               | `limit`，默认 50                                                |
| GET  | `/api/v1/chatlog`            | 指定会话的聊天记录                     | 必填 `talker`；可选 `time` 或 `startTime`/`endTime`             |
| GET  | `/api/v1/media/{mediaId}`    | 获取图片消息的二进制资源               | 原样使用 `/chatlog` 返回的 `media.url`，不要用消息 `id` 拼接     |
| GET  | `/api/v1/group_snapshot`     | 群成员快照                             | 必填 `md5`                                                      |
| GET  | `/api/v1/resolve`            | 将昵称、wxid 或 md5 解析为会话         | 必填 `q`                                                        |
| POST | `/api/v1/report`             | 将结构化日报渲染为 HTML 与 PNG         | `GroupReportExportRequest` JSON                                 |
| GET  | `/api/v1/agent/status`       | Agent Hub、连接器和数据库状态          | 无                                                              |
| POST | `/api/v1/agent/group-report` | 读取群聊并生成总结图片                 | `{ "group": "群名或标识", "range": "today\|yesterday\|7days" }` |
| POST | `/api/v1/agent/send`         | 通过已连接机器人测试发送文字或本地图片 | `{ "to": "接收者", "text": "...", "media_url": "..." }`         |

### 这些端点与实时机器人有什么关系

- `/api/v1/agent/status` 只用于查询 Agent Hub、微信连接器和数据库状态；
- `/api/v1/agent/group-report` 由外部 Agent 或脚本主动请求生成群聊总结图片；
- `/api/v1/agent/send` 是受 Bearer Token 保护的开发者/测试发送入口，用于通过已经连接的机器人发送文字或本地图片；它不是任意群发能力，也不是实时消息订阅接口；
- 当前 API 没有对外暴露实时入站 webhook。微信消息由应用内部的 Agent Hub 和微信连接器接收、处理和回复。

## 时间查询

`chatlog` 的 `time` 支持：

- `YYYY-MM-DD`：当天；
- `YYYY-MM-DD~YYYY-MM-DD`：日期闭区间；
- `YYYY-MM-DD/HH:mm`：从该分钟开始的 60 秒；
- 也可以使用 Unix 秒级 `startTime` 和 `endTime`。

时间按运行 TraceMemo 的本机时区解析。用户说“今天”“昨天”时，先调用 `current_time`，再根据返回的 `localDate` 计算日期，避免使用 Agent 自己的时区。

## 常用工作流

### 查找并读取一个会话

```bash
BASE="http://127.0.0.1:6131/api/v1"
AUTH="Authorization: Bearer ${TRACEMEMO_API_TOKEN:-$WECHATEXPLORER_API_TOKEN}"

curl -H "$AUTH" "$BASE/resolve?q=技术交流群"
curl -H "$AUTH" "$BASE/chatlog?talker=技术交流群&time=2026-08-07"
```

当标识不确定时，先用 `resolve` 或 `contact`，再调用 `chatlog`。对重要问题，先宽范围定位，再针对关键时间点读取前后文，不要只凭一次粗查回答。

### 生成群聊总结图片

优先使用 `/api/v1/agent/group-report`，因为它会读取指定群聊并按 `today`、`yesterday` 或 `7days` 生成总结。`/api/v1/report` 是更底层的渲染接口，要求调用方已经准备好 `report` 和 `metadata` 结构；完整 TypeScript 类型以 `src/shared/group-report.ts` 为准。

## 响应与错误

- `200`：请求成功；
- `401`：缺少、错误或已失效的 Bearer Token；
- `400`：参数或 JSON 请求体无效；
- `422`：媒体标识格式错误，或目标消息不是可读取的图片（`NOT_IMAGE`）；
- `403`：浏览器 Origin 不在允许的 loopback 列表；
- `404`：端点、会话或群聊不存在；媒体标识未登记、已过期、有歧义，或图片文件不存在（`NOT_FOUND`）。媒体请求遇到此状态时，先重新读取 `/chatlog` 并使用新的 `media.url`；若仍失败，再检查本地图片文件是否存在；
- `503`：数据库或 Agent Hub 尚未就绪；
- `500`：服务端处理或报告渲染失败。

成功响应会返回端点对应的 JSON 对象，例如 `chatlog` 包含 `contact`、`query`、`count` 和 `messages`，`contact` 返回 `count` 与 `contacts`。

图片消息在 `messages` 中保留原有字段，并额外提供 `media`：

```json
{
  "type": "图片",
  "content": "",
  "media": {
    "type": "image",
    "available": true,
    "url": "/api/v1/media/image%3A0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

当用户要求查看或理解图片时，使用 `media.url` 获取 `image/jpeg`、`image/png` 等真实二进制；不要根据 `[图片]` 猜测内容，也不要向 API 传入本地路径。

`media.url` 包含当前数据库连接内的独立媒体标识，不等同于消息 `id`。不同会话的消息 `id` 可能重复，调用方应原样使用返回的地址，不自行拼接或解析。重启、重连或切换账号后须重新读取 `/chatlog` 获取新地址；旧的纯消息 ID 地址仅在无歧义时兼容。`available` 只表示消息带有图片定位信息，不保证本地图片文件仍存在或可以解密。

## 与 MCP 的关系

当前实现没有把 `6131` 暴露为 MCP Server。需要在 Agent 中使用时，请安装随应用提供的 Reader Skill，并让 Skill 通过普通 HTTP 请求调用本 API。

## LLM-friendly Query Tool API

这些端点提供稳定的结构化 Query primitive，不接收自然语言问题，也不会调用 AI。它们与现有 API 共用端口、Bearer Token、loopback 和 CORS 安全策略。

```bash
BASE="http://127.0.0.1:6131/api/v1"
AUTH="Authorization: Bearer ${TRACEMEMO_API_TOKEN:-$WECHATEXPLORER_API_TOKEN}"

# 能力目录
curl -H "$AUTH" "$BASE/query/capabilities"

# BOBO 的第一条真实互动
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' "$BASE/query/messages" \
  -d '{"target":{"query":"BOBO"},"timeRange":{"kind":"all"},"direction":"any","order":"asc","limit":1,"excludeSystem":true}'

# 上个月 BOBO 发来的文件
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' "$BASE/query/messages" \
  -d '{"target":{"query":"BOBO"},"timeRange":{"kind":"previous_month"},"direction":"from_target","messageTypes":["file"],"order":"desc","limit":1}'

# 受限语义关键词检索（最多 4 个 variants）
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' "$BASE/query/search" \
  -d '{"target":{"query":"BOBO"},"timeRange":{"kind":"all"},"query":"答应之后给我或者帮我完成某件事情","variants":["我给你","我发你","弄好给你"],"limit":20}'

# 按会话和时间范围提取可供总结的证据
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' "$BASE/query/conversation-overview" \
  -d '{"target":{"query":"BOBO"},"timeRange":{"kind":"previous_month"}}'
```

`query/messages` 的 `messageRef` 是服务端生成的不透明引用，可直接传给 `query/message-context` 获取前后文；不要自行构造 wxid、md5 或数据库路径。

每条消息都会返回 `messageType`（`text`、`image`、`voice`、`video`、`file`、`link`、`sticker`、`system` 或 `other`）。非文本消息不会伪造 `text`；可识别的图片、视频、贴纸和文件会返回不含密钥或本地路径的 `attachment` 元数据。

`conversation-overview` 同时返回 `sourceCoverage` 与 `selection`：前者描述时间范围内源消息是否完整及 `sourceMessageCount`，后者描述从源消息中选出的 Evidence 数量及是否抽样。`evidence` 最终按 `timestamp` 升序返回，`messageRef` 是唯一推荐的消息引用。
`conversation-overview` 另有一个 `origin` 字段：`wcdb` 表示这次证据直接来自本机聊天数据库（会话概览的事实来源），`knowledge` 表示来自本地索引。

### 搜索范围（scope）

`query/messages`、`query/search`、`query/message-context` 和 `query/conversation-overview` 都接受一个可选的 `scope`，用来把检索限制在一个确定的语料边界内：

| scope | 含义 |
| ----- | ---- |
| `{"kind":"all"}` | 所有可读会话（默认；省略 `scope` 等价于此） |
| `{"kind":"groups"}` | 只搜群聊语料，**且包含群成员实际发送的消息**（不是群名称或群元数据） |
| `{"kind":"contact","conversationId":"…"}` | 只搜该一对一会话 |
| `{"kind":"current","conversationId":"…"}` | 只搜指定的那个会话（单聊或群聊） |

`conversationId` 是会话标识，可用 `/api/v1/resolve` 或 `/api/v1/contact` 得到。`scope` 一旦给出就是**权威边界**：`target` 落在范围之外会被拒绝（`status: "invalid_tool_arguments"`、`constraint: "target_outside_scope"`），不会静默扩大范围；范围里包含多个会话时，`query/messages` 与 `query/conversation-overview` 必须显式指定 `target`（`constraint: "target_required_for_scope"`）。

响应会回显实际生效的边界：

```json
{ "scope": { "kind": "groups", "conversationCount": 243 } }
```

跨会话检索时，`evidence` 的每一项都会带上它所属的会话，便于把结果归属到具体群 / 联系人与具体成员：

```json
{
  "messageRef": "…",
  "conversationName": "某个群",
  "conversationType": "group",
  "sender": "某成员",
  "timestamp": 1789099069000,
  "text": "…"
}
```

### 索引新鲜度（freshness）

`query/search` 依赖本地索引，而本地索引是异步建立的派生数据，可能落后于聊天数据库。因此它的响应会显式给出覆盖口径：

| 字段 | 含义 |
| ---- | ---- |
| `indexLatestAt` | 索引目前覆盖到的源数据时间（epoch ms），`null` 表示无法判定 |
| `sourceLatestAt` | 聊天数据库里最新的活跃时间（epoch ms），`null` 表示无法判定 |
| `coverage.state` | `complete` 只在索引确实覆盖了所请求的时间范围时出现 |
| `freshness.catchUp` | 本次为追赶索引做了什么：`none` / `reused` / `completed` / `pending` |

调用方**必须**把 `coverage` 当真：`coverage.state` 不是 `complete` 且 `evidence` 为空时，只能说明"这段范围暂时无法确认"，**不能**下"没有找到"的结论。索引落后时服务端会自动请求一次追赶同步，但不会让请求无限等待；`freshness.catchUp` 为 `pending` 表示追赶仍在后台进行，稍后重试即可拿到更新的覆盖。

`query/messages` 与 `query/conversation-overview` 直读聊天数据库，不受索引新鲜度影响。
