# TraceMemo Local HTTP API

本文面向需要自己写集成的开发者。普通用户请先阅读[Agent 接入概览](./overview.md)。

## 基本信息

- 默认地址：`http://127.0.0.1:6131`
- API 前缀：`/api/v1`
- 默认只监听 loopback；不要把它当作公网服务。
- `/api/v1/health` 无需 Token；其他端点需要 `Authorization: Bearer <TOKEN>`。
- 请求体使用 JSON，单个请求体最大 `1 MiB`；超限返回 `413`。
- 错误响应包含 `requestId`，响应头包含 `X-Request-Id`。客户端可传入 1-128 位的 `[A-Za-z0-9._:-]` 标识，否则服务端会生成 UUID。
- 不支持的 HTTP method 返回 `405` 和 `Allow` 响应头。

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

新配置必须优先使用 `TRACEMEMO_API_TOKEN`。应用生成的安装指令仍会提示：尚未升级的旧配置可以继续读取 `WECHATEXPLORER_API_TOKEN`，但新配置必须使用新变量名；如果两个变量都存在，以新变量为准。当前没有设定旧变量名的移除时间。

Token 由应用生成并保存在本机，**不接受用环境变量覆盖**：Agent 侧的环境变量只是把 Token 传给 Agent 自己的方式，不是服务端的鉴权来源。

## 端点

| 方法   | 路径                                                            | 作用                                   | 参数/请求体                                                     |
| ------ | --------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| GET    | `/api/v1/health`                                                | 服务与数据库健康状态                   | 无                                                              |
| GET    | `/api/v1/current_time`                                          | 本机时间、时区和 Unix 时间戳           | 无                                                              |
| GET    | `/api/v1/contact`                                               | 联系人和群聊列表                       | `filter`、`type=user\|group`                                    |
| GET    | `/api/v1/chatroom`                                              | 群聊列表                               | `keyword`                                                       |
| GET    | `/api/v1/recent_chat`                                           | 最近会话                               | `limit`，默认 50                                                |
| GET    | `/api/v1/chatlog`                                               | 指定会话的聊天记录                     | 必填 `talker`；可选 `time` 或 `startTime`/`endTime`             |
| GET    | `/api/v1/media/{mediaId}`                                       | 获取图片消息的二进制资源               | 原样使用 `/chatlog` 返回的 `media.url`，不要用消息 `id` 拼接    |
| GET    | `/api/v1/group_snapshot`                                        | 群成员快照                             | 必填 `md5`                                                      |
| GET    | `/api/v1/resolve`                                               | 将昵称、wxid 或 md5 解析为会话         | 必填 `q`                                                        |
| POST   | `/api/v1/report`                                                | 将结构化日报渲染为 HTML 与 PNG         | `GroupReportExportRequest` JSON                                 |
| GET    | `/api/v1/agent/status`                                          | Agent Hub、连接器和数据库状态          | 无                                                              |
| POST   | `/api/v1/agent/group-report`                                    | 读取群聊并生成总结图片                 | `{ "group": "群名或标识", "range": "today\|yesterday\|7days" }` |
| POST   | `/api/v1/agent/send`                                            | 通过已连接机器人测试发送文字或本地图片 | `{ "to": "接收者", "text": "...", "media_url": "..." }`         |
| GET    | `/api/v1/wechat-personal/send-capability`                       | 个人微信发送能力状态                   | 无                                                              |
| GET    | `/api/v1/scheduled-reports`                                     | 定时日报任务列表                       | 无                                                              |
| POST   | `/api/v1/scheduled-reports`                                     | 创建定时日报任务                       | `ScheduledReportApiCreateRequest` JSON                          |
| GET    | `/api/v1/scheduled-reports/{id}`                                | 查询单个定时日报任务                   | 无                                                              |
| PATCH  | `/api/v1/scheduled-reports/{id}`                                | 修改定时日报任务                       | `ScheduledReportApiUpdateRequest` JSON                          |
| DELETE | `/api/v1/scheduled-reports/{id}`                                | 删除定时日报任务                       | 无                                                              |
| POST   | `/api/v1/scheduled-reports/{id}/enable`                         | 启用定时日报任务                       | 无                                                              |
| POST   | `/api/v1/scheduled-reports/{id}/disable`                        | 暂停定时日报任务                       | 无                                                              |
| POST   | `/api/v1/scheduled-reports/{id}/run`                            | 立即执行一次并返回 execution           | 无                                                              |
| GET    | `/api/v1/scheduled-reports/{id}/executions`                     | 查询某个任务的执行记录                 | 无                                                              |
| POST   | `/api/v1/scheduled-reports/executions/{executionId}/retry-send` | 兼容占位路由；当前返回 `501 not_supported` | 无                                                              |
| GET    | `/api/v1/capabilities`                                            | TraceMemo 应用能力和可用状态             | 无                                                              |
| GET    | `/api/v1/automations`                                             | 自动化规则列表                           | 可选 `type`、`enabled`                                           |
| POST   | `/api/v1/automations`                                             | 创建默认停用的自动化规则                 | Automation draft JSON                                           |
| POST   | `/api/v1/automations/validate`                                    | 校验规则，不保存、不执行                 | Automation draft JSON                                           |
| GET    | `/api/v1/automations/{id}`                                        | 查询单条自动化规则                       | 无                                                              |
| PATCH  | `/api/v1/automations/{id}`                                        | 更新规则配置                             | 可变配置字段 JSON                                                |
| DELETE | `/api/v1/automations/{id}`                                        | 删除自定义规则                           | 系统内置规则受保护                                               |
| POST   | `/api/v1/automations/{id}/enable`                                 | 校验并启用规则                           | 无                                                              |
| POST   | `/api/v1/automations/{id}/disable`                                | 停用规则                                 | 无                                                              |
| GET    | `/api/v1/automations/executions`                                  | 查询自动化执行记录                       | `ruleId`、`status`、`since`、`until`、`limit`                   |
| GET    | `/api/v1/monitors/group-exits`                                     | 查看退群监控状态                         | 无                                                              |
| PATCH  | `/api/v1/monitors/group-exits`                                     | 配置监控群范围或启停                     | `enabled`、`monitoredConversationIds`                          |
| GET    | `/api/v1/monitors/group-exits/events`                             | 查询退群事件历史                         | `conversationId`、`since`、`until`、`limit`                    |
| GET    | `/api/v1/groups/{conversationId}/member-stats`                     | 查询群成员活跃统计                       | 必填 `conversationId`、`start`、`end`                          |

