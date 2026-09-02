# TraceMemo（迹忆）

<p align="center">
  <img src="./build/icon.png" width="120" alt="TraceMemo Logo" />
</p>

<h2 align="center">把微信聊过的事，找回来、问清楚、留下来</h2>

<p align="center">
  本地优先的微信聊天记录工作台：查看、搜索、提问、总结和导出<br />
  查看聊天 · 找回信息 · AI 问答 · 微信群聊总结 · 语音转写 · 导出 · 微信机器人 · Agent 接入
</p>

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
</p>

<p align="center">
  <img src="./public/software-1.png" alt="TraceMemo 主界面" />
</p>

<p align="center">
  <img src="./public/机器人.png" alt="TraceMemo 微信机器人" />
</p>

---

## TraceMemo（迹忆）是什么

TraceMemo（迹忆）是一款**本地优先、可追溯的 AI 微信知识与分析工作台**。

TraceMemo 原名 **WechatExplorer**，是一次从“微信聊天记录探索工具”向“可追溯的本地 AI 知识工作台”演进后的正式品牌升级。

它可以帮你浏览、搜索和整理微信历史，也可以让 AI 帮你找回聊过的内容，并回到原始消息核对答案。

你可以直接浏览聊天，也可以用自然语言提问：

> “上个月我们讨论过哪些发布问题？”
>
> “张三之前发过的项目地址在哪里？”
>
> “技术交流群今天有哪些结论和待办？”

它和普通聊天记录查看器最大的不同，是 AI 不只是告诉你答案，还会告诉你答案来自哪里。

你可以看到答案参考了哪些内容、来自哪个会话和时间，再回到原始消息确认它有没有理解错。

TraceMemo 不提供任何微信聊天数据，也不鼓励收集、上传、出售、共享或未经授权处理他人的聊天记录。使用 TraceMemo 时，请确保你对所处理的数据具有合法的访问和使用权限，并自行承担相应的数据安全与合规责任。

---

## 为什么叫 TraceMemo（迹忆）

<details>  
`Trace` 代表聊天记录留下的痕迹、可以追溯的信息来源、AI 搜索过程，以及从结果回到原始聊天上下文并核对证据的能力。

`Memo` 代表记忆、知识沉淀和长期保存：让聊天中产生的信息逐渐形成个人知识。

“迹忆”可以理解为“留下痕迹的记忆”。

TraceMemo 不是单纯查看微信聊天记录的工具，而是希望让聊天中产生的信息留下痕迹，并能够被再次找到、理解、验证和沉淀。

> **品牌说明**
>
> TraceMemo（迹忆）原名 WechatExplorer。WechatExplorer 最初是一个用于查看和探索微信聊天记录的工具。随着本地搜索、AI 问答、来源追溯、知识库、日报、语音转写和 Agent 能力逐渐形成，项目已经从单纯的聊天记录查看器发展为本地 AI 知识与分析工作台，因此在 v2.2.0 正式更名为 TraceMemo（迹忆）。

</details>

---

## 项目缘起

<details>

TraceMemo 最早叫 **WechatExplorer**。

**2025 年 12 月**，我做出了第一个版本。当时功能很简单：解析微信 3.0 的聊天记录，再用 AI 生成群聊日报。最初只是给自己用，想把散落在微信里的信息重新找出来，也方便看看群里每天聊了什么。

第一个版本完成后，项目搁置了一段时间。后来重新捡起来，我还是想继续做群聊日报，但微信已经更新到 4.x，原来的微信 3.0 数据解析方案不再适用。

为了支持微信 4.x，我开始重新研究数据访问。这部分工作得到了 **WeFlow** 很大的帮助。TraceMemo 目前的微信 4.x 数据连接能力，参考并使用了 **WeFlow 历史版本中的相关实现和思路**，包括数据库密钥获取、图片解密等底层能力。

> **没有 WeFlow，就没有今天的 TraceMemo。**

WeFlow 帮我跨过了微信 4.x 数据访问这道门槛，我才有机会继续做后面的事情：让聊天记录可以被搜索、理解和总结，也让 AI 给出的答案能够回到原始消息核对。

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

群聊日报后来被一些人看到，项目也开始有了 Star、Fork、使用反馈和功能建议。说实话，我一开始没想到，这个原本只给自己用的小工具，会得到这么多人的关注。

这些关注和反馈让我决定认真把项目继续做下去。WechatExplorer 就这样一步一步变成了今天的 **TraceMemo（迹忆）**。

感谢 WeFlow，也感谢每一位使用、关注和反馈过 TraceMemo 的人。

</details>

---

## 💬 交流与反馈

