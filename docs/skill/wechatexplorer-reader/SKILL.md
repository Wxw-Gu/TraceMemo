---
name: wechatexplorer-reader
description: 通过本地 HTTP API 读取 WechatExplorer 解锁后的微信聊天数据(本地服务由 WechatExplorer.app 提供)。当用户提到微信聊天记录、群消息、看看群里说了什么、查一下微信、分析微信对话、总结群聊等场景时,使用此技能。注意:此技能的数据源是用户本机 WechatExplorer app。
---

# WechatExplorer Reader

通过本地 HTTP API(`http://127.0.0.1:6131`)读取 WechatExplorer 已经解锁的微信数据库内容。

## 数据源

- **本服务由 WechatExplorer.app 提供**,数据完全在本地处理,不会上传任何服务器
- 用户必须在 WechatExplorer 主窗口完成**首次密钥配置**(解锁 WCDB 数据库)
- 默认监听 `127.0.0.1:6131`,仅本机可访问,无需鉴权

## 前置条件

1. **安装并启动 WechatExplorer.app**(从项目 release 页面下载)
2. **首次启动时完成密钥配置**:在主界面第一步输入微信数据库密钥(64 位 hex),完成 WCDB 初始化
3. **如需 7×24 提供 API**:用 `WXE_TRAY=1` 或 `--tray` 参数启动 app,启用菜单栏常驻模式(主窗口关闭后服务仍在)

## API 列表

GET 用于读取数据,`POST /api/v1/report` 用于生成群日报(HTML + 长图)。所有端点返回 JSON。

| 端点 | 用途 | 关键参数 |
|------|------|---------|
| `GET /api/v1/health` | 健康检查 + 是否已初始化 | — |
| `GET /api/v1/current_time` | 获取当前本地时间(用于"今天/昨天"换算) | — |
| `GET /api/v1/contact` | 联系人 / 群聊列表 | `filter`(昵称模糊)、`type`(`user` \| `group`) |
| `GET /api/v1/chatroom` | 群聊列表(等同 contact?type=group) | `keyword` |
| `GET /api/v1/recent_chat` | 最近会话 | `limit`(默认 50) |
| `GET /api/v1/chatlog` | 聊天记录 | `talker`、`time` 或 `startTime`/`endTime` |
| `GET /api/v1/group_snapshot` | 群成员快照 | `md5` |
| `GET /api/v1/resolve` | 把昵称/wxid/md5 解析成 md5 | `q` |
| `POST /api/v1/report` | 生成群聊日报 HTML + 长图 PNG | JSON body(见下文,推荐传 `metadata.talker` 让服务端自动反推真头像) |

### `talker` 参数可接受的值

`chatlog` 和 `recent_chat` 的 `talker` / 列表项 ID 支持以下三种形式,服务端会按 `nickname → wxid → md5` 顺序匹配:

1. **群昵称 / 好友备注**(模糊匹配,如 `技术交流`、`摸鱼群`)
2. **微信 wxid**(如 `wxid_abc123`、`gh_xxxxx@chatroom`)
3. **会话 md5**(如 `49023470180@chatroom` 的 md5 哈希,可在 `contact` 接口里看到)

不确定时先调 `GET /api/v1/resolve?q=<输入>` 校验,返回 `{ md5, m_nsUsrName, m_nsNickName, type, ... }`。

### `chatroom` 与 `contact?type=group` 字段一致性

`/chatroom` 和 `/contact?type=group` 返回的是**同一个集合**(都是 `listContacts().filter(type==='group')`),字段也完全一致:

```json
{
  "m_nsUsrName": "49023470180@chatroom",   // wxid, 用作 chatlog 的 talker
  "m_nsNickName": { "buffer": "...", "type": "Buffer" },  // nickname 原 buffer
  "type": "group",
  "md5": "..."
}
```

需要 `displayName` 时从 `m_nsNickName` 里解析;需要拉消息就传 `m_nsUsrName` 当 talker。

## 时间范围格式(`time` 参数)

支持以下格式:

| 输入 | 含义 |
|------|------|
| `2026-07-03` | 单日 00:00:00 ~ 23:59:59 |
| `2026-07-01~2026-07-03` | 日期范围(闭区间) |
| `2026-07-03/14:30` | 单分钟(从 14:30:00 起 60 秒) |
| `2026-07-03/14:30~2026-07-03/15:30` | 精确到分钟的范围 |

也可以直接传 unix 秒级时间戳作为 `startTime` 和 `endTime`。

### "今天 / 昨天 / 本周" 的时区语义

