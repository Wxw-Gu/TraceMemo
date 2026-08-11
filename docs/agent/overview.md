# 在微信机器人或外部 Agent 中使用 TraceMemo

TraceMemo 提供两条不同路径。先按你实际想做的事选择，不需要先理解 Agent、Skill 或 API 等术语。

| 你想做什么                                           | 使用方式                      | 需要什么                                                  |
| ---------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| 直接在微信里发文字，让本机查询聊天并回复             | 微信机器人（Agent Hub）       | 在应用“Agent”页面扫码登录机器人；部分任务需要 AI Provider |
| 在 Codex、Claude Code、OpenClaw 等工具里查询微信历史 | Reader Skill + Local HTTP API | 安装 Skill，并配置本机 API Token                          |

## 直接在微信里提问

打开应用一级导航中的“Agent”，进入“Agent Hub”，扫码登录一个微信机器人账号。之后用另一个微信账号向机器人发送文字，它会调用 TraceMemo 的本机数据，必要时使用已配置的 AI，再把结果回复给发送者。

可以先尝试：

- “最近 5 个会话”；
- “帮我看看最近跟张三聊了些什么”；
- “生成产品交流群今天的群聊总结图片”。

这条路径不要求安装 Reader Skill，也不要求用户配置 API Token。它主要处理文字请求，不支持群发、定时任务或与文字同等的任意媒体理解。

连接步骤、当前任务清单和安全边界见[Agent Hub](./agent-hub.md)。

## 在外部 Agent 中查询历史微信

Reader Skill 是给外部 Agent 的操作说明。安装后，Codex、Claude Code、OpenClaw 或其他本地 Agent 可以通过 TraceMemo Local HTTP API 按需读取联系人、群聊、最近会话、指定时间范围的聊天和群成员信息。

典型问题包括：

- “总结今天技术交流群讨论的内容。”
- “帮我找上个月讨论过的项目地址。”
- “过去一周有没有人提到退款？”

外部 Agent 不会直接打开微信数据库文件，但它能取得本机 API 返回的聊天内容。Agent 是否继续把结果发送给云端模型，取决于 Agent 自己的模型和工具配置。

## 外部 Agent 的安装步骤

1. 启动 TraceMemo 并完成微信数据库连接。
2. 打开一级导航“API”（页面为“API Center”），确认本地 API、数据库和 Reader Skill 都可用。
3. 选择目标 Agent，点击“复制安装指令”。
4. 在 Agent 自己的 Skill/配置目录执行或粘贴指令。
5. 在 API Center 复制当前 Token，并在 Agent 运行环境中设置 `TRACEMEMO_API_TOKEN`。
6. 先让 Agent 调用 health，再尝试查询最近会话。

详细说明：[Reader Skill](./reader-skill.md)、[Local HTTP API](./api.md)、[API 安全](./api-security.md)。

## 不要混淆两条路径

- Agent Hub：微信机器人收到实时文字后处理并回复；
- Reader Skill/API：外部 Agent 主动查询历史数据；
- `127.0.0.1:6131` 是 Local HTTP API，不是 MCP Server；
- Local HTTP API 当前没有对外提供实时入站消息订阅。
