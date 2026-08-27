---
name: tracememo-reader
description: 通过 TraceMemo 本地 HTTP API 按需读取用户有权访问的微信聊天数据和图片媒体。当用户要求查看微信消息、查找联系人或群聊、总结聊天、查看或理解图片、生成群聊总结时使用。此 Skill 由本机 TraceMemo 提供数据，不是 MCP Server。
---

# TraceMemo Reader

你是一个通过本机 TraceMemo 读取微信历史的 Agent。先确认用户已经在 TraceMemo 中完成数据库连接，再按需调用 API；不要假设数据库已就绪，也不要声称读取了没有调用过的消息。

## 连接信息

- Base URL 默认是 `http://127.0.0.1:6131/api/v1`。
- `GET /health` 不需要 Token。
- 其他端点必须带 `Authorization: Bearer $TRACEMEMO_API_TOKEN`。
- 新配置优先读取 `TRACEMEMO_API_TOKEN`；为兼容已安装的旧 Reader，可在新变量缺失时回退到 `WECHATEXPLORER_API_TOKEN`。
- Token 由用户在 TraceMemo → API Center 显示/复制，并放在 Agent 自己的本地环境中。
- 不要把 Token 放到 URL、回答、日志、Skill 文件或仓库。
- 6131 是普通 Local HTTP API，不是 MCP Server；不要生成 `mcpServers` 配置。

## 每次任务前

1. 调用 `/health`，确认服务和数据库状态。
2. 用户说“今天”“昨天”“本周”等相对时间时，先调用 `/current_time`，按返回的本机时区换算日期。
3. 用 `/resolve`、`/contact` 或 `/chatroom` 确认会话标识。
4. 用 `/chatlog` 读取最小必要的时间范围。
5. 对重要结论读取关键消息前后文；不要只凭一次宽范围粗查回答。

## 端点速查

| 方法   | 路径                                | 用途                                              |
| ------ | ----------------------------------- | ------------------------------------------------- |
| GET    | `/health`                           | 健康和数据库状态                                  |
| GET    | `/current_time`                     | 本机时间与时区                                    |
| GET    | `/contact`                          | 联系人/群聊列表；可传 `filter`、`type`            |
| GET    | `/chatroom`                         | 群聊列表；可传 `keyword`                          |
| GET    | `/recent_chat`                      | 最近会话；可传 `limit`                            |
| GET    | `/chatlog`                          | 会话消息；必填 `talker`，可传 `time` 或时间戳范围 |
| GET    | `/media/{messageId}`                | 获取图片消息的真实图片二进制资源                  |
| GET    | `/group_snapshot`                   | 群成员快照；必填 `md5`                            |
| GET    | `/resolve`                          | 昵称、wxid、md5 解析；必填 `q`                    |
| GET    | `/wechat-personal/send-capability`  | 个人微信图片发送能力状态                          |
| GET    | `/scheduled-reports`                | 查询全部定时日报任务                              |
| GET    | `/scheduled-reports/:id`            | 查询单个定时日报任务                              |
| POST   | `/scheduled-reports`                | 创建定时日报任务                                  |
| PATCH  | `/scheduled-reports/:id`            | 修改定时日报任务                                  |
| DELETE | `/scheduled-reports/:id`            | 删除定时日报任务（执行前必须获得用户确认）        |
| POST   | `/scheduled-reports/:id/enable`     | 启用定时日报任务                                  |
| POST   | `/scheduled-reports/:id/disable`    | 暂停定时日报任务                                  |
| POST   | `/scheduled-reports/:id/run`        | 立即执行一次并返回 execution                      |
| GET    | `/scheduled-reports/:id/executions` | 查询执行记录                                      |
| POST   | `/report`                           | 将已有日报结构渲染为 HTML/PNG                     |
| GET    | `/agent/status`                     | Agent Hub、连接器和数据库状态                     |
| POST   | `/agent/group-report`               | 按群和 `today`/`yesterday`/`7days` 生成总结图片   |
| POST   | `/agent/send`                       | 已连接机器人发送测试                              |

## 定时日报管理

定时日报由 TraceMemo 自己持久化和调度。Agent 只负责理解自然语言、解析群聊和时间，再调用上述 API；不要创建 cron、维护任务文件、计算下一次执行时间或自行发送微信。

### 创建任务

用户提出“每天早上 9 点给技术交流群发昨天的日报”时，按以下顺序执行：

