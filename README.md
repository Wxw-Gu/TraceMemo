# TraceMemo（迹忆）

<p align="center">
  <img src="./build/icon.png" width="120" alt="TraceMemo Logo" />
</p>

<h2 align="center">把微信里的信息，记住、理解、监控，并在需要时行动</h2>

<p align="center">本地优先的微信数据、AI 分析与自动化工作台</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/Wxw-Gu/TraceMemo?style=for-the-badge" alt="GitHub stars" />
  <img src="https://img.shields.io/github/downloads/Wxw-Gu/TraceMemo/total?style=for-the-badge" alt="GitHub downloads" />
  <img src="https://img.shields.io/github/v/release/Wxw-Gu/TraceMemo?style=for-the-badge" alt="Latest release" />
</p>

<p align="center">
  <a href="https://github.com/Wxw-Gu/TraceMemo/releases"><b>下载 TraceMemo</b></a>
  ·
  <a href="./docs/user-guide/getting-started.md"><b>第一次使用</b></a>
  ·
  <a href="./docs/README.md"><b>完整文档</b></a>
  ·
  <a href="./docs/concepts/how-it-works.md"><b>TraceMemo 如何工作</b></a>
</p>

<p align="center">
  <img src="./public/software-1.png" alt="TraceMemo 主界面" />
</p>

<p align="center">
  <img src="./public/机器人.png" alt="TraceMemo 微信机器人" />
</p>

---
## TraceMemo 是什么

TraceMemo（迹忆）原名 **WechatExplorer** 是一款本地优先的微信数据、AI 分析与自动化工作台，把聊天变成可浏览、可搜索、可理解、可追溯的信息。

先用档案找原话，再按需要使用 AI Search、日报、监控或 Agent。普通浏览、搜索和导出不需要 AI。

## 核心能力

- 💬 **聊天档案与搜索**：浏览会话，按关键词或身份信息查找。
- 🔍 **AI Search / 问问微信**：用自然语言找回模糊记忆，并查看来源。
- 🧠 **本地知识库**：建立索引，提升跨会话查询稳定性。
- 📊 **群聊日报**：生成今日、昨日或近 7 天的群聊总结。
- 👀 **群成员变化监控**：记录指定群聊的退群动态。
- 🔊 **文字转语音**：生成语音，试听后发送到选定会话。
- 🤖 **Agent Hub**：在微信里调用本机 TraceMemo。
- 🔌 **外部 Agent / Local HTTP API**：让外部 Agent 查询本机微信历史。

## 项目缘起

<details>

TraceMemo 最早叫 **WechatExplorer**。

**2025 年 12 月**，我做出了第一个版本。当时功能很简单：解析微信 3.0 的聊天记录，再用 AI 生成群聊日报。最初只是给自己用，想把散落在微信里的信息重新找出来，也方便看看群里每天聊了什么。

第一个版本完成后，项目搁置了一段时间。后来重新捡起来，我还是想继续做群聊日报，但微信已经更新到 4.x，原来的微信 3.0 数据解析方案不再适用。

为了支持微信 4.x，我开始重新研究数据访问。这部分工作最初得到了 **WeFlow** 很大的帮助。早期 TraceMemo 曾参考 WeFlow 历史版本中的实现和思路，借此解决了数据库消息、密钥获取等微信 4.x 数据访问问题。

随着项目继续发展，我逐步把这部分底层能力从原有实现中抽离，并重新实现了一套独立的数据访问兼容层。目前会继续保持与 WeFlow 历史接口和行为的兼容，以减少上层业务迁移成本。

也就是说，**WeFlow 是 TraceMemo 进入微信   数据访问领域的重要起点。没有 WeFlow，就没有今天的 TraceMemo。**


在此基础上，项目陆续加入了：

- 本地知识库
- 消息来源追溯
- 群聊日报
- 语音消息也参与知识库等问答
- 微信机器人
- Local HTTP API
- Reader Skill
- Agent 接入
- 多种聊天记录导出能力
- 退群监控
- 文字转语音
- 持续监控自动化能力

