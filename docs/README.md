# TraceMemo 文档

文档按产品任务和使用场景组织。需要集成或开发时，再看 Agent、概念和开发文档。

## 档案与搜索

- [第一次使用](./user-guide/getting-started.md)：安装、连接微信并完成第一次搜索。
- [聊天档案与搜索](./user-guide/chat-archive.md)：浏览联系人和群聊，按关键词、备注、昵称、微信号或 wxid 查找消息；也包含档案中的文字转语音入口。

## AI 与知识库

- [AI Search / 问问微信](./user-guide/ai-search.md)：用自然语言找回记得大意、但不知道在哪个会话里的内容，并查看 Evidence、Citation 和 Search Trace。
- [本地知识库](./user-guide/knowledge.md)：主动建立本地索引，提升跨会话、跨时间查询的稳定性。
- [如何核对 AI 的回答来源](./concepts/answer-sources.md)：从来源回到原始消息，检查上下文和覆盖范围。
- [从微信数据到回答、日报和导出](./concepts/how-it-works.md)：了解哪些步骤在本机完成，哪些 AI 功能可能调用 Provider。

## 日报与自动化

- [群聊日报](./user-guide/report.md)：手动生成今日、昨日或近 7 天的群聊报告，也可以创建定时日报。
- 定时日报会依次生成报告、保存 Report History，再按当前微信发送能力尝试通知；发送失败时可复用已有 PNG 重试。
- 自动发送和监控动作通过统一执行边界，并保留执行记录；简要说明见[产品工作方式](./concepts/how-it-works.md#动作执行与审计)。

## Monitor

退群监控会比较当前成员与上一份有效快照，记录成员退出事件。它支持多群、Last Good Snapshot 和事件历史；监控关闭期间的变化不会在重新开启后补报。工作方式见[产品工作方式](./concepts/how-it-works.md#退群监控)。

## 语音能力

- [语音转文字](./user-guide/voice.md)：在本机转写微信语音，结果可用于搜索、Knowledge 和导出。
- [聊天档案与搜索](./user-guide/chat-archive.md#文字转语音)：把文字生成微信语音，试听后发送到当前联系人或群聊。

## Agent / API

Agent Hub 让微信机器人调用本机 TraceMemo；Reader Skill / Local HTTP API 让外部 Agent 主动查询历史数据。

- [Agent 接入概览](./agent/overview.md)
- [Agent Hub](./agent/agent-hub.md)
- [Reader Skill](./agent/reader-skill.md)
- [Local HTTP API](./agent/api.md)
- [API 安全](./agent/api-security.md)

## 导出与隐私

- [导出聊天](./user-guide/export.md)：导出 HTML、Markdown、CSV 或 JSON 档案。
- [数据、隐私与安全](./user-guide/privacy.md)：本地处理、Provider、媒体和 Token 的数据边界。
- [常见问题与排查](./user-guide/troubleshooting.md)：按安装、连接、AI、媒体和 Agent 现象排查。

## 开发文档

- [开发、测试与构建](./development/overview.md)
- [本地启动排障](./development/local-startup-troubleshooting.md)
- [macOS 数据访问说明](./platform/macos.md)
- [关闭 SIP 教程](./mac-disable-sip.md)

## 实验性功能与第三方

- [实验性：自托管微信分享卡片](./deployment/experimental-wechat-share-card.md)
- [微信分享卡片自动部署 Skill](./skill/setup-wechat-share-card/SKILL.md)
- [TraceMemo Reader Skill 文件](./skill/tracememo-reader/SKILL.md)
- [第三方组件说明](./third-party/wechat-chatter/NOTICE.md)

## 版本说明

- [v2.2.0 品牌与安全迁移](./agent/release-notes-v2.2.0.md)
- [v2.1.9 API 鉴权迁移](./agent/release-notes-v2.1.9.md)

文档按当前 develop 已实现的能力维护，不在首页固定写死版本号。版本兼容性、AI Provider 行为和媒体读取结果可能随系统、微信客户端和服务商变化。