<p align="center">
  <img src="./public/二维码.jpg" alt="TraceMemo 交流与售后群二维码" width="280" />
</p>

## 从你的任务开始

| 我现在想做什么                            | 在应用里打开                                                        | 需要准备什么                         |
| ----------------------------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| 找一句记得原文或关键词的聊天              | [档案](./docs/user-guide/chat-archive.md)                           | 连接微信数据，不需要 AI              |
| 找一件记得大意、但不知道在哪聊过的事      | [问问微信](./docs/user-guide/ai-search.md)                          | 配置 AI 服务，并选择会话和时间范围   |
| 让长期、跨群聊查找更稳定                  | [问问微信 → 本地知识库](./docs/user-guide/knowledge.md)             | 主动建立本地索引；不会自动创建       |
| 快速了解一个群今天、昨天或近 7 天聊了什么 | [日报](./docs/user-guide/report.md)                                 | 选择群聊并配置 AI 服务               |
| 把群聊日报生成微信分享卡片（实验性）      | [微信分享卡片](./docs/deployment/experimental-wechat-share-card.md) | 自备 Cloudflare、域名和微信测试号    |
| 把微信语音变成可搜索的文字                | [设置 → 语音转文字](./docs/user-guide/voice.md)                     | 准备本地语音模型                     |
| 把聊天保存成 HTML、Markdown、CSV 或 JSON  | [导出](./docs/user-guide/export.md)                                 | 选择聊天、时间和格式，不需要 AI      |
| 尽量保留之后捕获到的撤回消息              | [设置 → 防撤回](./docs/user-guide/recall-protection.md)             | 默认关闭；开启前先了解写入和性能边界 |
| 直接在微信里向 TraceMemo 提问             | [微信机器人](./docs/agent/agent-hub.md)                             | 扫码连接机器人；总结类任务需要 AI    |
| 让 Codex 等外部 Agent 查询微信历史        | [外部 Agent](./docs/agent/overview.md)                              | 安装 Reader Skill 并配置本机 Token   |

---

## 最核心的三个能力

### 生成群聊日报

选择群聊和时间范围后，可以让 AI 把聊天整理成报告，并保存为 HTML 与 PNG 长图。

报告包含：

- 热点
- 重要消息
- 资源
- 问答
- 待办
- 未解决事项
- 活跃统计
- 图片精选

具体内容取决于消息、媒体是否可读以及模型能力。
详细说明：[生成群聊日报](./docs/user-guide/report.md)

</details>

### AI 帮你找回聊过的内容

打开“问问微信”，选择搜索范围和时间，然后像提问一样描述你想找的内容。

TraceMemo 会先在本机查找候选消息，再把整理后的少量来源交给你配置的 AI 模型生成回答。

你可以查看答案参考了哪些聊天、来自哪个人和时间，并从来源标记跳回原始消息核对；“查看检索详情”还会展示本次查找经历了哪些阶段。

<p align="center">
  <img src="./public/问一问.png" alt="问问微信与聊天来源" />
</p>

详细说明：[使用 AI 查找聊天信息](./docs/user-guide/ai-search.md)

### 直接在微信里问你的历史聊天

打开应用中的“Agent”入口（页面标题为“Agent Hub”，对应微信机器人功能），扫码连接一个微信机器人账号。

例如，你可以直接给机器人发送：

- “最近 5 个会话”
- “张三最近和我聊了什么”
- “总结今天的技术交流群”

TraceMemo 会在本机读取已连接的聊天数据并把结果回复到微信。

这个入口不要求另外安装 Codex、Claude Code 等外部 Agent。

当前主要处理文字消息，不支持群发、定时任务或通用自主操作微信；总结和自然语言理解需要先配置 AI 服务。

详细步骤和能力边界见[在微信里向 TraceMemo 提问](./docs/agent/agent-hub.md)。

---

## 其他能力

### 本地知识库

<details>
“问问微信”里的“本地知识库”会为当前微信账号建立一份留在本机的可检索资料。

它把聊天文本、附件信息和已有语音转写整理起来，让跨会话、跨时间查找更稳定。

它只在用户主动建立后工作，可以同步、查看占用并清理；清理不会删除微信原始数据库。

详细说明：[本地知识库](./docs/user-guide/knowledge.md)

</details>

### 实验性：生成微信分享卡片

<details>
TraceMemo 可以把群聊日报长图上传到你自己部署的 Cloudflare Worker 和 R2，并生成可在微信中分享的临时网页、二维码及卡片信息。

该功能需要自备 Cloudflare 账号、域名和微信测试号，目前不属于开箱即用的稳定功能。

