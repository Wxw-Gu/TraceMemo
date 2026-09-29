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
  <img src="./public/日报.png" alt="TraceMemo 日报" />
</p>

<p align="center">
  <img src="./public/自动化.png" alt="TraceMemo 自动化" />
</p>


---

## 🎨 社区日报模板

TraceMemo 日报除了内置版式，也支持从社区模板市场安装更多样式。社区模板与默认日报读取同一份真实日报数据，只改变展示方式，适合手机长图分享、桌面归档、团队复盘等不同场景。

<p align="center">
  <a href="https://github.com/Wxw-Gu/TraceMemo-Templates"><b>浏览 TraceMemo 模板社区</b></a>
  ·
  <a href="https://github.com/Wxw-Gu/TraceMemo-Templates/tree/main/skills/tracememo-template-contributor"><b>用 AI 制作并投稿模板</b></a>
</p>

在 TraceMemo 中打开：

**日报 → 社区模板市场**

即可查看、预览、安装和切换已发布的社区模板。

如果你有一张喜欢的日报长图、网页或前端项目，也可以把它交给 Codex、ChatGPT 或其他能够读取 GitHub 仓库的 AI，并让它读取 [TraceMemo Template Contributor Skill](https://github.com/Wxw-Gu/TraceMemo-Templates/tree/main/skills/tracememo-template-contributor)。AI 可以帮助你完成模板转换、真实预览，并在你确认满意后向 [TraceMemo-Templates](https://github.com/Wxw-Gu/TraceMemo-Templates) 提交 Pull Request。

模板通过审核并正式发布后，其他 TraceMemo 用户即可在模板市场中安装使用。

---

## TraceMemo 是什么

TraceMemo（迹忆）原名 **WechatExplorer** 是一款本地优先的微信数据、AI 分析与自动化工作台，把聊天变成可浏览、可搜索、可理解、可追溯的信息。

先用档案找原话，再按需要使用 AI Search、日报、监控或 Agent。普通浏览、搜索和导出不需要 AI。

## 核心能力

- 💬 **聊天档案与搜索**：浏览会话，按关键词、备注、昵称或 wxid 查找消息。
- 🔍 **AI Search / 问问微信**：用自然语言找回模糊记忆，并查看来源。
- 🧠 **本地知识库**：在本机建立索引，让跨会话、跨时间的查询更稳定。
- 🖼️ **图片文字索引**：在本机识别微信图片里的文字（截图、公告、报价图），识别结果可以在搜索和「问问微信」里被检索。识别全程不联网，原始图片不会因为本地识别而上传。
- 📊 **群聊日报**：生成今日、昨日或近 7 天的群聊总结，可保存为 HTML 与 PNG。
- 🗣️ **群发言统计**：统计群成员的发言量和沉默成员，看清一个群里谁在说、谁一直没说。
- 👀 **退群监控**：用成员快照对比记录群成员退出事件，支持多群与事件历史。
- ⚙️ **自动化**：把上面几步按规则串起来——定时生成并发送日报、成员退群时发送通知；能发到哪里取决于当前的发送能力。
- 🔊 **文字转语音**：把文字生成语音，试听后发送到当前会话。
- 🤖 **Agent Hub**：在微信里向本机 TraceMemo 提问。
- 🔌 **外部 Agent / Local HTTP API**：让 Codex 等外部 Agent 查询本机微信历史。

## 💻 平台支持

TraceMemo 2.5.0 支持：

- **Windows x64**
- **macOS Apple Silicon（M 系列 / arm64）**
- **macOS Intel（x64）**

Windows 与 macOS 均支持微信本地数据库连接与数据库 Key 获取。

### 关于“发送能力”

浏览、搜索、日报生成、导出、知识库和图片文字索引都不需要额外的发送组件。只有**把内容真正发回微信**这一步——自动发送日报、退群通知、把语音发到会话——依赖本机发送能力：

发送能力未就绪、未绑定或发送失败时，报告本身仍会正常生成并保存在本机，执行记录会显示为“已生成，但未发送”或“已生成，发送失败”，可以稍后重试。

## 项目缘起

<details>

TraceMemo 最早叫 **WechatExplorer**。

**2025 年 12 月**，我做出了第一个版本。当时功能很简单：解析微信 3.0 的聊天记录，再用 AI 生成群聊日报。最初只是给自己用，想把散落在微信里的信息重新找出来，也方便看看群里每天聊了什么。

第一个版本完成后，项目搁置了一段时间。后来重新捡起来，我还是想继续做群聊日报，但微信已经更新到 4.x，原来的微信 3.0 数据解析方案不再适用。

为了支持微信 4.x，我开始重新研究数据访问。这部分工作最初得到了 **WeFlow** 很大的帮助。早期 TraceMemo 曾参考 WeFlow 历史版本中的实现和思路，借此解决了数据库消息、密钥获取等微信 4.x 数据访问问题。

随着项目继续发展，我逐步把这部分底层能力从原有实现中抽离，并重新实现了一套独立的数据访问兼容层。目前会继续保持与 WeFlow 历史接口和行为的兼容，以减少上层业务迁移成本。

也就是说，**WeFlow 是 TraceMemo 进入微信 数据访问领域的重要起点。没有 WeFlow，就没有今天的 TraceMemo。**

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

| 想做什么                           | 使用入口                      |
| ---------------------------------- | ----------------------------- |
| 找记得原文或关键词的消息           | 档案搜索                      |
| 找记得大意、但不知道在哪聊过的内容 | 问问微信（AI Search）         |
| 找到截图、公告图里写过的文字       | 问问微信 → 图片文字索引       |
| 长期跨群查询历史                   | 本地知识库                    |
| 了解一个群今天或近 7 天聊了什么    | 日报                          |
| 看群里谁最活跃、谁一直没说话       | 档案 → 群聊 → 群发言统计      |
| 持续关注群成员退出                 | 退群监控                      |
| 按计划自动生成并发送群聊日报       | 自动化                        |
| 成员退群时自动发一条通知           | 自动化 → 退群通知             |
| 把文字生成微信语音                 | 文字转语音                    |
| 在微信里向本机 TraceMemo 提问      | Agent Hub                     |
| 让 Codex 等工具查询微信历史        | Reader Skill / Local HTTP API |
| 把聊天保存成文件                   | 导出                          |

## 快速开始

1. 从 [GitHub Releases](https://github.com/Wxw-Gu/TraceMemo/releases) 下载对应平台的安装包。
2. 启动应用，按“第一次使用”页面选择微信数据目录并完成连接。
3. 打开“档案”，确认联系人和消息已加载后开始搜索。
4. 需要 AI 时，在“设置 → AI 模型”添加并测试 Provider。

详细步骤见[第一次使用 TraceMemo](./docs/user-guide/getting-started.md)。

## 文档

- [用户指南](./docs/README.md#档案与搜索)
- [AI / Knowledge](./docs/README.md#ai-与知识库)
- [日报与自动化](./docs/README.md#日报与自动化)
- [Agent / API](./docs/README.md#agent--api)
- [开发文档](./docs/development/overview.md)
- [隐私与安全](./docs/user-guide/privacy.md)

完整目录由[文档首页](./docs/README.md)维护。

## 支持平台

| 平台    | 架构                           | 微信连接                              | 安装包                          |
| ------- | ------------------------------ | ------------------------------------- | ------------------------------- |
| Windows | x64                            | 支持微信 4.x                          | `tracememo-<version>-setup.exe` |
| macOS   | Apple Silicon（M 系列、arm64） | 自动获取数据库 Key，已适配微信 4.1.13 | `tracememo-<version>-arm64.dmg` |
| macOS   | Intel（x64）                   | 自动获取数据库 Key，已适配微信 4.1.13 | `tracememo-<version>-x64.dmg`   |

## 参与贡献

稳定版在 `main`，只在发版时更新；所有改动都先进 `develop`，随**下一个版本**一起发布。

**提 PR 请基于 `develop` 拉新分支，并把 PR 的目标分支设为 `develop`** —— 指向 `main` 的 PR 会被直接关闭。

分支流程、提交信息风格、PR 前自检，以及**给 AI Agent 的硬性规则**，都在[参与贡献指南](./CONTRIBUTING.md)。

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

我可能会按照自己的兴趣继续折腾，也可能突然加入一些奇奇怪怪、但觉得有意思的功能

也因此，这个项目随时可能继续折腾，也可能因为其他事情暂时搁置。如果你有想要的功能，可以提Issue；如果觉得现有实现不符合你的需求，也欢迎直接 Fork 后自己改。

<p align="center">
  <b>TraceMemo（迹忆）</b>
  <br />
  把微信聊过的事，找回来、问清楚、留下来。
</p>