所有 `time` / `startTime` / `endTime` 都按**用户本机时区**解析(由 `current_time` 里的 `timezone` 字段给出,典型为 `Asia/Shanghai`)。含义如下:

- "今天 2026-07-03" → 本机 2026-07-03 00:00:00 ~ 23:59:59(北京时间 24 小时),**不是** UTC 当天
- "昨天" → 本机昨天 0 点 ~ 23:59:59
- "本周" → 本周一 0 点 ~ 当前时刻(按本机时区所在周的周一)

跨时区时(如用户在国外):仍以本机时区为准,需要按 UTC 处理时显式传 unix 时间戳。

## 时间预检工作流(Time-Aware Workflow)

**重要**:只要用户请求中包含"今天"、"昨天"、"本周"、"刚才"等相对时间概念,**禁止**直接生成日期字符串。

**步骤 1**:先调用 `current_time` 工具获取本地 RFC3339 时间。
**步骤 2**:根据返回的时间计算对应的 `time` 参数。
**步骤 3**:用计算后的参数调 `chatlog`。

示例:
- 用户: "今天 摸鱼交流群 聊了啥?"
- AI: 先 `GET /api/v1/current_time` → 得到 `2026-07-03T14:30:00+08:00` → 计算 `time=2026-07-03` → `GET /api/v1/chatlog?talker=摸鱼交流群&time=2026-07-03`

## 多步上下文检索(强制)

当查询特定话题或特定发送者发言时,**必须**按以下流程操作:

1. **初步定位**:用 `contact` 或 `chatroom` 端点确定群聊 md5 / wxid
2. **粗查**:用 `chatlog` + 较宽时间范围找到相关消息时间点
3. **精查**:对每个关键时间点分别查前后 15-30 分钟(不带任何 keyword 过滤),用完整上下文分析

**禁止**:仅凭一次粗查结果直接回答用户。

## 生成群日报(POST /api/v1/report)

当用户希望输出**可视化群日报**(长图 PNG + HTML 邮件版)时,用这个端点。WechatExplorer 内置 `mobile_daily_report.html` 模板,渲染后会同时落盘 `htmlPath` 和 `pngPath`,并返回 `imageDataUrl` 可直接预览。

### 请求体(`GroupReportExportRequest`)

```json
{
  "report": {
    "overview": "一句话总览,20-80 字",
    "topics": [
      {
        "title": "话题标题",
        "timeRange": "10:00-12:30",
        "heat": "高",            // "高" | "中" | "低"
        "participants": ["张三", "李四"],
        "summary": "本话题讨论了什么",
        "conclusion": "可选,达成的结论",
        "keywords": ["关键词1", "关键词2"]
      }
    ],
    "resources": [
      { "title": "链接/文件标题", "description": "为什么重要", "sender": "张三" }
    ],
    "importantMessages": [
      { "sender": "张三", "time": "10:23", "content": "原消息文本", "note": "为什么重要" }
    ],
    "quotes": [
      {
        "messages": [{ "sender": "李四", "content": "原话1" }, { "sender": "王五", "content": "原话2" }],
        "note": "为什么这些话值得引用"
      }
    ],
    "qa": [
      { "question": "Q", "answer": "A", "answerer": "解答人(可选)" }
    ],
    "unresolved": [
      { "question": "待跟进问题", "owner": "相关人(可选)", "status": "待跟进", "note": "为什么还没结束" }
    ],
    "storylines": [
      { "title": "剧情线", "stages": [{ "time": "10:12", "event": "提出问题" }], "result": "可选结果" }
    ],
    "reversals": [
      { "topic": "某话题", "initialView": "最初判断", "finalView": "最终判断", "note": "可选说明" }
    ],
    "participantChains": [
      { "topic": "某话题", "chain": ["A 提出", "B 补充", "C 收尾"], "note": "可选说明" }
    ],
    "analytics": {
      "topicHeat": [{ "topic": "话题1", "score": 9.5 }],
      "activeTimeline": "10:00-12:00 为最活跃时段",
      "topSpeakers": [{ "name": "张三", "count": 58 }],
      "voiceLeaderboard": [{ "sender": "张三", "count": 3, "durationSec": 97 }]
    },
    "keywords": ["高频词1", "高频词2"],
    "hero": {
      "headline": "一句抓重点的日报标题",
      "summary": "一句概览",
      "keyTakeaway": "最重要结论",
      "pendingNote": "待跟进事项"
    }
  },
  "metadata": {
    "groupName": "技术交流",
    "reportDate": "2026-07-03",
    "dateRange": "2026-07-03 全天",
    "messageCount": 1234,
    "activeUsers": 56,
    "timeSpan": "00:00-23:59",
    "generatedAt": "2026-07-03 22:00",
    "recordNote": "本日报由 WechatExplorer 自动生成",
    "footerNote": "底部附加说明",
    "heroParticipants": ["张三", "李四"],
    "avatars": {},
    "talker": "技术交流",
    "timeRange": "2026-07-03"
  }
}
```

