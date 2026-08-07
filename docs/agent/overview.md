# 连接 Agent：你能用它做什么

WechatExplorer 的 Agent 能力分成“查询过去的数据”和“处理实时微信消息”两条路径。先按你想完成的任务选择，不需要先学习内部模块名称。

## 两种不同的使用方式

### 让外部 Agent 查询历史微信

连接 Reader Skill 后，你可以在本机的 Codex、Claude Code、OpenClaw 或其他 Agent 中询问自己的微信历史，例如：

- “总结今天技术交流群讨论的内容。”
- “帮我找上个月讨论过的项目地址。”
- “过去一周有没有人提到退款？”

Agent 会按需读取 WechatExplorer 提供的联系人、群聊和聊天记录；它不会直接打开微信数据库文件。

| 方式 | 适合谁 | 作用 | 是否需要外部 Agent 配置 |
| --- | --- | --- | --- |
| Reader Skill + Local HTTP API | 想在 Codex/Claude Code/OpenClaw 中查微信的人 | Agent 通过本机 HTTP 请求读取聊天 | 是，需要安装 Skill 和 Token |
| Agent Hub | 想从微信机器人账号发消息、让本机处理并回复的人 | 微信连接器把消息送到本机 Hub，Hub 调用数据和 AI | 不使用外部 Reader Skill，但需要扫码连接机器人 |

这两条路径不要混写：Reader Skill/API 是外部 Agent 主动读取历史；Agent Hub 是机器人收到实时消息后处理并回复。`127.0.0.1:6131` 是 Local HTTP API，不是 MCP Server。

## 外部 Agent 的安装路径

1. 启动 WechatExplorer 并完成微信数据库连接。
2. 打开“API Center”，确认本地 API、数据库和 Reader Skill 都显示可用。
3. 在 API Center 选择目标 Agent（Codex、Claude Code、OpenClaw 或其他 Agent），点击“复制安装指令”。
4. 在 Agent 自己的本地 Skill/配置目录执行或粘贴指令。
5. 在 API Center 复制当前 Token，并在 Agent 运行环境中设置 `WECHATEXPLORER_API_TOKEN`。
6. 先让 Agent 调用 health，再尝试查询联系人或最近会话。

详细说明：[Reader Skill](./reader-skill.md)、[Local HTTP API](./api.md)、[API 安全](./api-security.md)。

## Agent 能看到什么

外部 Agent 通过 API 按需读取联系人、群聊、最近会话、指定时间范围聊天和群成员快照，也可以请求生成群聊总结图片。API 本身不提供任意文件系统浏览，也不会把完整数据库自动上传到网络。

Agent 是否把读取结果再次交给云端模型，取决于 Agent 的模型配置和它如何处理工具结果。使用前请检查 Agent 自己的隐私设置。

## 什么时候用 Agent Hub

如果你希望直接在微信里问“最近 5 条消息是谁？”或“生成产品交流群今天的群聊总结图片”，打开应用主导航中的“Agent”，进入“Agent Hub”，扫码登录一个微信机器人账号。机器人收到文字后，会调用本地数据和已配置的 AI，再把结果回复给发消息的人。

当前实时入口支持最近会话、联系人近期聊天、联系人近 7 天总结、群聊总结图片、群成员发言总结和有限的普通自然语言回复。它不等于通用聊天机器人，也不提供群发、定时或任意媒体理解。

详细流程见[Agent Hub](./agent-hub.md)。
