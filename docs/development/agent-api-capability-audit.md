# TraceMemo Local HTTP API / Agent API 能力审计

本报告基于当前代码、文档、IPC、Renderer 调用和相关测试做静态审计，对应当前发布应用版本 `2.5.0`；不连接真实微信数据库，也不修改生产代码、API Center 或测试。

主要代码入口：[http-server.ts](../../src/main/http-server.ts)、[automation-rule-store.ts](../../src/main/services/automation-rule-store.ts)、[group-exit-monitor-service.ts](../../src/main/services/group-exit-monitor-service.ts)、[group-stats-service.ts](../../src/main/services/group-stats-service.ts)、[api.md](../agent/api.md)。

## 1. Executive Summary

当前 HTTP 层声明了 **30 个 Method + Path 模板**：15 个 GET、12 个 POST、1 个 PATCH、1 个 DELETE、1 个 HEAD。共享 `LOCAL_API_ENDPOINTS` 定义 **14 个测试项**，但 Renderer 的 `API_ENDPOINTS` 实际只展示 **12 项**；个人微信能力和 `GET /scheduled-reports` 虽有共享定义，界面没有展示。界面也没有结构化 Query、媒体读取、定时日报写操作、退群监控、群统计、Automation 通用资源或执行日志查询。

当前不缺成熟的 Query primitive：结构化读取消息、Knowledge 搜索、消息前后文、会话概览和图片 OCR 搜索已经有 HTTP 契约。真正的能力缺口集中在 **监控配置、自动化规则通用管理、群员统计、执行历史、全局能力发现、发送状态和报告历史**。

几个影响后续设计的代码事实：

1. 定时日报已迁入 `AutomationRuleStore`。当前 `/scheduled-reports` 是旧 HTTP 契约的兼容投影，不是第二份活动规则存储；但它只表达“生成后发回来源群”，其他当前合法目标不会出现在该兼容 API 列表中。
2. 退群监控只负责监测范围、快照和事件历史；退群后如何通知由唯一的 `leave_notification` Automation 规则负责。二者应分别建资源。
3. 群统计 Service 足以提供活跃成员、当前沉默成员、时间范围、新鲜度和限制说明；它没有结构化的 former member 列表，也没有覆盖所有发言者的群总消息数。
4. 现有微信 Action Gateway 有策略、审计和幂等骨架，但策略目前主要校验收件人，以及 Automation purpose allowlist；手动用户 purpose 默认可放行。它只发个人微信，现有 `/agent/send` 则走 iLink 的 `WechatSendGateway`。两者不能直接视为统一的 Agent 安全边界。
5. HTTP 静态 GET handler 大多没有 method guard；对这些路径发 POST、PATCH 或 DELETE 仍会执行读处理。Automation store 的规则落盘失败会记录日志，但仍将内存中的规则返回为成功。

建议先做应用级能力发现、退群监控资源、严格校验后的 Automation CRUD/执行查询；发送和“立即执行”放到有 dry-run、明确确认、幂等键和 Action 审计的后续阶段。

## 2. Current API Inventory

以下按 `http-server.ts` 的路由分派和动态 route factory 盘点。静态读路由的 `Method` 是当前文档和产品语义的预期方法；实际接受方法的差异见本节末尾。