### 响应(`GroupReportExportResult`)

```json
{
  "success": true,
  "htmlPath": "/Users/.../Desktop/技术交流_日报_2026-07-03.html",
  "pngPath":  "/Users/.../Desktop/技术交流_日报_2026-07-03.png",
  "imageDataUrl": "data:image/png;base64,iVBORw0K..."
}
```

成功返回 200;失败返回 500 + `{ success: false, error: "..." }`。HTML 和 PNG 用 `mobile_daily_report.html` 模板渲染,长图宽度自适应移动端预览。

### 典型工作流

1. 调 `current_time` + `chatlog` 拉取当天/目标时间段消息
2. LLM 总结生成 `report` + `metadata`(直接走 AI 总结即可,无需自己造数据)
3. POST 到 `/api/v1/report` 拿到 `htmlPath` / `pngPath`,把文件路径告诉用户即可在 Finder 打开
4. **不要**自己拼 HTML/PNG,模板已内置,只需组织好 report/metadata 字段

### 必填字段与隐式约束(踩坑提示)

`metadata` 的以下字段**必填**,缺一返回 500:

- `groupName`、`reportDate`、`dateRange`、`generatedAt`
- `heroParticipants`:数组,模板会把每个名字当 key 去 `metadata.avatars[name]` 取头像图
- `avatars`:对象,**每个 `heroParticipants` 里的名字都必须有这个 key**(没有就传 `""`,**不要省略整段**),否则模板渲染会抛 `Cannot read properties of undefined (reading '<名字>')` 报 500

`report` 的以下字段**必须存在**(空就传 `[]`,**不能省略**),否则模板遍历时会抛 `Cannot read properties of undefined (reading 'map')` 报 500:

- `report.topics`(至少 1 个,完全没话题就改用纯文本总结,不要硬生成空日报)
- `report.resources`
- `report.importantMessages`
- `report.quotes`
- `report.qa`
- `report.analytics.topicHeat`
- `report.analytics.topSpeakers`(至少 1 个)
- `report.keywords`

最小安全示例:

```json
{
  "report": {
    "overview": "...",
    "topics": [],
    "resources": [],
    "importantMessages": [],
    "quotes": [],
    "qa": [],
    "analytics": { "topicHeat": [], "activeTimeline": "", "topSpeakers": [] },
    "keywords": []
  },
  "metadata": {
    "groupName": "技术交流",
    "reportDate": "2026-07-07",
    "dateRange": "2026-07-07 全天",
    "heroParticipants": ["张三", "李四"],
    "avatars": { "张三": "", "李四": "" }
  }
}
```

`report.importantMessages[].time` 用 `HH:mm` 格式(不要 ISO 时间戳);`report.analytics.topicHeat[].score` 数字 0-10。

### 4 个数字格子的内容必须紧凑(避免塌陷)

模板顶部的 4 个统计格(`消息数 / 活跃人数 / 时间跨度 / 主要话题`)宽度均分,内容过长会被截断或换行:

| 字段 | 推荐格式 | 反例(会撑爆格子) |
|------|---------|----------------|
| `metadata.messageCount` | 纯数字 `"1234"` | `"约 1.2k 条"` |
| `metadata.activeUsers` | 纯数字 `"56"` | `"大约 50 多人"` |
| `metadata.timeSpan` | **持续时长紧凑半角** `"1 h"` / `"30 min"` / `"2 d"` | `"1 小时"` / `"7 小时"` / `"1天3小时"` |
| `metadata.topicCount` 等 | 数字 / 短中文 | 长句子 |

`timeSpan` 是**首条到末条消息的持续时长**,不是时间区间。**单位用半角空格分隔**:

- `< 1 h` → `"30 min"`
- `1~24 h` → `"1 h"` / `"7 h"`(整数,向上取整)
- `> 24 h` → `"2 d"`(整数,向上取整)

**首末条消息的具体时间点**:`dateRange` 字段会显示完整日期 + 起止时间(无长度限制),模板里 dateRange 是 hero 区的副标题,跟 stat 格子分开。

**区间叙事**(如"主要集中在上午 10 点-12 点")放 `report.analytics.activeTimeline`,那是模板里单独一段的描述,不被 stat 格子限制。

