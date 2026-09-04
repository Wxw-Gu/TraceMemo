# TraceMemo 如何把聊天变成可用的信息

你可以把一次任务想成下面这条路径：

```mermaid
flowchart LR
  A[本机微信数据] --> B[读取与解析]
  B --> C[聊天档案与普通搜索]
  B --> D[本地知识索引]
  D --> E[筛选相关消息]
  E --> F[用户配置的 AI Provider]
  F --> G[回答与可核对来源]
  B --> H[聊天导出]
  B --> I[整理日报输入]
  I --> F
  F --> J[本地保存 HTML 与 PNG]
  B --> K[Local HTTP API]
  K --> L[外部 Agent]
  M[微信机器人消息] --> N[Agent Hub]
  N --> B
  N --> F
  B --> O[Monitor / Snapshot]
  O --> P[Proposed Action]
  F --> P
  P --> Q[Policy]
  Q --> R[Action Gateway]
  R --> S[Personal WeChat Send Capability]
  S --> T[Action Audit / Logs]
```

## Remember → Understand → Monitor → Act

TraceMemo 的工作方式可以概括为：

```text
Remember → Understand → Monitor → Act
```

先读取和整理微信信息，再由 AI、Knowledge 或日报帮助理解；Monitor 负责发现成员变化，明确的业务动作再进入执行边界。回答和动作结果都应能回到来源或记录核对。

## 退群监控

退群监控使用成员快照判断变化：

```text
Current Membership → Snapshot Diff → Member Event
```

上一份有效快照（Last Good Snapshot）不会被不完整读取覆盖，因此重启后仍可继续监控通知。

## 动作执行与审计

自动发送和监控动作经过统一边界：

```text
Feature → Policy → Gateway → Capability → Execution → Audit
```

Policy blocked 表示策略不允许，Capability unavailable 表示当前发送能力不可用，Send failed 表示已经尝试但执行失败。Action Audit / Logs 会保留执行结果；定时日报即使发送失败，也会保留已生成的报告记录。

## 哪些步骤在本机

- 微信数据库读取与解析；
- 聊天档案浏览和普通搜索；
- Knowledge 索引与增量同步；
- 离线语音转写；
- 聊天导出文件、日报 HTML/PNG 和本地历史记录的保存。

## 哪些步骤可能调用外部服务

当你主动使用 AI Search、群聊日报或图片理解时，应用会把完成任务所需的受控问题和上下文发送给你配置的 Provider。它不会因为打开软件就自动上传完整数据库。

Agent Hub 收到微信机器人的文字后，也可能为了理解请求或生成总结调用已配置的 Provider。Reader Skill 调用的是本机 API；外部 Agent 是否把读取结果继续交给云端模型，取决于外部 Agent 自己的配置。

如果 Provider 是 Ollama 等本机服务，请把它视为本机的另一个进程；如果是云服务，数据处理和留存规则由该服务商决定。

## 产品名词和用户任务的对应关系

| 用户想做什么             | 产品中可能看到的名称         |
| ------------------------ | ---------------------------- |
| 让 AI 找相关聊天         | AI Search、Retrieval         |
| 让答案能回到原消息       | Evidence、Citation           |
| 查看 AI 查找过程         | Search Trace                 |
| 让跨会话查找更稳定       | Knowledge、FTS 索引          |
| 让外部 Agent 读取聊天    | Reader Skill、Local HTTP API |
| 让微信机器人调用本机能力 | Agent Hub                    |

先按任务使用，再在需要排查或开发集成时阅读术语。
