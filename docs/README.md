# TraceMemo 文档

TraceMemo 的文档按“你想完成什么”组织，而不是按源码模块组织。

## 从这里开始

- [第一次使用](./user-guide/getting-started.md)：安装、连接微信、完成第一次搜索和提问。
- [查看和搜索聊天](./user-guide/chat-archive.md)：找原话、回看上下文、处理媒体。
- [用 AI 查找聊天信息](./user-guide/ai-search.md)：理解普通搜索和 AI Search 的区别，并核对答案来源。

## 你可以完成的任务

- [建立本地知识库](./user-guide/knowledge.md)
- [生成群聊日报和总结](./user-guide/report.md)
- [实验性：自托管微信分享卡片](./deployment/experimental-wechat-share-card.md)
- [交给 Agent 自动部署微信分享卡片](./skill/setup-wechat-share-card/SKILL.md)
- [语音转文字](./user-guide/voice.md)
- [导出聊天档案](./user-guide/export.md)
- [防撤回](./user-guide/recall-protection.md)
- [在微信里向 TraceMemo 提问](./agent/agent-hub.md)
- [数据、隐私与安全](./user-guide/privacy.md)
- [常见问题与排查](./user-guide/troubleshooting.md)

## 如果你想了解 AI 为什么这样回答

- [如何核对 AI 的回答来源](./concepts/answer-sources.md)：用用户语言解释依据、来源标记和查找过程。
- [从微信数据到回答、日报和导出](./concepts/how-it-works.md)：了解哪些步骤在本机完成，哪些步骤可能调用 Provider。

## 微信机器人和外部 Agent

TraceMemo 有两种不同的接入方式。微信机器人是普通用户可以直接使用的产品能力；Reader Skill 和 Local HTTP API 面向已经在使用 Codex、Claude Code、OpenClaw 等外部 Agent 的用户。

| 你想做什么                                                            | 应该看哪里                                                                 |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 在微信里给机器人发消息，让本机读取数据、生成总结并回复                | [Agent Hub](./agent/agent-hub.md)                                          |
| 在 Codex、Claude Code、OpenClaw 等外部 Agent 中主动查询过去的微信数据 | [Reader Skill](./agent/reader-skill.md) + [Local HTTP API](./agent/api.md) |

### 在微信里提问

打开应用一级导航中的“Agent”，进入“Agent Hub”后扫码登录微信机器人。机器人收到文字消息后，可以查询最近会话、读取联系人聊天、生成群聊总结图片或总结群成员发言，并把结果回复给发消息的人。它需要本地微信数据库已经连接；依赖 AI 的任务还需要配置 AI 服务。

- [Agent Hub](./agent/agent-hub.md)：连接机器人、查看运行状态和了解实时交互边界。

### 让外部 Agent 查询历史微信

连接 Reader Skill 后，你可以询问：

> “总结今天技术交流群讨论了什么。”  
> “过去一周有没有人提到这个项目？”

- [Agent 接入概览](./agent/overview.md)：先选择适合你的接入方式。
- [Reader Skill](./agent/reader-skill.md)：安装并让外部 Agent 按需读取聊天。
- [Local HTTP API](./agent/api.md)：完整端点和请求示例。
- [API 安全](./agent/api-security.md)：Bearer Token、CORS、轮换和边界。

## 开发与平台

- [macOS 数据访问说明](./platform/macos.md)
- [开发、测试与构建](./development/overview.md)
- [本地启动排障](./development/local-startup-troubleshooting.md)
- [v2.2.0 正式品牌身份与安全升级迁移](./agent/release-notes-v2.2.0.md)
- [v2.1.9 API 鉴权迁移说明](./agent/release-notes-v2.1.9.md)

当前工作区版本：**2.2.0**。文档只描述当前代码已经实现的能力；版本兼容性、AI Provider 行为和媒体读取结果可能随系统、微信客户端和服务商变化。