**不传 timeSpan**:服务端会用空字符串渲染(stat 格会空),subagent 应当总是算好时长填进来,或者 renderer 端会自动算(见 renderer 源码)。

### 头像:服务端自动反推(推荐)

**v1.4 起无需手动拼 `avatars` 字典**。在 `metadata` 里加 `talker`(群昵称/wxid/md5 都行),服务端会用 `getGroupSnapshot` 拉全量群成员,按 `nickname → avatar` 自动反推填进 `metadata.avatars`。LLM 总结里出现的 `heroParticipants` / `topics[].participants` / `topSpeakers[].name` 等所有名字都会被覆盖。

**优先级**:客户端传的 `avatars[name]`(非空字符串) > 服务端反推 > 占位 SVG(姓名首字母 + 随机色块)。

**回退**:不传 `talker` 时按 `metadata.avatars` 字典取;还取不到则生成 SVG 占位(`fallbackAvatar`),**不会变空白方块**(v1.4 修了 data URL 正则,SVG 占位能正常嵌入)。

**手动覆盖**:仍可传 `avatars` 字典强制使用自定义头像,例如 `{"张三": "data:image/jpeg;base64,..."}`。

**P2 风险**:群里有两人同名(如"杨伟")时,服务端只取首条;客户端可手动覆盖。

## 隐私安全原则

1. **最小化原则**:只返回用户明确请求的内容,不过度展开无关聊天
2. **本地处理**:所有数据来自用户本机,API 不缓存、不转发
3. **摘要优先**:对于大量聊天记录,先提供摘要而非完整 dump
4. **用户确认**:涉及敏感内容时,先展示摘要,让用户决定是否继续深入

## 典型工作流示例

**示例 1:今日群聊总结(纯文本)**
1. `GET /api/v1/current_time` → 获取今天日期
2. `GET /api/v1/chatroom?keyword=技术交流` → 找到目标群 md5
3. `GET /api/v1/chatlog?talker=技术交流&time=2026-07-03` → 拉取今天的聊天
4. AI 用 LLM 生成总结报告(话题 TOP N、最活跃发言者等)

**示例 2:搜索特定消息上下文**
1. `GET /api/v1/chatlog?talker=摸鱼群&time=2026-07-01~2026-07-03` → 粗查近 3 天
2. 在返回的消息中定位关键词出现的时间点 T1, T2, ...
3. 对每个 Ti 分别查 `chatlog?talker=摸鱼群&time=Ti-15min~Ti+15min`,分析上下文

**示例 3:群日报(可视化长图)**
1. `GET /api/v1/chatlog?talker=技术交流&time=2026-07-03` → 拉今天聊天
2. LLM 按上方 `GroupDailyReport` schema 总结出 `report` + `metadata`
3. `POST /api/v1/report` body = 上述 JSON → 拿到 `htmlPath` / `pngPath` / `imageDataUrl`
4. 把 `imageDataUrl` 给用户预览,把 `pngPath` 路径告诉用户用 Finder 打开

## 错误处理

- `503` → WechatExplorer 未初始化(密钥未配置),提示用户在主窗口完成配置
- `404 talker not found` → talker 不存在,先调 `contact` 或 `resolve` 确认 md5/wxid
- `400 missing required parameter` → 检查必填参数(talker / md5 / q)
- `200` 但 `result.warnings: ['enrich skipped: talker "X" not found']` → `/report` 的 `metadata.talker` 解析失败,头像走 SVG fallback(不阻断生成)
- `200` 但 `result.warnings: ['enriched N member avatars from snapshot (M members)']` → enrich 成功(诊断用)
- `400 请求体为空 / 需包含 report 和 metadata` → 调用 `/report` 时 body 必须是非空 JSON,且有这两个顶层字段
- `500 success=false` → 模板渲染失败,通常因 `report` 字段缺失或 `metadata.groupName/reportDate` 为空,检查后重试

## 配置 Claude Desktop

把以下加入 `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wechatexplorer": {
      "command": "npx",
      "args": ["-y", "@wechatexplorer/mcp-bridge"]
    }
  }
}
```

(待 P3 实现 — MCP bridge 包,在此之前可直接用 `curl` 调用 HTTP API,或通过 mcp-remote 桥接。)

## 配置 Claude Code / Codex

在 `~/.claude/settings.json` 或项目级 `.claude/settings.local.json` 中:

```json
{
  "mcpServers": {
    "wechatexplorer": {
      "url": "http://127.0.0.1:6131"
    }
  }
}
```

(视 MCP over HTTP 支持情况调整)