| Method | Path | 能力 | Read/Write/Execute | Service | API Center | 文档 | Agent 价值 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/health` | HTTP 与数据库 ready 状态；唯一免 Token 路径 | Read | `isReady()` | 是 | 是 | 高：连通性 |
| GET | `/api/v1/current_time` | 本机时间、时区、日期 | Read | JavaScript `Date` | 是 | 是 | 中：相对日期换算 |
| GET | `/api/v1/contact` | 联系人和群列表；`filter`、`type`；使用异步 hydration | Read | `chat-service.listContactsAsync` | 是 | 是 | 高：标识发现与 resolve 前置 |
| GET | `/api/v1/chatroom` | 群聊列表；`keyword`；使用异步 hydration | Read | `chat-service.listContactsAsync` | 是 | 是 | 高：群标识发现 |
| GET | `/api/v1/recent_chat` | 最近会话；`limit` 默认 50 | Read | `chat-service.listRecentChat` | 是 | 是 | 高：导航/摘要 |
| GET | `/api/v1/chatlog` | 按 talker 和时间读取原始消息；移除 `contentData.aeskey` | Read | `chat-service.listMessages`、`resolveMd5` | 是 | 是 | 高，但旧式、未做结构化分页 |
| GET | `/api/v1/group_snapshot` | 群成员快照；必填 `md5` | Read | `chat-service.getGroupSnapshot` | 是 | 是 | 高：成员身份解析 |
| GET | `/api/v1/resolve` | 昵称、wxid、md5 解析为会话 | Read | `chat-service.resolveMd5` | 是 | 是 | 高；新资源宜返回稳定 ID 和歧义候选 |
| POST | `/api/v1/report` | 接收完整结构化日报并导出 HTML/PNG；当前拒绝外部 `templateRef` | Write：本地文件 | `group-report-service.exportGroupReport` | 是 | 是 | 低/中：低层渲染契约，Agent 须先拼完整结构 |
| POST | `/api/v1/agent/group-report` | 读群消息、调用 AI 生成群总结、导出 HTML/PNG | Execute：AI/本地文件 | `agent-group-report-service.generateAgentGroupReport` | 是 | 是 | 高但有模型费用/数据出站；结果不等同于报告历史记录 |
| GET | `/api/v1/agent/status` | Agent Hub、connector、数据 API、数据库状态 | Read | `agentHubService.getStatus` | 是 | 是 | 中：只覆盖 Agent Hub，不是应用总能力 |
| POST | `/api/v1/agent/send` | 通过 Agent Hub 连接器发送文字或媒体 | Execute：微信发送 | `agentHubService.testSend` → `WechatSendGateway`/iLink | 是 | 是 | 高但 R2；是测试入口，不含统一 Action policy/幂等确认 |
| GET | `/api/v1/wechat-personal/send-capability` | 个人微信 text/image/voice 能力状态 | Read | `PersonalWechatCapabilityService`，由 `ScheduledReportApiService` 包装 | 否（共享定义有，界面未展示） | 是 | 高但只代表 personal，不代表 iLink |
| GET | `/api/v1/scheduled-reports` | 列出旧 DTO 可表达的定时日报规则 | Read | `ScheduledReportApiService.list` → 规则投影 | 否（共享定义有，界面未展示） | 是 | 高但不完整：仅 `source_chat` 目标 |
| POST | `/api/v1/scheduled-reports` | 创建旧型定时日报，来源群即发送目标 | Write：规则配置 | `ScheduledReportApiService.create` → `AutomationRuleStore` | 否 | 是 | 高；功能受旧 DTO 限制 |
| GET | `/api/v1/scheduled-reports/{id}` | 单条旧型日报规则投影 | Read | `ScheduledReportApiService.get` → `AutomationRuleStore` | 否 | 是 | 中/高：只支持兼容投影规则 |
| PATCH | `/api/v1/scheduled-reports/{id}` | 修改旧型日报规则 | Write：规则配置 | `ScheduledReportApiService.update` → `AutomationRuleStore` | 否 | 是 | 高但只能改旧字段/目标 |
| DELETE | `/api/v1/scheduled-reports/{id}` | 删除旧型日报规则 | Write：删除配置 | `ScheduledReportApiService.delete` → `AutomationRuleStore` | 否 | 是 | 中；新 API 应标 R3 并防护系统规则 |
| POST | `/api/v1/scheduled-reports/{id}/enable` | 启用规则 | Write：配置/未来执行 | `ScheduledReportApiService.setEnabled` → `AutomationRuleStore` | 否 | 是 | 高；启用后未来可能发送微信 |
| POST | `/api/v1/scheduled-reports/{id}/disable` | 暂停规则 | Write：配置 | `ScheduledReportApiService.setEnabled` → `AutomationRuleStore` | 否 | 是 | 高 |
| POST | `/api/v1/scheduled-reports/{id}/run` | 手动触发完整日报规则 | Execute：可能调用 AI、保存历史、发微信 | `ScheduledReportService.runScheduledReportNow` → `AutomationService` | 否 | 是 | 高但 R2；当前无 HTTP 幂等键/确认 |
| GET | `/api/v1/scheduled-reports/{id}/executions` | 旧型 execution 历史和新 Automation execution 投影 | Read | `ScheduledReportService.listExecutions` | 否 | 是 | 高但旧响应模型/有限留存 |
| POST | `/api/v1/scheduled-reports/executions/{executionId}/retry-send` | 旧文档称复用 PNG 重发 | Execute 路由存在但当前固定 `501 not_supported` | `ScheduledReportApiService.retrySend` | 否 | **路径有，语义已失效** | 无：不能重发 |
| GET | `/api/v1/media/{mediaId}` | 读取消息关联的图片二进制 | Read | `http-media-service.readImageMedia` | 否 | 是 | 高：图像证据 |
| HEAD | `/api/v1/media/{mediaId}` | 图片资源存在性/响应头 | Read | `http-media-service.readImageMedia` | 否 | 否 | 低/中 |
| GET | `/api/v1/query/capabilities` | Query Tool 支持的结构化操作、范围和上限 | Read | `LocalQueryApiService.capabilities` | 否 | 是（独立章节） | 高，但不是 TraceMemo 应用能力清单 |
| POST | `/api/v1/query/messages` | 单会话、范围、时间、方向、类型等确定性消息读取 | Read | `LocalQueryApiService.messages` | 否 | 是 | 高：推荐 Query primitive |
| POST | `/api/v1/query/search` | Knowledge 关键词检索，返回覆盖、新鲜度和 OCR 命中 | Read | `LocalQueryApiService.search` + `KnowledgeSearchService` | 否 | 是 | 高：必须读取 coverage/freshness |
| POST | `/api/v1/query/message-context` | 通过 opaque `messageRef` 读取前后文 | Read | `LocalQueryApiService.context` | 否 | 是 | 高：稳定消息引用 |
| POST | `/api/v1/query/conversation-overview` | 单会话范围的概览证据和 source coverage | Read | `LocalQueryApiService.overview` | 否 | 是 | 高：broad summary |

路由来源：[http-server.ts](../../src/main/http-server.ts#L212)、scheduled/query/media route factory（同文件 L404-L670）。总数是代码中声明的业务方法模板，不代表静态 handler 都正确拒绝其他动词：`/health`、`/current_time`、`/contact`、`/chatroom`、`/recent_chat`、`/chatlog`、`/group_snapshot`、`/resolve`、`/agent/status` 没有检查 `req.method`。这些路径携带错误动词仍会走同一 handler；特别是 `POST /health` 也绕过 Token 检查，因为鉴权例外按 pathname 判断。新/旧路由都应 fail closed 并对不支持的方法返回 405。

全局 `OPTIONS` 在路由和鉴权前处理；媒体额外支持 HEAD。非 health 路径要求 `Authorization: Bearer …`，但 `readBody` 没有大小上限。路由外层目前没有统一请求 schema、统一错误 envelope 或 request id。

## 3. Internal Capability Inventory

这里按产品能力追 Service → IPC/Renderer → HTTP → 外部 Agent，而不是按当前 API 名字扩展。

| 业务域 | 已有能力及实现 | IPC / Renderer | HTTP 现状 | Agent 结论 |
|---|---|---|---|---|
| Chat / Contact | 联系人、群聊、最近会话、解析、历史消息、群快照、消息周边上下文、媒体定位；`contact-resolution-service` 可精确匹配别名并返回歧义候选 | `db:getContacts`、`db:getGroupSnapshot`、消息查询/around 等，Chat/Contact/档案 UI | 旧 Reader routes + `/query/*` + 图片 `/media/{id}` | 已有 Read API 基础完整。新配置应使用 `m_nsUsrName` 对应的 wxid/roomId 等稳定 ID，不应把昵称当长期键 |
| Query / Knowledge | `messages`、`search`、`message-context`、`conversation-overview`；Knowledge 索引覆盖/新鲜度；Image OCR 可进入 Knowledge 搜索和证据 | `knowledge:search/getStatus/startIndex/cancelIndex`、AI Search UI、`LocalQueryToolExecutor` | 四个 Query 操作均已 HTTP 化；`query/capabilities` 只描述 Query Tool | 没有需要重做的基础 Query primitive。缺的是统一应用 capability/status、更多外层筛选和 API Center 展示 |
| Group Analytics | 活跃/沉默当前成员、每人 messageCount/lastMessageTime、窗口时间、memberCount、unattributed/system 消息、firstMessageTime、freshness/complete/limitations；索引未新鲜时最多等待 2 秒并如实降级 | `group-stats:getMemberStats`；聊天页群统计 UI | 无 | P1 候选。当前 query 要求群 `userMd5` + epoch 毫秒。former sender 只以限制文案给出数量，没有 formerMembers 数组/结构化计数；没有覆盖 former sender 的群总消息数字段，需扩 DTO 后再承诺 |
| Group Exit Monitor | enabled/running/nativeMonitor 状态、监控 roomId 集合、lastChecked、unread、事件历史；每次回传最多 500 条，但完整事件历史 append-only 长期保存；可立即 check、改范围、启停、筛事件、清历史、mark read | `group-exit-monitor:*`；`GroupExitMonitorWorkspace` | 无 | P0。拆成 monitor state/config、events、check。`checkNow` 可能发现事件并触发自动通知，不是纯读操作；重启监控会重建快照基线，暂停期成员变化不会补报 |
| Automation | 实际规则类型：`daily_report`、`scheduled_report`、`leave_notification`。`daily_report` 是现有消息触发条件/动作链，不是任意流程引擎；退群通知为固定 ID singleton。规则 CRUD、enable、执行记录读写均已有 Service/Store | `automation:*`；AutomationWorkspace 有规则、日志、定时执行、启停、删除和状态 UI | 没有通用 Automation API；仅 scheduled-report 兼容映射 | P0。使用 typed rule union；不要把内部任意 draft 原样开放。规则创建当前缺省 enabled=true，未知值会被归一化成默认；需 HTTP 严格校验，先 disabled + validate，再显式 enable |
| WeChat Send / Action | `WechatSendGateway` 有 personal/iLink transport resolution、text/image/voice/file 统一类型及 Send Log；`WechatActionGateway` 做 capability preflight、Automation purpose allowlist、Action audit、幂等和 Automation 3 秒间隔 | `wechat-personal:send`、`sendGeneratedTtsVoice`、`wechat-action-log:list`、Agent Hub connector 相关 IPC/UI | `/agent/send` 只走 Agent Hub/iLink 测试发送；个人 capability 有独立 GET；两类日志没有 HTTP | 分 transport 公布 capability；R2 send 通过经审计的业务门面，不直接暴露底层 gateway。现有 Action Gateway 还不是普适安全策略：`triggerType=user` 不按 purpose 限制；普通 `/agent/send` 没传 idempotency key，也没有 Action audit |
| Agent Hub | status、connector login/reconnect/disconnect、notification recipient/send、logs、conversation list/detail/clear、入站 inbox retry | `agent-hub:*`；Agent Hub UI | 仅 `/agent/status` 和 `/agent/send`；无 conversation/log HTTP | status 有只读价值。对话记录包含完整收发正文；inbox 包含 context token/raw items。Connector 生命周期、登录 QR/验证码、收件箱和通知 recipient 应保持 internal |
| Reports / Templates | 手动 report render/export；AI group report；本地 Report History list/save/update template/delete；内置/已安装模板和市场 catalog/install/uninstall | `report:*`、`report-template:*`、`report-template-market:*`；Reports 与 Template Market UI | `/report` 低层 export，`/agent/group-report` AI 生成；没有 history/template API | P1：只读 Report History 元数据/资产可分离设计。现有 `listGeneratedReports` 会读取每张 PNG 为 base64，并返回结构快照和本机绝对路径，不可原样直出。模板目录可读列入 P2；安装/卸载涉及网络与本地包写入，不宜第一批开放 |
| Recall Archive | 后台监听撤回变化，最多按会话存归档消息/撤回记录；chat-service 将 archive merge 到历史读结果 | 没有独立 CRUD IPC；设置开关和消息渲染 | 没有独立 archive API；旧 `/chatlog` 可能随底层消息返回 `recalled` 标记；Query DTO 未声明 recalled 字段 | 不开放原始 archive 管理。后续 Query 应明确返回 `recalled`/来源，避免把已撤回归档当普通消息证据 |
| OCR / Image Insight | System OCR 本地识别；image-text-index status/count/start/pause/resume/cancel/clear/repair；Image Insight 读/解密图片并可调用 AI Provider | `system-ocr:*`、`image-text-index:*`、`image:*` IPC；Search/Report UI | OCR 派生文本可通过 `/query/search` 得到；索引管理、单图 AI 分析无 HTTP | 已有搜索能力可用。状态可纳入 capability/status；索引删除、key/decoder 配置、任意图像 AI 分析涉及成本、私密图片和索引破坏，不列第一批 |
| 系统 / 数据 / 其他 | account discovery、DB key 管理、数据库 connect/root 重开、设置写入、cache summary/clear、app update、voice/TTS、export/import、Reader Skill 本地安装信息 | 多组 IPC；Settings、Cache、Export、Update、Voice UI | 无相应 HTTP API | 只读脱敏运行状态可按需求列 P2；DB key/root、通用 settings patch、cache 清理、任意文件路径、更新安装、TTS synthesis 等保持 internal |

### A. Chat / Contact 与 ID 语义

- `/contact`、`/chatroom` 改用 `listContactsAsync`，因为 macOS Session 可能只有原始 wxid/chatroom id，需要 hydrate 显示名；`ScheduledReportApiService` 却使用同步 `listContacts()` 解析群名。稳定 `talker` 可直接解析，但名称输入在需要 hydration 的运行时可能失败/退化。这是可复用 adapter 应统一异步解析的理由。
- ID 现在不是一个口径：旧 Query 的 `scope.conversationId`/`target` 解析为 `Contact.md5`；`group-stats` 传 `userMd5`；监控用 `roomId`（`xxx@chatroom`）；新的 scheduled automation 用 `sourceConversationId`（wxid/roomId）；老 HTTP 路由混用昵称、wxid、md5。保持已有 Reader 契约不动，新 API facade 应统一对外 canonical `conversationId`（底层当前联系人的稳定 username/wxid 或 roomId），并在 main adapter 转为服务所需 md5。名称只做 resolve，不持久化到规则。
- `chatlog` 时间边界是 Unix 秒，Query `absolute` 内部也是秒，而 group stats IPC 是 epoch 毫秒；新 Agent 资源建议用带时区 ISO-8601 输入/输出，并在 facade 单点转换。
- `/query/messages` 有 200 上限，`messageRef` 是 opaque 稳定引用；图片 OCR 文字和 Coverage 分开呈现。`/chatlog` 则支持旧 talker/time 风格但读取结果没有同等结构边界；作为兼容 Reader 保留，不作为新 Agent 配置/分析的默认接口。

### B. Group Exit Monitor 与 Leave Notification

`GroupExitMonitorService` 的真实 IPC 有 `getState`、`setEnabled`、`setGroups`、`checkNow`、`listEvents`、`clearEvents`、`markRead`。事件是群成员差异事实，包含 roomId、member wxid/name、previous/current count、detectedAt；monitor state 中 `events` 只是最近 500 条快照，`totalEventCount` 对应完整内存历史。

`AutomationService.handleGroupExit` 只处理 `BUILTIN_LEAVE_NOTIFICATION_RULE_ID` 对应的 singleton 规则。规则另有 `notifyScope` / `notifyRoomIds` 二次范围、target、template。Agent 配“监控 A/B/C”需改 monitor 范围；配置通知目标/通知哪些被监控群则另改这条 leave notification automation。两者不能合并为 `/monitors/{id}/notify`。

### C. Automation 与 Scheduled Report

`AutomationRuleStore` 的真实方法有 `listRules/getRule/createRule/updateRule/saveLeaveNotificationRule/deleteRule/setRuleEnabled`；`AutomationExecutionLogService` 提供 `list/record/clear/countSince`。执行日志最多留存 200 条，clear 属于破坏性操作。规则在 `{userData}/automation/rules.json` 中 JSON 持久化。

`scheduled-report-service.ts` 的调度来源是 `automationRuleStore.listRules()`，执行交给 `AutomationService.executeScheduledRule()`，execution 从 Automation Log 投影。迁移后的旧 `tasks.json`/`executions.json` 是只读历史存档。旧 HTTP API 通过 `ScheduledReportApiService` 转换旧 DTO；创建、修改、删除、启停最终也是读写 `AutomationRuleStore`。所以正确方案是保留兼容 facade，并建立 Automation canonical API，不要继续增加第二个 scheduled-report store。

旧 facade 的限制：只列/操作可投影为 `target.type === 'wechat_group'`、且目标等于来源群的规则。如今 scheduled automation 支持 source_chat/self/file_transfer/contact，故通过新 UI 创建为文件传输助手或联系人目标的规则，会从旧 `/scheduled-reports` 列表隐藏。旧 API 输入 schema 也不能表示完整 scheduled config（成员名、消息类型、模板、timeout、postfix 等）。

写 API 前还需处理 `AutomationRuleStore` 的归一化和持久化契约：未知 ruleType 会降成 `daily_report`，大部分错误枚举会静默落安全默认；缺省 enabled 是 true；`persist()` catch 写盘错误后只记 warning，Store 仍返回创建/更新后的对象。HTTP adapter 必须先 strict validate，且 Store 需要可观察的持久化结果，不能把内存态冒充成功。

### D. Group Analytics 确认项

`GroupStatsService.getMemberStats` 已有可直接复用的核心计算；接口具体有：

- 当前群成员：`memberCount`、`activeMembers`、`silentMembers`、各活跃成员 `messageCount`/`lastMessageTime`；
- 查询窗口：`startTime`、`endTime`（epoch ms）、`firstMessageTime`；
- 数据完整性：`freshness = fresh|stale|unknown`、`complete`、`limitations`；
- 诊断：`unattributedMessages`、`excludedSystemMessages`。

成员名单是当前成员集合；知识库统计的 sender 不在当前集合时被排除，只在 `limitations` 中增加“另有 N 位窗口内发言者已不在当前群成员名单”。Service 不返回其身份/每人消息数，也没有 `totalMessageCount`。若 Agent 需要“前成员榜”或全群消息数，需要先扩展 Service/shared type；不能由 API adapter 从 limitation 文案反解析。

## 4. API / Docs / API Center Drift

| 项目 | 代码事实 | 漂移/影响 |
|---|---|---|
| HTTP、共享定义与界面列表 | HTTP 有 30 个 method/path 模板；`LOCAL_API_ENDPOINTS` 定义 14 项，Renderer `API_ENDPOINTS` 实际展示 12 项 | 16 个 HTTP 操作模板没有共享定义；另有 2 个已定义项（个人微信能力、定时日报列表）没有展示。界面仅呈现 12/30 项，不能作为完整 API catalog |
| Scheduled Report 展示 | 共享定义只有 `GET /scheduled-reports`；该项本身也未进入 Renderer 列表 | POST 和 task action 不显示，GET 列表也不显示；Agent 在 API Center 里无法发现这组 API |
| WeChat Capability 展示 | 共享定义有 `GET /wechat-personal/send-capability`；Renderer 列表未包含它 | API Center 看不到个人微信发送能力状态，用户可能误把 Agent Hub 状态当成完整发送能力 |
| Query 展示 | Query 文档在 `api.md` 的独立 LLM-friendly 章节，Service/HTTP 实现完整 | API Center 看不到；用户可能误认为 Reader API 仍只有旧 chatlog |
| Media 方法 | `/media/{mediaId}` 支持 GET、HEAD | 文档仅列 GET；API Center 都未列 |
| Retry Send | 文档表称 retry-send“复用已有 PNG 重试发送” | `ScheduledReportApiService.retrySend()` 当前无条件抛 `501 not_supported`；integration/unit tests 也未覆盖 retry 路由的这项现状 |
| Scheduled Report 完整性 | 旧 facade 只 project `source_chat` | UI 可保存的其他 scheduled target 会从旧 API list/get 隐藏；不是两份存储，但旧 API 不是 Automation API 的完整别名 |
| Health 版本 | `/health` 固定返回 `version: "1.0.0"` | 与当前 package version `2.5.0` 不同，Agent 无法据此判断应用版本 |
| HTTP 动词 | 九个静态 GET 语义路由无 method guard | POST/PATCH/DELETE 等也可能调用读取逻辑；`/health` 任意 method 均免 Token。测试目前未锁定统一 405 契约 |
| 请求/错误 schema | JSON parsing 和错误形状分散：通用 `sendError`、ScheduledReport 专用 error、Query status body、业务自身 result | Agent 要写多套解析逻辑；共享 API schema 和统一错误 code 不存在 |
| 命名 | `/contact`、`/chatroom`、`/recent_chat`、`/group_snapshot` 与 `/scheduled-reports`、`/query/*`、`/agent/*`、`/wechat-personal/*` 并存 | snake_case 旧路径、资源路径和“Agent 为业务 owner”的命名混杂；新接口不能继续沿用此漂移 |

文档 [api.md](../agent/api.md#L35) 基本列出当前 HTTP 路径，Query 在后续单独说明；除 HEAD 外没有发现漏写的当前业务路径，但 retry-send 的成功语义过期。API Center 的来源是单独的 [local-api-test.ts](../../src/shared/local-api-test.ts) 和 [apiEndpoints.ts](../../src/renderer/src/features/api-center/model/apiEndpoints.ts)，没有从 HTTP route/schema 派生。测试现有 `local-api-auth` 覆盖鉴权、媒体、部分 Query 和 Agent send；`scheduled-report-api` 覆盖旧生命周期；`local-api-contact-search` 覆盖 hydrate。它们没有自动比对 HTTP route、文档、Catalog 三者，也没有覆盖全部 method guard 和 retry-send。

## 5. Candidate API Matrix

风险按本任务口径：R0 只读；R1 本地配置/应用状态修改；R2 微信发送、AI/provider 调用等外部副作用；R3 删除或清空不可轻易恢复的数据。R1 不代表没有后续行为：enable 一条定时规则会武装未来的 R2 执行。

| Capability | 当前实现 | 当前 API | 建议 | Agent 用例 | Risk | Priority |
|---|---|---|---|---|---|---|
| 联系人/群/会话 resolve | Chat Service + Contact Resolution | 有旧 routes；Query 内 resolve | 保留旧路由；新 resource 返回稳定 ID、歧义候选 | 查找群并取得 roomId | R0 | P0（复用） |
| 结构化消息/搜索/上下文/概览 | LocalQueryApiService + Knowledge | `/query/*` | 保持契约；加 route schema/catalog，后续可升级稳定 ID | 查聊天、关键词/OCR、补上下文 | R0 | P0（复用） |
| 应用 capability discovery | 各 Service 能回答局部状态 | 无；`query/capabilities` 仅 Query Tools | 新 `GET /capabilities`，区分 supported/available/reason/operations | 发现自动化、监控、统计、发送 transport | R0 | P0 |
| Group Exit Monitor 状态/范围 | GroupExitMonitorService | 仅 IPC | GET state + PATCH enabled/roomIds | 查看监控、监控/停止一个群 | R0/R1 | P0 |
| Group Exit events | Monitor JSONL + listEvents | 仅 IPC | GET 带 stable roomId/time/cursor/limit | 最近 7 天谁退群 | R0 | P0 |
| 手动检查退群 | checkNow 会扫描并触发事件 handler | 仅 IPC | 有外部通知时按 R2 操作开放，先 validate effects + confirm | 立即检查一次 | R2 | P1 |
| Automation 规则 CRUD | AutomationRuleStore | 通用 IPC；HTTP 仅旧 scheduled facade | typed union CRUD；create disabled；validate 再 enable；保护 singleton/system rules | 创建、列出、修改、暂停自动化 | R1/R3(delete) | P0 |
| Automation validation/dry-run | 现有编辑器 preview 分散；无通用 validator API | 无 | `POST /automations/validate`；不落盘、不发送 | 确认群、目标、模板、下次运行和能力 | R0 | P0 |
| Automation execution history | AutomationExecutionLogService，最多 200 条 | schedule 专属旧投影 | 规范化 Automation execution 读接口；清日志不开放第一批 | 查看失败、按 rule 过滤 | R0/R3(clear) | P0 |
| Group member stats | GroupStatsService | 仅 IPC | 按稳定 group ID + ISO window 读统计；先补 former/total 语义 | 近 30 天活跃榜 | R0 | P1 |
| WeChat capability | personal capability service；Agent Hub status | personal GET + Agent status | 新全局 capability 含 personal/iLink 和内容能力；旧路由保留 | 检查发送当前是否可用 | R0 | P0 |
| 手动微信发送 | WechatSendGateway + Action Gateway | `/agent/send` iLink test send | 新 send command 经受限 Action facade，强制 stable recipient、confirm、idempotency | 文件助手测试消息 | R2 | P1 |
| Send Log / Action audit | Send Log 500 条；Action audit 500 条；IPC action-log | 无 HTTP | 分层只读分页，preview 脱敏；按 executionId/requestId 关联 | 查最近发送失败、审计规则动作 | R0 | P1 |
| Agent Hub status | AgentHubService.getStatus | `/agent/status` + IPC | 保留 alias，新资源名归 `/agent-hub/status`，与 app capabilities 分开 | 查 Hub/connector online | R0 | P1（复用） |
| Agent Hub 对话内容 | Conversation Store，最多 50 会话×500 条 | 仅 IPC | 默认为 Internal；若产品确认需要，另做显式 opt-in、分页/时间过滤 | 查看机器人与某人的对话 | R0（高隐私） | 不建议第一批 |
| AI 群日报 | AgentGroupReportService + export | `/agent/group-report` | 保留兼容；未来先 validate model/range/group/data egress，再异步 job | 生成临时总结图片 | R2（provider/本地文件） | P1 |
| 日报历史 | ReportHistory Service，IPC CRUD | 无 | 分页 metadata DTO；图片 asset 单独下载；不返回 base64/路径/完整 snapshot | 昨天生成过哪些日报 | R0 | P1 |
| 模板列表 | Template Service + market catalog | 仅 IPC | 仅已安装模板只读列表列 P2 | 有哪些日报模板 | R0 | P2 |
| 模板安装/删除/历史改版 | Template Service/Market + Report History | 仅 IPC | 不开放通用 HTML/路径写入；将来单独授权且保留校验 | 安装或修改模板 | R1/R3 | Maybe/P2 |
| Recall archive 查询 | 内部 archive merge 到历史消息 | 无独立 API | 不单独开放磁盘 Archive；给 Query 增 `recalled` 来源标记 | 找被撤回消息 | R0（敏感/语义风险） | P2 |
| Image OCR index 操作 | image-text-index service | IPC（含 clear/repair） | coverage 状态可汇入 capabilities/status；不让 Agent 操作 clear/reset | 查 OCR 覆盖 | R0/R1/R3 | P2 |
| AI image insight | ImageInsightService 读/解密图片并调 vision provider | IPC | 不暴露任意 hash/message AI 分析，除非有成本/隐私授权 | 理解群图片 | R2 | 不建议第一批 |
| DB key、根目录、settings、cache | 多个设置/DB/cache Service | IPC/UI | 禁止通用 settings patch / 文件路径 / DB key API；只加白名单状态字段 | 修改本机数据库、安全设置 | R1/R3 | 不建议开放 |
| Connector 生命周期/inbox | AgentHubService + WechatInboundInbox | 仅 IPC/内部 | connector 登录、验证码、QR、inbox、context token 不对 Agent 暴露 | 重连或直接拿入站 token | R1/R2 | 不建议开放 |

## 6. P0 Recommendation

第一批目标是“让 Agent 能配置和核验 TraceMemo，但不意外发消息”。建议只包括：

1. `GET /api/v1/capabilities`：应用级 capability，不与现有 `/query/capabilities` 合并。返回版本、DB/readiness、supported vs available、不可用原因和依赖；发送分 personal/iLink 与 text/image/voice 能力。
2. Group Exit Monitor：读取状态、显式配置 monitored roomIds、读取历史事件。`PATCH` 只接 canonical 群 ID，拒绝不存在/非群 ID；修改范围响应明确显示后台 baseline/check 状态。`check` 先列 P1，因为它可能启动退群通知发送。
3. Automation typed CRUD：列/读规则、创建 disabled 规则、更新、显式启停、执行历史读取。Leave Notification 仍使用固定 singleton id，不允许创建重复规则；拒绝未知字段/未知 enum，而不是靠 `normalizeRuleDraft` 静默修正。
4. `POST /automations/validate`：验证目标群、稳定通知 recipient、模板变量、report/template 配置、send capability 和 nextRunAt；只返回 plan，不落盘、不发送。
5. 运行状态与错误契约：一致的 405、最大 body、请求 ID、错误 envelope；这是任何新 Agent 写接口前的 foundation，不是大规模权限系统。

Agent 实现示例（概念流程）：

- “监控 A/B/C 退群”：resolve 三个群为 roomId → validate scope → PATCH monitor group IDs。
- “A 群有人退出就通知文件助手”：读取 monitor scope 和 singleton leave rule → validate 类型/notify scope/target → 更新规则但保持 disabled → 用户/Agent 明确 enable。监控与 leave-notification 是两份正交配置。
- “每天 20:00 生成产品群日报”：resolve sourceConversationId → validate scheduled rule（包含 target/transport/模板/时区/next run）→ 创建 disabled → 显式 enable。旧 `/scheduled-reports` 无法表达所有当前 config，不承担新 Agent CRUD。
- “昨天哪些自动化失败”：读 automation executions，按本机 timezone/UTC offset 和 status 查询，不清理日志。

## 7. Proposed Resource Model

采用业务 capability 资源，HTTP server 只负责 transport、auth、body、统一错误；每个 domain route 调用独立的 main-process API facade/Service adapter。Facade 复用当前 Service/Store，不把 UI IPC 当 HTTP RPC 转发层。

| Resource | 职责 | 现有路径的处理 |
|---|---|---|
| `system` | health、版本、应用级 capabilities、运行状态 | `/health` 保留；新增 `/capabilities`；`query/capabilities` 不改语义 |
| `contacts` / `groups` | 稳定 ID 列表、resolve、群成员快照/统计 | `/contact`、`/chatroom`、`/resolve`、`/group_snapshot` 保留兼容 |
| `query` | 消息/搜索/上下文/概览证据 | 现有 `/query/*` 保持；query ID 口径升级需兼容 reader skill |
| `monitors` | 退群监控范围、启停、事件、显式 check | 新 `/monitors/group-exits`，与通知规则分离 |
| `automations` | 规则 typed CRUD、validate、启停和运行 | 新 `/automations` 是 canonical HTTP resource；底层仍由 `AutomationRuleStore` 存储 |
| `executions` | 跨 Automation/Action/Send 的只读运行视图 | 新 `/executions` read model，不合并各自写存储 |
| `wechat` | transport capabilities、受控 send command、Send Log/Action audit | `/agent/send` 与 `/wechat-personal/send-capability` 保留兼容 |
| `reports` | report history 元数据/asset；installed templates read-only | `/report` 与 `/agent/group-report` 保留为不同兼容操作 |
| `agent-hub` | Hub/connector 状态；conversation API 默认 internal | `/agent/status` 保留 alias，不复用 app capability |
| `developer` | 高级 raw request tester 与诊断 | API Center 的 tester；不作为 Agent 业务 API |

共享资源原则：新 API 输入以 stable id 为主、名字只用于 resolve；所有写请求 strict validate；时间对新资源用 offset ISO-8601；分页使用 `limit` + `cursor`；成功/失败使用一个 typed envelope；不直接返回 app userData path、token、context token、AES key 或原始 transport payload。

## 8. Safety Model

### 当前边界

- 默认监听 `127.0.0.1:6131`，但 host/port 由设置和 `api:start` 调用传入，API Center 会警告非 loopback。CORS 只允许 loopback Origin，但不带 Origin 的 curl/Agent 请求仍可用 Token；CORS 不是本地进程授权边界。
- `/health` 公开，其余 endpoint 共用单一 Bearer Token。Token 为 32 random bytes、safeStorage 加密存储并设 `0600`，没有 read/config/send scope。拿到 token 即可读取聊天，也能建/删/启停规则、立即发送。
- HTTP `/agent/send` 的消息进入 `WechatSendGateway`，因此有低层 Send Log；但没有 `WechatActionGateway` 的业务 Action audit/策略决策，也没有调用方 Idempotency-Key。Personal capability 路由只报告个人微信状态。
- `WechatActionGateway` 的请求包含 `purpose`、`triggerType`、recipient、content、`idempotencyKey`、`executionId`；Automation trigger 有 purpose allowlist，sender capability 会先检查，审计记录会保存 content preview/hash。当前 `evaluateWechatActionPolicy` 对 `triggerType=user` 不做 purpose allowlist，`shouldUseAiPolicy` 固定 false；幂等只对显式 key 或历史特定 scheduled request 生效。它目前只发个人微信，不能直接替换 iLink send。
- Action Audit 和 Send Log 各自上限 500；Automation Execution Log 上限 200。三类日志粒度不同，不是重复的同一事实。

### 分级建议

| 风险 | 操作 | 建议控制 |
|---|---|---|
| R0 | 查询聊天/成员/事件/状态/统计/日志/报告元数据 | 保留本地 Token；响应明确 scope、coverage、freshness、隐私字段 |
| R1 | 修改监控群、Automation 配置、启停、模板设置 | typed validation、dry-run plan、显示持久化成功；enable 需确认它武装未来发送 |
| R2 | 微信发送、立即执行日报/退群通知 check、调用 AI Provider 生成报告 | 明确 recipient 和内容/规则；`Idempotency-Key` 必填；统一 Action policy + Action audit + Send Log；重复请求回放原结果；返回发送状态 |
| R3 | 清理退群事件、删除 report、清空执行/发送/Action 日志、清 cache/index、删规则 | 初始不开放；如以后开放，独立权限、预览计数、可恢复备份/本地确认，不接受批量 wildcard |

现有 Bearer Token 不足以支撑“查询、配置、发送、清理”都对一个不受信 Agent 开放。近期不必造完整账户系统，但应先修路由 method/body/validation，提供默认只读或 disabled 配置工作流；后续可加入多个 named token + scope（`read`, `configure`, `send`, `destructive`），R2 请求确认和 durable idempotency。风险分类也需承认本地 artifact write（如 `/report` 导出）不是配置本身，可先按 R1 local-write 处理。

## 9. Compatibility Plan

1. 不 rename/remove 任何现有 route。Reader Skill 依赖旧 contacts/chatlog/media 路径；新 structured query 已经是更合适的 Agent query，但两者并行。
2. 新 `/automations` 读写同一 `AutomationRuleStore`。旧 `/scheduled-reports*` 改为明确标注 Deprecated 的 compatibility adapter；维持现有 request/response shape 和 source_chat 子集，不维护第二个任务存储。响应可加 `Deprecation` header/文档说明，未定 sunset 前不返回 breaking error。
3. `/scheduled-reports` 的投影不能假装覆盖所有 scheduled automation。旧 list/get 只反映 source_chat；新 clients 必须迁到 `/automations?type=scheduled_report`。旧 `retry-send` 保留返回 501，文档明确废弃；不能伪造已发送成功。
4. `/agent/send` 继续表示现有 iLink/Agent Hub 测试发送。新 `/wechat/send` 必须先明确 transport/recipient schema，再通过能统一 personal+iLink 的受控 Action facade；如果不能保留旧发送语义，就将旧路径作为 adapter 而不是简单 alias。
5. `/wechat-personal/send-capability` 保持 personal-only 兼容 view；新全局 capability 返回 transport map。应用能力 `/capabilities` 和 Query Tool 的 `/query/capabilities` 各自有清晰不同的契约。
6. 同一 shared contract/catalog 应供 HTTP 验证、API Center、文档和 route contract tests 使用；把实际路由、文档和 API Center 三者 drift 变成测试失败，而不是发布后人工发现。

## 10. Proposed Phase Plan

### Phase A — HTTP Contract / Facade

给现有 routes 加明确 method guard、body size limit、严格 shared request schema、统一错误 envelope/request id；补 `AutomationRuleStore` 写盘成功/失败结果；建立稳定 conversation ID adapter 和 route contract tests。保留 raw Node HTTP，不需要为第一阶段换 web framework。

### Phase B — Read + Validation P0

增加应用 `/capabilities`、monitor state/events、automation rules/executions 读取、`/automations/validate`、group stats adapter。monitor `check` 因可能触发 notification 暂留 P1 或先加 side-effect confirmation。把新资源路径、schema、风险元数据接进 EndpointCatalog/生成文档。

### Phase C — Automation Configuration

开放 disabled create、PATCH、启停和 DELETE 防护；退群通知专用 singleton upsert 接入同一规则资源；scheduled report 使用真实完整 config；旧 scheduled API 只做 compatibility projection。先做 dry-run 再允许 enable。

### Phase D — Side Effects / Execution Read Model

扩展一层统一 `Action` facade 支持 iLink + personal transports，并有 per-purpose policy、recipient allowlist/validation、确认语义、强幂等、Action audit 到 Send Log correlation。再开放 send/check/run；按需增加 `/executions` read projection，不合并底层日志存储。

### Phase E — API Center

Overview、Query、Monitors、Automations、WeChat Actions、Reports、Developer 分区；按业务任务做 schema-aware 表单/效果预览，Raw Request Tester 留在 Developer。展示 Token scope/host 范围/transport capability，而不只是固定 URL 测试器。

## 11. Concrete Endpoint Proposal

下表是下一阶段建议契约，不表示当前已实现。新写 API 应统一错误：`{"error":{"code":"...","message":"...","details":{...}},"requestId":"..."}`。时间使用带 offset 的 ISO-8601；接口只接受 stable IDs。

| Method | Path | Request → Response | Risk | Underlying Service |
|---|---|---|---|---|
| GET | `/api/v1/capabilities` | 无 → app version/readiness + `query`,`groups.memberStats`,`groupExitMonitor`,`automations`、每种 `wechat.transport/content` 的 `supported/available/reason` | R0 | 新薄 facade 汇总 LocalQuery、GroupStats、Monitor、AutomationStore、personal capability、AgentHub status |
| GET | `/api/v1/monitors/group-exits` | 无 → `{enabled,running,monitoredConversationIds,lastCheckedAt,eventCount}` | R0 | `GroupExitMonitorService.getState` |
| PATCH | `/api/v1/monitors/group-exits` | `{enabled?,monitoredConversationIds?}` → 保存后的 state；监控 ID 必须 resolve 到现有群 | R1 | `setEnabled` / `setMonitoredRoomIds` |
| GET | `/api/v1/monitors/group-exits/events?conversationId=&since=&until=&limit=&cursor=` | ISO 时间和稳定群 ID → `{events,nextCursor}`，事件显式 `eventId`、group/member、counts、detectedAt | R0 | `GroupExitMonitorService.listEvents`；为无 cursor 的现有 list 加稳定分页 adapter |
| POST | `/api/v1/monitors/group-exits/check` | `{confirmSideEffects:true}` + `Idempotency-Key` → checkedAt、新事件数、notification execution refs | R2 | `checkNow`；因检查可发现事件并调用 leave-notification Automation，不应标成纯读 |
| GET | `/api/v1/automations?type=&enabled=` | 无 → typed rules page；包括 singleton leave rule | R0 | `AutomationRuleStore.listRules` |
| POST | `/api/v1/automations` | typed `AutomationRuleDraft`，create 默认 `enabled:false` → `{rule}` | R1 | `AutomationRuleStore.createRule`（需先强化 strict validation/persist result） |
| GET | `/api/v1/automations/{ruleId}` | 无 → `{rule}` | R0 | `AutomationRuleStore.getRule` |
| PATCH | `/api/v1/automations/{ruleId}` | typed partial config → `{rule}`；`ruleType` 不可变 | R1 | `AutomationRuleStore.updateRule` |
| DELETE | `/api/v1/automations/{ruleId}` | 无 → `{deletedId}`；默认拒绝 builtin/system singleton 删除 | R3 | `AutomationRuleStore.deleteRule` + protected-id policy |
| POST | `/api/v1/automations/validate` | typed draft → `{valid,normalizedDraft,issues,effects,resolvedTargets,nextRunAt,capabilities,validationId}`；不保存、不发送 | R0 | 新 validator adapter：contact resolve、template validator、capability services、schedule pure functions |
| POST | `/api/v1/automations/{ruleId}/enable` | `{validationId,confirmFutureEffects:true}` → `{rule}`；validation hash 必须匹配当前规则 | R1（武装未来 R2） | `AutomationRuleStore.setRuleEnabled` + validator |
| POST | `/api/v1/automations/{ruleId}/disable` | 无 → `{rule}` | R1 | `AutomationRuleStore.setRuleEnabled` |
| POST | `/api/v1/automations/{ruleId}/run` | `{confirmSideEffects:true}` + `Idempotency-Key` → `{execution}` | R2 | `AutomationService.executeScheduledRule`；只对具有 `run` 语义的 rule type 开放 |
| GET | `/api/v1/automations/executions?ruleId=&status=&trigger=&since=&until=&limit=&cursor=` | 无 → `{executions,nextCursor}` | R0 | `AutomationExecutionLogService.list`；需加 timestamp/filter/cursor adapter |
| GET | `/api/v1/groups/{conversationId}/member-stats?start=&end=` | ISO 时间窗口 → active/silent/counts/freshness/complete/limitations；未来要 former members 则先扩 shared result | R0 | `GroupStatsService.getMemberStats`；adapter 把 canonical roomId 转 md5 |
| GET | `/api/v1/wechat/capabilities` | 无 → personal/iLink 分 transport 状态与内容能力 | R0 | `PersonalWechatCapabilityService` + `WechatSendGateway.hasIlinkSender`/Agent Hub connector health |
| POST | `/api/v1/wechat/send` | `{recipient:{type,id},content:{type:"text",text},confirm:true}` + 必填 `Idempotency-Key` → `{actionId,status,transport,sendLogRef}` | R2 | 扩展后的 `WechatActionGateway`/统一 Action facade；不得裸调 `WechatSendGateway.send` |
| GET | `/api/v1/wechat/send-logs?status=&since=&limit=&cursor=` | 无 → 只读、脱敏 Send Log page | R0 | `WechatSendGateway.listSendLog` / `WechatSendLogService.list` |
| GET | `/api/v1/wechat/action-logs?executionId=&status=&since=&limit=&cursor=` | 无 → 业务 Action 审计 page；preview 默认截短/可省略 | R0 | `WechatActionLogService.list` / `WechatActionGateway.listAuditRecords` |
| GET | `/api/v1/executions?source=&status=&since=&until=&limit=&cursor=` | 无 → 统一只读 projection，每项保留 source/executionId/trigger/action/status/error/times/correlation IDs | R0 | 组合 `AutomationExecutionLogService`、Action audit、Send Log；不合并其存储 |
| GET | `/api/v1/reports/history?groupId=&since=&until=&limit=&cursor=` | 无 → 仅元数据分页，不带 `generatedImage`、本地绝对路径或完整 report snapshot | R0 | `listGeneratedReports` 经 summary adapter，最好先让 Service 支持 metadata-only |
| GET | `/api/v1/reports/history/{reportId}/image` | 无 → PNG binary | R0 | Report History 的 file resolver；仅按内部 report id 解析，不接收任意路径 |
| GET | `/api/v1/report-templates` | 无 → 已安装模板的 stable id/name/version/available 列表 | R0 | `reportTemplateService.list` |
| GET | `/api/v1/agent-hub/status` | 无 → hub/connector/dataApi/dbReady 的脱敏状态 | R0 | `AgentHubService.getStatus`；`/api/v1/agent/status` 保留 alias |

`POST /wechat/send` 建议先只开放 text + 明确目标；image path/url、voice 和 file 类型各自扩大本机文件/外传风险，需独立 validation/permission，不从现有任意 `msg` 输入自动继承。

## 12. Do Not Expose

- 任意数据库 key、图片 AES key、微信登录凭据、iLink `context_token`/bot token、inbound inbox raw items；这些是密钥或未处理消息，不是业务 API。
- 通用 `settings:set`、任意 `dbRoot`、数据库 disconnect/reopen、cache 全清、Knowledge/OCR 索引 clear/reset；配置或 destructive blast radius 远高于 Agent automation 管理需求。
- Agent Hub QR/login/verify-code/reconnect/disconnect/connector lifecycle。它会影响进程状态/账户登录，也会暴露登录材料。
- `WechatInboundInbox` pending/clear/complete/recordFailure 等队列控制。它是 at-least-once 消息交付内部机制，外部 ack 会破坏不丢消息语义。
- Agent Hub 完整对话正文默认不暴露。若明确产品需要，独立设计用户授权、最小时间窗口、分页、清理和脱敏；现有 Conversation Store 为本机完整收发留档。
- 任意本地 file path、path traversal 类导出/报告资产操作；不要把 IPC 的 file chooser、reveal、delete path 形状直接变 HTTP 参数。
- 单图 AI insight/任意 Vision analyze、批量 TTS synthesis、AI Provider 配置/测试和 app update download/install；它们具有费用、敏感图片/文本上传或应用安装影响。
- 清除退群、Automation、发送/Action、报告历史或批量发送接口作为 P0。清理类不是“管理配置”的必要前提，应使用 R3 独立权限及本地可恢复流程。
- 通用“任意 Automation DAG/任意脚本/任意 purpose”的创建。当前实现只有明确的三类规则和固定动作，不是 workflow engine；扩展功能应有显式 ruleType/schema，而不是暴露内存对象。

## 13. Open Questions

以下属于产品边界选择，无法只从代码决定：

1. 新 Agent API 是否允许同时操作个人微信和 Agent Hub/iLink，还是第一版限定一个 transport？现有 capability 与 send endpoint 分属两套连接状态。
2. Agent 是否默认只拿只读 scope；配置和 R2 send 是否要求独立 token/用户确认？当前只有单一 Bearer Token。
3. 多账号是否属于本阶段？当前 Query/GroupExit 绑定当前活动数据库账号，Agent Hub 有自己的 connector accountId；没有统一 account-scoped API model。
4. Agent Hub 完整对话是否要作为 API capability？它含完整消息正文，和从微信数据库按 query 搜历史是不同隐私边界。

真实微信 runtime 可用性、平台 hydration 和 transport 能力需在后续实现集成测试中验证；静态代码审计无法替代真实数据库/微信连接的运行时验证。
