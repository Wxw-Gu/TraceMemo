# Reader Skill：让外部 Agent 读取微信

## 先理解它能做什么

Reader Skill 是一份给 Agent 的操作说明。安装后，Codex、Claude Code、OpenClaw 或其他本地 Agent 可以按需调用 TraceMemo，读取联系人、群聊、最近会话、指定时间的聊天和群成员信息。

它使用的是 TraceMemo Local HTTP API，不是 MCP Server。

Reader Skill 只负责“外部 Agent 主动查询历史微信数据”。它不负责二维码登录、监听微信实时消息、接收机器人消息或管理 Agent Hub。想让机器人收到微信消息后处理并回复，请阅读[Agent Hub](./agent-hub.md)。

正式 Reader Skill 名称和目录是 `tracememo-reader`，新安装使用 `TRACEMEMO_API_TOKEN`。已安装的旧 `wechatexplorer-reader` 可在 v2.2.0 兼容期内继续使用旧变量。

## 推荐安装流程

1. 启动 TraceMemo 并完成数据库连接。
2. 打开“API Center”，确认 API 服务和数据库状态正常。
3. 在 Reader Skill 区域选择目标 Agent，点击“复制安装指令”。
4. 把指令粘贴到对应 Agent 的 Skill/配置目录；应用会根据本机路径生成适合 Codex、Claude Code、OpenClaw 或通用 Agent 的说明。
5. 在 API Center 复制 Token，在 Agent 自己的本地环境设置：

   ```bash
   export TRACEMEMO_API_TOKEN="<YOUR_API_TOKEN>"
   ```

6. 先执行 health 检查，再读取数据端点。

TraceMemo 不会自动把 Token 写进 Agent 配置。重新生成 Token 后，必须同步更新 Agent 环境。

## Agent 的读取顺序

当用户使用“今天”“昨天”“本周”等相对时间时：

1. 调用 `/api/v1/current_time` 获取本机时区和日期；
2. 将相对时间换算为 `chatlog` 支持的 `time` 或时间戳；
3. 调用 `/api/v1/resolve`、`contact` 或 `chatroom` 确认会话；
4. 调用 `/api/v1/chatlog` 读取目标范围；
5. 对重要结论再读取关键消息前后文，不要只凭一次粗查。

## 最小请求

```bash
curl http://127.0.0.1:6131/api/v1/health

curl -H "Authorization: Bearer $TRACEMEMO_API_TOKEN" \
  "http://127.0.0.1:6131/api/v1/recent_chat?limit=20"
```

## 当前能力范围

Reader Skill 可以指导 Agent 使用：

- 联系人、群聊、最近会话和会话解析；
- 指定会话、日期或时间戳范围的聊天记录；
- 群成员快照；
- 结构化日报渲染和按群聊生成总结图片；
- Agent Hub 状态检查与已连接机器人发送测试。这里的发送接口是开发者/测试用途，不是实时机器人入口，也不会让 Reader Skill 自动监听微信消息。

端点、参数、错误码和鉴权细节以[Local HTTP API](./api.md)为准。Skill 文件保持短小，避免在多个文档中复制会变化的完整响应 schema。

## 隐私边界

Reader Skill 本身不会把聊天数据自动上传到其他服务器；它只是让 Agent 调用本机 API。Agent 读取结果是否继续发送给云端模型，取决于 Agent 自己的模型和工具配置。请同时阅读[数据、隐私与安全](../user-guide/privacy.md)。