<p align="center">
  <img src="./public/微信卡片分享.png" alt="微信卡片分享效果示例" />
</p>

详细说明：[实验性微信分享卡片](./docs/deployment/experimental-wechat-share-card.md)。

不熟悉命令行的用户，可以把[自动部署 Skill](./docs/skill/setup-wechat-share-card/SKILL.md)直接交给 Codex 或 Claude Code。

</details>

### 转写微信语音

<details>  
TraceMemo 支持在本机转写单条或批量微信语音，结果可以参与本地知识库检索和 HTML 导出。

转写本身不要求把语音文件发送给在线 AI；随后用于 AI 问答或日报时，文字会按对应功能的规则处理。

详细说明：[语音转文字](./docs/user-guide/voice.md)

</details>

### 导出长期可用的聊天档案

<details>
支持 HTML、CSV、JSON 和 Markdown。

HTML 可携带媒体、头像和可选语音转写，支持最多五个会话合并，也可以压缩为 ZIP；增量合并、媒体资源和 ZIP 只适用于 HTML，其他格式主要保留文本内容。

详细说明：[导出聊天](./docs/user-guide/export.md)

</details>

### 在外部 Agent 中查询微信历史

<details>
通过 Reader Skill 和本机 Local HTTP API，Codex、Claude Code、OpenClaw 等外部 Agent 可以按需查询联系人、群聊和聊天记录。

这和微信机器人是两条不同路径：

- **微信机器人**：收到消息后在微信中回复。
- **外部 Agent**：主动查询历史。

安装和技术说明请看[Agent 接入概览](./docs/agent/overview.md)与[Local HTTP API](./docs/agent/api.md)。

</details>

---

## 它如何工作

```mermaid
flowchart LR
    A[本机微信数据] --> B[TraceMemo 读取与解析]
    B --> C[聊天档案]
    B --> D[本地知识库与搜索]
    D --> E[筛选相关聊天来源]
    E --> F[用户配置的 AI 模型]
    F --> G[带来源的回答]
    B --> H[整理日报输入]
    H --> F
    B --> I[聊天导出]
    B --> J[Local HTTP API]
    J --> K[外部 Agent]
    L[微信机器人消息] --> M[Agent Hub]
    M --> B
    M --> F
```

- 微信数据库读取、聊天解析、知识库索引和离线语音识别在本机完成。
- 普通浏览、普通搜索和导出不要求配置 AI 服务。
- 使用“问问微信”、群聊日报或图片理解等 AI 功能时，完成任务所需的内容可能发送到你选择的模型服务；具体发送范围和确认方式以对应功能页面为准。
- “问问微信”会先在本机缩小范围，不会默认把整个微信数据库作为一次模型请求发送。

完整边界见：[数据、隐私与安全](./docs/user-guide/privacy.md)

---

## 支持平台与安装包

| 平台    | 处理器架构                     | Releases 安装包 |
| ------- | ------------------------------ | --------------- |
| Windows | x64                            | `-setup.exe`    |
| macOS   | Apple Silicon（M 系列、arm64） | `.dmg`          |

当前版本不支持 Intel 芯片的 Mac。

当前代码面向微信 4.x 数据结构。实际连接结果仍会受到微信客户端版本、账号数据状态和系统权限影响；macOS 首次连接可能需要按页面提示完成额外授权。

---

## 快速开始