群聊日报后来被一些人看到，项目也开始有了 Star、Fork、使用反馈和功能建议。说实话，我一开始没想到，这个原本只给自己用的小工具，会得到这么多人的关注。

这些关注和反馈让我决定认真把项目继续做下去。WechatExplorer 就这样一步一步变成了今天的 **TraceMemo（迹忆）**。

感谢每一位使用、关注和反馈过的人。

</details>

---

## 💬 交流与反馈

<p align="center">
  <img src="./public/二维码.jpg" alt="TraceMemo 交流与售后群二维码" width="280" />
</p>

## 从你的任务开始

| 想做什么 | 使用入口 |
| --- | --- |
| 找记得原文或关键词的消息 | 档案搜索 |
| 找记得大意、但不知道在哪聊过的内容 | AI Search / 问问微信 |
| 长期跨群查询历史 | 本地知识库 |
| 了解一个群今天或近 7 天聊了什么 | 群聊日报 |
| 持续关注群成员退出 | 退群监控 |
| 按计划生成并发送群聊日报 | 定时日报 |
| 把文字生成微信语音 | 文字转语音 |
| 在微信里向本机 TraceMemo 提问 | Agent Hub |
| 让 Codex 等工具查询微信历史 | Reader Skill / Local HTTP API |
| 把聊天保存成文件 | 导出 |

## 快速开始

1. 从 [GitHub Releases](https://github.com/Wxw-Gu/TraceMemo/releases) 下载对应平台的安装包。
2. 启动应用，按“第一次使用”页面选择微信数据目录并完成连接。
3. 打开“档案”，确认联系人和消息已加载后开始搜索。
4. 需要 AI 时，在“设置 → AI 模型”添加并测试 Provider。

详细步骤见[第一次使用 TraceMemo](./docs/user-guide/getting-started.md)。

## 文档

- [用户指南](./docs/README.md#用户指南)
- [AI / Knowledge](./docs/README.md#ai-与知识库)
- [Monitor / Automation](./docs/README.md#日报与自动化)
- [Agent / API](./docs/README.md#agent--api)
- [开发文档](./docs/development/overview.md)
- [隐私与安全](./docs/user-guide/privacy.md)

完整目录由[文档首页](./docs/README.md)维护。

## 支持平台

| 平台 | 架构 | 安装包 |
| --- | --- | --- |
| Windows | x64 | `-setup.exe` |
| macOS | Apple Silicon（M 系列、arm64） | `.dmg` |

## 致谢

TraceMemo 的诞生离不开开源社区中许多优秀项目的工作。

### 特别感谢 WeFlow

TraceMemo 在早期适配微信 4.x 时，曾参考 **[WeFlow](https://github.com/hicccc77/WeFlow)** 历史版本中的相关实现和思路，包括数据库访问、密钥获取等底层能力。

特别感谢作者 **[hicccc77](https://github.com/hicccc77)**。项目与 WeFlow 的具体关系见[项目缘起](#项目缘起)。

### 其他参考项目

- **[WechatMessageExplorer](https://github.com/svcvit/WechatMessageExplorer)**
  - 提供了数据解析相关思路。

- **[chatlog](https://github.com/sjzar/chatlog)**
  - 提供了数据处理方面的参考。

- **[wechat_chatter](https://github.com/yincongcyincong/wechat_chatter)**
  - 提供了发送方面的参考。

感谢所有开源作者，也感谢所有帮助 TraceMemo 发现问题、提出建议和持续使用它的人。

---

## 最后说两句

这个项目起初只是一个一时兴起的项目，所以它大概也不会有一份特别严肃的产品路线图。

我可能会按照自己的兴趣继续折腾，也可能突然加入一些奇奇怪怪、但觉得有意思的功能—— 比如让AI给某个好友, 某个群发一个语音条(逗逗群友) 或者定时生成群聊日报并做成微信卡片。

也因此，这个项目随时可能继续折腾，也可能因为其他事情暂时搁置。如果你有想要的功能，可以提Issue；如果觉得现有实现不符合你的需求，也欢迎直接 Fork 后自己改。

<p align="center">
  <b>TraceMemo（迹忆）</b>
  <br />
  把微信聊过的事，找回来、问清楚、留下来。
</p>
