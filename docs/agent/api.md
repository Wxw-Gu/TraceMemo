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
- `403`：浏览器 Origin 不在允许的 loopback 列表；
- `404`：端点、会话或群聊不存在；
- `503`：数据库或 Agent Hub 尚未就绪；
- `500`：服务端处理或报告渲染失败。

成功响应会返回端点对应的 JSON 对象，例如 `chatlog` 包含 `contact`、`query`、`count` 和 `messages`，`contact` 返回 `count` 与 `contacts`。

## 与 MCP 的关系

当前实现没有把 `6131` 暴露为 MCP Server。需要在 Agent 中使用时，请安装随应用提供的 Reader Skill，并让 Skill 通过普通 HTTP 请求调用本 API。