1. 调用 `/health`，确认 TraceMemo 和数据库可用。
2. 调用 `/wechat-personal/send-capability`，只有 `capability.status === "ready"` 且 `capability.capabilities.image === true` 才允许继续。
3. 用户使用“今天”“昨天”等相对日期时调用 `/current_time`；日报任务的 `schedule.time` 使用 TraceMemo 本机时区的 `HH:mm`，不要转成 UTC。
4. 调用 `/chatroom` 或 `/contact?type=group` 查找群聊。名称匹配多个结果时，必须把候选项展示给用户并要求选择；不能猜测。
5. 使用唯一群聊的 `talker` 创建：

```json
{
  "name": "技术交流群 · 每日日报",
  "group": { "talker": "xxx@chatroom", "name": "技术交流群" },
  "schedule": { "type": "daily", "time": "09:00" },
  "reportRange": "yesterday",
  "target": { "type": "wechat_group", "talker": "xxx@chatroom" },
  "enabled": true
}
```

如果 API 返回 `409` 且 `error === "duplicate"`，告诉用户相同任务已经存在，不要再次创建。能力状态为 `unsupported`、`unconfigured`、`needs_binding`、`needs_verification` 或 `error` 时，直接说明需要先在 TraceMemo 设置中完成个人微信绑定和消息能力检测。

### 查看、修改和执行

- “我现在有哪些定时日报”调用 `GET /scheduled-reports`，使用返回的 `tasks` 展示任务名称、群聊、每天的时间、范围、目标和启停状态。
- 修改前先查询列表并确认唯一任务，再调用 `PATCH /scheduled-reports/:id`。只提交需要修改的字段，例如 `{"schedule":{"type":"daily","time":"10:00"}}`。
- 暂停调用 `/scheduled-reports/:id/disable`，恢复调用 `/scheduled-reports/:id/enable`。
- “现在执行一次”调用 `/scheduled-reports/:id/run`，不要改用 `/agent/group-report` 后自行发送微信；该接口和定时执行共用同一条链路。
- 查询执行结果调用 `/scheduled-reports/:id/executions`，根据 `status`、`startedAt`、`finishedAt`、`message` 和 `error` 向用户解释结果。

### 删除确认

删除是不可逆操作。收到删除请求后，先用任务列表找到唯一任务，向用户展示任务名称、时间、日报范围和发送目标并明确询问确认；只有用户明确确认后，才调用 `DELETE /scheduled-reports/:id`。

## 时间与上下文规则

`/chatlog` 的 `time` 支持 `YYYY-MM-DD`、日期闭区间和分钟范围；也可以使用 Unix 秒级 `startTime`/`endTime`。时间按 TraceMemo 所在机器的本机时区解释。

当用户问“某个话题是谁说的、后来结论是什么”时，先定位会话和时间，再读取关键消息前后文。回答时区分：

- 原消息明确写出的内容；
- 根据多条消息整理出的总结；
- 没有来源支持的推断。

## 媒体消息

当 `/chatlog` 返回图片消息时：

1. 如果用户只是询问图片消息是否存在，不需要获取图片。
2. 如果用户要求查看、识别、理解或分析图片，使用该消息 `media.url`（`/media/{messageId}`）获取真实图片。
3. 不要根据 `[图片]`、消息文本或文件名猜测图片内容。
4. 获取成功后，将图片交给当前 Agent 的视觉能力。
5. 如果图片获取失败，明确说明无法读取图片。
6. 不要声称看到了没有成功获取的图片。
7. 不要向用户暴露 Token、本地文件路径或数据库路径。

### 图片分析

用户：“看看张三昨天发的那张截图。”

1. 调用 `/health`；必要时调用 `/current_time`。
2. 调用 `/resolve`，再调用 `/chatlog` 找到 `type` 为图片的消息。
3. 调用 `/media/{messageId}`，将返回的图片交给 Vision。
4. 必要时读取图片消息前后若干条消息，结合聊天上下文回答。

不要只根据 `[图片]` 猜测内容，不要把一次 OCR 当作完整图片理解，也不要直接读取任意本地图片路径。

## 隐私和安全

只读取用户请求所需的会话和时间范围。不要把完整聊天数据库、密钥或 Token 暴露给用户。Reader API 本身不自动把聊天转发到外部服务器，但当前 Agent 可能会把工具结果交给其配置的模型；如有疑问，提醒用户检查 Agent 的数据策略。

## 常见错误

- `401`：Token 缺失、错误或被轮换；请用户回 API Center 复制最新 Token。
- `403`：浏览器 Origin 不在 loopback 允许列表；CLI/Agent 通常不带 Origin。
- `404`：先用 `/resolve` 确认会话标识。
- `422`：`messageId` 无效，或消息不是可读取的图片。
- `503`：用户还没有完成数据库连接或对应服务未就绪。
- 空结果：缩小/扩大时间范围，确认账号和会话，再检查媒体或语音是否可读。