1. 从 [GitHub Releases](https://github.com/Wxw-Gu/TraceMemo/releases) 下载安装包。
2. 启动 TraceMemo，按照“第一次使用”页面选择微信数据目录。
3. 第一次使用请先点击“开始连接”，按页面提示准备连接组件并获取数据库密钥；只有已经有密钥的高级用户才需要“手动连接”。
4. 连接成功后打开“档案”，确认联系人和聊天消息已经出现。
5. 先在“档案”里搜索一句你记得的原话；这一步不需要 AI。
6. 需要 AI 问答或日报时，在“设置 → AI 模型”添加并测试 AI 服务，再打开“问问微信”或“日报”。
7. 想直接在微信里提问时，打开“Agent”扫码连接微信机器人；想让 Codex 等外部 Agent 查询时，再进入“API”。

Windows 安装后无法启动时，请先安装 [Microsoft Visual C++ x64 运行库](https://aka.ms/vc14/vc_redist.x64.exe)。

当前完整测试过的微信客户端为 Windows `4.1.9.57` 和 macOS `4.1.8.100`；下载地址与连接要求见[第一次使用](./docs/user-guide/getting-started.md)。

从 WechatExplorer v2.1.9 升级时，TraceMemo v2.2.0 会在首次启动检测旧设置、Knowledge、Token、AI Provider 和 Agent 数据，并在用户确认后复制到新的 TraceMemo 数据目录。

迁移不会覆盖已有 TraceMemo 数据，也不会删除旧目录；详情见 [v2.2.0 正式品牌身份与安全升级迁移](./docs/agent/release-notes-v2.2.0.md)。

如果 macOS 页面提示处理 SIP，请先阅读对应说明。具体步骤和限制见[第一次使用](./docs/user-guide/getting-started.md)。

完整步骤：[第一次使用 TraceMemo](./docs/user-guide/getting-started.md)

---

## 配置 AI

需要 AI 问答、群聊日报或图片理解时，在“设置 → AI 模型”添加并测试一个服务。

应用支持云端服务、Ollama 等本地服务和自定义接口；具体服务商的配置、计费和数据规则由服务商决定。

使用本地服务可以减少数据离开电脑的路径，但本地服务的日志和配置仍由你自己负责。

开发者和 Agent 用户可以从[Agent 接入概览](./docs/agent/overview.md)开始，再按需要查看[Local HTTP API](./docs/agent/api.md)与[API 安全](./docs/agent/api-security.md)。

---

## 文档

- [文档首页](./docs/README.md)
- [第一次使用](./docs/user-guide/getting-started.md)
- [聊天档案与搜索](./docs/user-guide/chat-archive.md)
- [AI 查找聊天信息](./docs/user-guide/ai-search.md)
- [本地知识库](./docs/user-guide/knowledge.md)
- [群聊日报](./docs/user-guide/report.md)
- [实验性微信分享卡片](./docs/deployment/experimental-wechat-share-card.md)
- [微信分享卡片自动部署 Skill](./docs/skill/setup-wechat-share-card/SKILL.md)
- [语音转文字](./docs/user-guide/voice.md)
- [导出聊天](./docs/user-guide/export.md)
- [防撤回](./docs/user-guide/recall-protection.md)
- [数据、隐私与安全](./docs/user-guide/privacy.md)
- [Agent 接入](./docs/agent/overview.md)
- [微信机器人与 Agent Hub](./docs/agent/agent-hub.md)
- [Local HTTP API](./docs/agent/api.md)
- [开发与测试](./docs/development/overview.md)

---

## 本地开发

需要 Node.js、pnpm 7+、对应平台的 Electron/native 构建环境，以及 Go（用于微信连接器）。

```bash
pnpm install
pnpm dev
```

常用检查：

```bash
pnpm typecheck
pnpm test:unit
pnpm test:component
pnpm test:integration
pnpm test:e2e:build
```

完整说明：[开发、测试与构建](./docs/development/overview.md)

---

## 支持与反馈

遇到问题时，先查看[常见问题与排查](./docs/user-guide/troubleshooting.md)。

提交 Issue 时请提供：

- 操作系统
- 微信版本
- TraceMemo 版本
- 复现步骤
- 已遮挡敏感信息的截图

请仅处理你有权访问的数据，并遵守适用的法律法规、组织政策和微信使用规则。

数据库读取、解密、自动化和机器人能力都可能受平台版本与账号环境影响。

---

## 许可说明

TraceMemo 当前暂未提供独立的项目 `LICENSE` 文件。

TraceMemo 允许个人使用、学习、修改、二次开发和 Fork，也欢迎基于项目进行非商业用途的再开发和分享。

**但未经项目维护者书面许可，禁止将 TraceMemo 本身或基于 TraceMemo 的衍生版本用于商业用途，包括但不限于商业软件、付费服务、商业产品、SaaS 服务或其他直接或间接的商业活动。**

仓库中的第三方组件以及参考项目均遵循各自适用的许可证和使用条款。TraceMemo 对第三方项目的参考、使用或集成，并不意味着这些第三方项目的代码或许可证发生变化。涉及第三方代码的部分，请以对应项目的许可证和授权范围为准。

---

## 致谢

TraceMemo 的诞生离不开开源社区中许多优秀项目的工作。

### 特别感谢 WeFlow

TraceMemo 在支持微信 4.x 时，参考并使用了 **[WeFlow](https://github.com/hicccc77/WeFlow)** 历史版本中的相关实现和思路，包括数据库密钥获取、图片解密等底层能力。

特别感谢作者 **hicccc77** 的理解和包容。项目与 WeFlow 的具体关系见[项目缘起](#项目缘起)。

### 其他参考项目

- **[WechatMessageExplorer](https://github.com/svcvit/WechatMessageExplorer)**
  - 提供了数据库解析相关思路。

- **[chatlog](https://github.com/sjzar/chatlog)**
  - 提供了数据处理方面的参考。

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