`/api/v1/query/*` 是一组结构化的 Query 端点，见下方[LLM-friendly Query Tool API](#llm-friendly-query-tool-api)。

## Application Capabilities

`GET /api/v1/capabilities` 描述 TraceMemo 应用级能力和当前运行环境；`GET /api/v1/query/capabilities` 只描述结构化 Query primitive，两者不是同一份目录。应用能力使用 `supported` 和 `available` 分开表示“代码支持”与“当前可用”；运行时原因使用稳定的简短 code，不返回 Token、数据库路径、微信密钥或 sender 诊断路径。

响应包含应用版本、数据库 readiness、Query、Automation、退群监控、群统计，以及个人微信/iLink 的能力状态。`groupExitMonitor.operations` 当前声明 `read_state`、`configure_scope`、`enable`、`disable`、`list_events`；`groupStats.operations` 当前声明 `member_stats`。能力声明不会触发监控扫描或群统计查询。

```bash
: "${TRACEMEMO_API_TOKEN:?Set TRACEMEMO_API_TOKEN from API Center}"
BASE="http://127.0.0.1:6131/api/v1"
AUTH="Authorization: Bearer $TRACEMEMO_API_TOKEN"
curl -H "$AUTH" "$BASE/capabilities"
```

## Group Exit Monitor API

退群监控只负责“监测哪些群、发现了哪些退群事实”。退群后是否通知、通知到哪里以及通知模板，仍由 `leave_notification` Automation singleton 负责；修改监控范围不会隐式修改该 Automation。

### 查看和配置监控

```bash
curl -H "$AUTH" "$BASE/monitors/group-exits"

curl -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  "$BASE/monitors/group-exits" \
  -d '{"enabled":true,"monitoredConversationIds":["123@chatroom"]}'
```

`monitoredConversationIds` 只接受当前联系人列表中精确存在的群 `roomId`（例如 `xxx@chatroom`），不接受群名、md5、个人联系人、重复或空 ID。请求至少提供 `enabled` 或 `monitoredConversationIds` 其中一个；传空数组表示清空监控范围。服务会先校验全部群，再执行一次原子配置。PATCH 返回最终完整状态。

状态中的 `eventCount` 是持久化退群事件总数，`lastCheckedAt`/`lastReadAt` 为空时返回 `null`。GET 不会调用 `checkNow()`，也不会触发通知发送。

### 查询退群事件

```bash
curl -G -H "$AUTH" "$BASE/monitors/group-exits/events" \
  --data-urlencode 'conversationId=123@chatroom' \
  --data-urlencode 'since=2026-10-01T00:00:00+07:00' \
  --data-urlencode 'until=2026-10-02T23:59:59+07:00' \
  --data-urlencode 'limit=50'
```

时间参数必须是带 offset 的 ISO-8601；默认 `limit=50`，最大 200。事件按 `detectedAt` 升序返回。事件 DTO 使用 `eventId`、稳定的 `conversationId` 和 `memberId`，并把时间输出为 ISO-8601；当前整体已读状态不会伪造成 event-level `read` 字段。当前未开放 clear events、markRead 或 checkNow HTTP 路由。

一个典型 Agent 工作流是：先通过 `/resolve` 或 `/contact` 找到稳定群 ID，再 PATCH monitor scope；如需通知，再单独 PATCH `leave_notification` Automation，调用 `/automations/validate`，最后启用规则。

## Group Member Stats API

```bash
curl -G -H "$AUTH" "$BASE/groups/123%40chatroom/member-stats" \
  --data-urlencode 'start=2026-09-01T00:00:00+07:00' \
  --data-urlencode 'end=2026-10-01T00:00:00+07:00'
```

`conversationId` 必须是当前联系人列表中精确存在的群 `roomId`；不存在返回 `NOT_FOUND`，个人联系人返回 `NOT_GROUP_CONVERSATION`。`start` 和 `end` 必须同时提供，且使用带 offset 的 ISO-8601，`start` 不能晚于 `end`。HTTP adapter 只负责把稳定群 ID 解析为内部 md5 并调用现有 `GroupStatsService`，不会在 HTTP 层重新统计消息。

响应中的 `activeMembers` 和 `silentMembers` 都只描述当前成员名单；成员使用 `memberId`，活跃成员的 `lastMessageAt` 和 `range` 时间均为 ISO-8601。`freshness`、`complete`、`limitations` 必须原样保留，`unattributedMessages` 与 `excludedSystemMessages` 用于诊断，`firstMessageAt` 没有消息时为 `null`。当前成员统计不等于完整历史成员统计，`limitations` 表达的退群成员或未归档时段不能从文本中推导成额外的 `formerMembers`，也不会伪造 `totalMessageCount`。

## Automation API

`/api/v1/automations*` 是 Automation 的 canonical HTTP API，读写唯一的 `AutomationRuleStore`。它支持当前真实规则类型：`daily_report`、`scheduled_report`、`leave_notification`。本 API 不提供立即执行、重试或清理执行记录。

旧 `/api/v1/scheduled-reports*` 保持兼容，不设移除日期；它是面向旧 DTO 的受限 compatibility API，不是第二份存储，也不能表示所有新的定时日报目标和配置。新的 Agent 集成应使用 `/automations`。

创建和校验规则时 `enabled` 只能缺省或为 `false`。创建成功后必须调用 `/automations/{id}/enable` 才会启用。启用会重新校验当前规则；数据库未就绪、目标无法解析或配置无效时不会启用。`PATCH` 只接受规则配置字段，不可改 `ruleType`、`id`、创建/更新时间或 `enabled`；启停必须使用独立 endpoint。未知字段和未知枚举会被拒绝。

会话范围优先传 `wxid`、`roomId`（如 `xxx@chatroom`）或 canonical conversation ID。唯一匹配的联系人名可被解析为稳定 ID；重名会返回 `ambiguous_contact`，不会猜测。`daily_report.conditions.conversationIds` 在对外 API 中使用稳定 ID，Store 内部仍沿用既有 md5 口径。

校验请求不落盘、不发消息，也不执行规则。`valid: false` 时查看 `issues`；有效时 `normalized` 是经 ID 解析后的草稿，`effects` 描述启用后的动作，定时日报另外返回按本机时区计算的 `nextRunAt`。

```json
{
  "name": "产品群每日日报",
  "ruleType": "scheduled_report",
  "scheduledReport": {
    "schedule": { "time": "20:00" },
    "report": {
      "sourceConversationId": "wxid_product@chatroom",
      "range": "today",
      "messageTypes": ["text", "image"],
      "templateId": "v1",
      "memberNameMode": "groupNickname",
      "timeoutSeconds": 300
    },
    "target": { "type": "file_transfer" },
    "postfixText": ""
  }
}
```

执行历史只读，默认最多返回 50 条，`limit` 范围是 1-200。`since` 和 `until` 接受带时区的 ISO-8601 时间；execution 本身最多留存 200 条。`running` 记录的 `finishedAt` 为 `null`。

新 Agent API 的错误格式：

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "自动化规则校验失败",
    "details": []
  },
  "requestId": "..."
}
```

常见错误码包括 `UNAUTHORIZED`、`METHOD_NOT_ALLOWED`、`PAYLOAD_TOO_LARGE`、`INVALID_ARGUMENT`、`NOT_FOUND`、`NOT_GROUP_CONVERSATION`、`DATABASE_NOT_READY`、`VALIDATION_FAILED`、`SINGLETON_RULE`、`PROTECTED_RULE` 和 `PERSISTENCE_FAILED`。`leave_notification` 是固定单例：可读取、修改和启停，但不能创建第二条或删除。内置 `@我生成日报` 同样不能通过 HTTP 删除。

### 这些端点与实时机器人有什么关系

- `/api/v1/agent/status` 只用于查询 Agent Hub、微信连接器和数据库状态；
- `/api/v1/agent/group-report` 由外部 Agent 或脚本主动请求生成群聊总结图片；
- `/api/v1/agent/send` 是受 Bearer Token 保护的开发者/测试发送入口，用于通过已经连接的机器人发送文字或本地图片；它不是任意群发能力，也不是实时消息订阅接口；
- `/api/v1/scheduled-reports*` 会**写入**应用状态：创建、修改、删除、启停定时日报任务，以及立刻执行一次。加上 `/report` 和 `/agent/send`，这个 API 并非只读接口——拿到 Token 就能改配置、生成报告并发送微信消息，请按本机敏感凭据对待；
- `POST /api/v1/scheduled-reports/{id}/run` 与定时触发共用同一条链路：读取群聊 → 生成报告 → 保存 Report History → 尝试发送；
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
- `201`：定时日报任务创建成功；
- `401`：缺少、错误或已失效的 Bearer Token；
- `400`：参数或 JSON 请求体无效；
- `422`：媒体标识格式错误，或目标消息不是可读取的图片（`NOT_IMAGE`）；
- `403`：浏览器 Origin 不在允许的 loopback 列表；
- `409`：定时日报任务重复（`error === "duplicate"`，响应里会带回已存在的任务），或群聊名称匹配到多个目标（`ambiguous_contact`）；
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

| scope                                     | 含义                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `{"kind":"all"}`                          | 所有可读会话（默认；省略 `scope` 等价于此）                          |
| `{"kind":"groups"}`                       | 只搜群聊语料，**且包含群成员实际发送的消息**（不是群名称或群元数据） |
| `{"kind":"contact","conversationId":"…"}` | 只搜该一对一会话                                                     |
| `{"kind":"current","conversationId":"…"}` | 只搜指定的那个会话（单聊或群聊）                                     |

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

| 字段                | 含义                                                                |
| ------------------- | ------------------------------------------------------------------- |
| `indexLatestAt`     | 索引目前覆盖到的源数据时间（epoch ms），`null` 表示无法判定         |
| `sourceLatestAt`    | 聊天数据库里最新的活跃时间（epoch ms），`null` 表示无法判定         |
| `coverage.state`    | `complete` 只在索引确实覆盖了所请求的时间范围时出现                 |
| `freshness.catchUp` | 本次为追赶索引做了什么：`none` / `reused` / `completed` / `pending` |

调用方**必须**把 `coverage` 当真：`coverage.state` 不是 `complete` 且 `evidence` 为空时，只能说明"这段范围暂时无法确认"，**不能**下"没有找到"的结论。索引落后时服务端会自动请求一次追赶同步，但不会让请求无限等待；`freshness.catchUp` 为 `pending` 表示追赶仍在后台进行，稍后重试即可拿到更新的覆盖。

`query/messages` 与 `query/conversation-overview` 直读聊天数据库，不受索引新鲜度影响。
