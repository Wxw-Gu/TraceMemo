/**
 * Automation v1 的跨层契约。
 *
 * 设计原则：**只包含当前真正需要的字段**。
 * 第一版不做：regex、IF/ELSE 嵌套、可视化编排、Webhook、通用 AI 机器人。
 */

import { normalizeGroupExitNotificationTemplate } from './group-exit-monitor'

/** 触发事件类型。第一版只支持「收到消息」。 */
export type AutomationTriggerType = 'message'

/**
 * 关键词匹配方式。
 *
 * **刻意不做 regex** —— regex 会立刻把「规则配置」变成需要调试的编程界面，
 * 而且用户写错正则时既没有报错也没有预览。三种字面匹配覆盖绝大多数场景。
 */
export type KeywordMatchMode = 'contains' | 'exact' | 'prefix'

/** 消息来源过滤。 */
export type AutomationMessageScope = 'group' | 'direct' | 'all'

/**
 * 规则类型。
 *
 * 决定**这条规则由什么驱动、有哪些字段有意义**：
 * - `daily_report`：消息驱动，条件 + 动作链（@我生成日报）；
 * - `leave_notification`：退群事件驱动，通知目标 + 模板（退群通知）。
 *
 * ⚠️ 这是一条**硬分派**：`matchAutomationRule` 会直接拒绝非 `daily_report` 的规则，
 * 否则一条 keyword 为空的退群通知会命中**每一条群消息**。
 */
export type AutomationRuleType = 'daily_report' | 'leave_notification'

/** 规则类型的界面标签（Tab 与首页卡片共用一处文案）。 */
export const AUTOMATION_RULE_TYPE_LABELS: Record<AutomationRuleType, string> = {
  daily_report: '@我生成日报',
  leave_notification: '退群通知'
}

/** 退群通知发到哪里。刻意只有这四种。 */
export type LeaveNotificationTargetType = 'source_chat' | 'self' | 'file_transfer' | 'contact'

export interface LeaveNotificationTarget {
  type: LeaveNotificationTargetType
  /**
   * `contact` 时必填。
   *
   * **稳定 id（wxid）**，不是显示昵称 —— 昵称会改，改完就发错人。
   */
  contactId?: string
}

export interface LeaveNotificationConfig {
  target: LeaveNotificationTarget
  template: string
  /**
   * 迁移时旧配置**无法无损映射**的标记（旧「通知群聊」是 per-group 多值，
   * 新目标是单值）。为 true 时：规则不执行发送，UI 提示用户重选目标。
   *
   * 只有迁移会把它置为 true，用户手动保存一次即清除。
   */
  targetNeedsReview?: boolean
}

export interface AutomationConditions {
  /** 必须**真正** @我（走 source → atuserlist，不是正文里的 @昵称）。 */
  requireMentionMe: boolean
  keyword: string
  keywordMatchMode: KeywordMatchMode
  /** 生效的会话（群 md5）。为空表示「不限会话」。 */
  conversationIds: string[]
  /** 忽略自己发送的消息。默认 true —— 这是防死循环的第一道闸。 */
  ignoreSelf: boolean
}

/** 执行动作类型。顺序由 `actions` 数组顺序决定。 */
export type AutomationActionType = 'replyText' | 'generateReport' | 'sendReportImage'

export interface AutomationAction {
  type: AutomationActionType
  enabled: boolean
  /** `replyText` 的文案。 */
  text?: string
}

export interface AutomationRule {
  id: string
  name: string
  enabled: boolean
  /** 规则类型。缺省视为 `daily_report`（历史 rules.json 没有这个字段）。 */
  ruleType: AutomationRuleType
  trigger: AutomationTriggerType
  scope: AutomationMessageScope
  conditions: AutomationConditions
  actions: AutomationAction[]
  /** 同一规则在同一会话内的最小触发间隔（秒）。防刷屏。 */
  cooldownSeconds: number
  /**
   * 命中后**等多久再发「回复确认」**（秒）。0 = 立刻回复。
   *
   * 与 `cooldownSeconds` 同口径（秒）：界面上是秒、落盘也是秒，
   * 只有 `AutomationActionRunner` 在等待前换算成毫秒。别在这里存毫秒，
   * 否则「触发间隔」和「回复等待」两个字段一个秒一个毫秒，迟早有人读错。
   *
   * **旧版 rules.json 里没有这个字段**：读取方一律按
   * `normalizeReplyDelaySeconds()` 处理 ⇒ 缺省即默认 2 秒，不是「不等待」。
   */
  replyDelaySeconds: number
  /** `ruleType === 'leave_notification'` 时必填。 */
  leaveNotification?: LeaveNotificationConfig
  createdAt: number
  updatedAt: number
}

/** 执行步骤状态。`skipped` 用于「上一步失败所以这一步不做」。 */
export type AutomationStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

/**
 * 执行步骤键。
 *
 * 分两族，**不共用**：
 * - 消息型（`daily_report`）：received / matched / reply / report / send
 * - 退群型（`leave_notification`）：exit_received / exit_matched / exit_target / exit_send
 *
 * 不共用的理由：给退群通知渲染一个「回复确认 已跳过」的步骤是纯噪声，
 * 用户会以为规则配错了。
 */
export type AutomationStepKey =
  | 'received'
  | 'matched'
  | 'reply'
  | 'report'
  | 'send'
  | 'exit_received'
  | 'exit_matched'
  | 'exit_target'
  | 'exit_send'

export interface AutomationStep {
  key: AutomationStepKey
  /** 用户可读的步骤名（中文）。 */
  label: string
  status: AutomationStepStatus
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  /**
   * 用户可读的**细节**（例如已解析的通知目标显示名「文件传输助手」）。
   *
   * ⚠️ 展示层契约：只允许放用户能理解的名称。
   * **禁止** wxid / chatroom id / localId / serverId / 文件路径 / 原始 payload。
   */
  detail?: string
  /** 用户可读的错误信息。**禁止**含 wxid / 文件路径 / 原始 payload。 */
  error?: string
  /**
   * 被跳过时的原因（给用户看的一句话）。
   *
   * 与 `error` 分开：`skipped` 不是错误，硬塞进 `error` 会让界面把它当失败渲染。
   * **禁止**含 localId / serverId / dedup key 这类工程术语。
   */
  skipReason?: string
}

/**
 * 一次 execution 的最终状态。
 *
 * **规则（不要改口径）**
 *
 * | 情况 | status |
 * | --- | --- |
 * | 所有**启用的必需 action** 成功 | `success` |
 * | 某个必需 action `failed` | `failed` |
 * | 后续 action 因前置失败未执行（step 记 `skipped`） | `failed`（整个规则没跑完整） |
 * | 规则本来就没启用某个 action | 该 step `skipped`，**不影响**整体结果 |
 * | 消息**没有命中**规则 | **不创建 execution** |
 * | 落在 rule conversation gate 的阻塞窗口内 | **不创建 execution** |
 *
 * ⚠️ **阻塞窗口内的消息不留任何痕迹**：不匹配、不执行、不回复、**不写 execution**。
 * 从用户产品视角，那段时间这条规则就是「没处理这些消息」—— 不是「跳过」。
 * 门语义见 `automation-service.ts` 的 `ConversationRuleGate`。
 *
 * ⇒ 所以 execution 级**没有** `skipped`：一次 execution 只要被创建出来，就说明它真的跑过，
 * 结果非成功即失败。**步骤级**的 `skipped`（`AutomationStepStatus`）是另一回事，仍然保留 ——
 * 那是「这次执行里某一步没做（没配 / 前置失败）」。
 */
export type AutomationExecutionStatus = 'running' | 'success' | 'failed'

export interface AutomationExecution {
  executionId: string
  ruleId: string
  ruleName: string
  triggerTime: number
  /**
   * 来源的**显示名**（群名 / 联系人昵称）。
   *
   * ⚠️ 展示层契约：**不含** wxid / localId / serverId / source XML / raw payload。
   */
  sourceDisplayName: string
  status: AutomationExecutionStatus
  durationMs: number
  steps: AutomationStep[]
  /** 失败时的一句话摘要。 */
  errorSummary?: string
}

/**
 * 发送用途标识（对应 `WechatActionPurpose`）。
 *
 * 这两个值必须同步登记进 `wechat-action-gateway.ts` 的
 * `AUTOMATION_PURPOSE_ALLOWLIST`，否则会被策略层以 `ACTION_NOT_ALLOWED` 拦下 ——
 * 那是有意的闸门，不是 bug。
 */
export const AUTOMATION_SEND_PURPOSE = {
  /** 触发确认文字回复。 */
  reply: 'automation_reply',
  /** 日报图片。 */
  report: 'automation_report',
  /**
   * 退群通知文字。
   *
   * 刻意**不复用**历史 purpose `member_left_notification`：那一个被 WechatActionGateway
   * 的作用域锁绑死在「只能发回事件所在群」，而现在的目标可以是自己 / 文件传输助手 /
   * 指定好友。用新 purpose 才能真正解除那个锁，同时让旧 purpose 变成无生产者的历史值。
   */
  leaveNotification: 'automation_leave_notification'
} as const

/** 审计日志里的来源标识（`WechatActionOrigin`）。 */
export const AUTOMATION_SEND_ORIGIN = 'automation'

/**
 * 「回复确认」前的默认等待（秒）。
 *
 * 规则一命中就立刻回复，看起来就是个机器人 —— 消息刚到、回复就到了。
 * 这个等待把回复推到一个更像人的时间点上，所以它是**规则自己的一项执行参数**
 * （和 `cooldownSeconds` 同口径：秒），在「编辑自动化 → 3 · 触发后执行」里配。
 *
 * **只作用于「回复确认」这一步**：日报生成 + 图片发送本来就以秒计，
 * 不再叠加等待，否则整条链路会慢得让人以为卡住了。
 */
export const AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS = 2

/** 等待上限。再长用户会以为功能坏了，所以封顶而不是无限放开。 */
export const AUTOMATION_REPLY_DELAY_MAX_SECONDS = 60

/**
 * 把任意输入收敛成合法的等待秒数。
 *
 * 口径（三条都是刻意的）：
 * - **空值 / 非法值 → 默认值**，而不是 0 —— 填错了不该静默变成「不等待」；
 * - **0 是合法值**（显式表示立刻回复），负数与它同归 0；
 * - 超过上限按上限截断，避免有人填 10 分钟。
 */
export function normalizeReplyDelaySeconds(value: unknown): number {
  if (value === null || value === undefined || value === '') {
    return AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(parsed)) return AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS
  if (parsed <= 0) return 0
  return Math.min(AUTOMATION_REPLY_DELAY_MAX_SECONDS, Math.round(parsed))
}

/** 所有自动化行为的 `sourceId` / `executionId` 口径：一次执行一个 id。 */
export function automationIdempotencyKey(
  kind: keyof typeof AUTOMATION_SEND_PURPOSE,
  executionId: string
): string {
  return `${AUTOMATION_SEND_PURPOSE[kind]}:${executionId}`
}

/** 规则编辑页提交的草稿：不含 id / 时间戳，由 main 侧补齐。 */
export interface AutomationRuleDraft {
  name: string
  enabled: boolean
  ruleType: AutomationRuleType
  trigger: AutomationTriggerType
  scope: AutomationMessageScope
  conditions: AutomationConditions
  actions: AutomationAction[]
  cooldownSeconds: number
  /** 命中后等多久再回复确认（秒）。0 = 立刻回复。 */
  replyDelaySeconds: number
  /** `ruleType === 'leave_notification'` 时的通知配置。 */
  leaveNotification?: LeaveNotificationConfig
}

/** 顶部状态条数据（全部来自 main 侧真实能力，UI 不做平台判断）。 */
export interface AutomationStatusSummary {
  /** 消息监听是否在运行。 */
  listening: boolean
  /** 监听是否降级（只能看到最近活跃会话，见 MessageListener BLOCKER）。 */
  listeningDegraded: boolean
  /** 今日执行次数 / 成功次数。 */
  todayExecutions: number
  todaySuccesses: number
  /** 真实发送能力。 */
  sendCapability: {
    supported: boolean
    ready: boolean
    canSendText: boolean
    canSendImage: boolean
    message: string
  }
}

/**
 * 规则列表里的**模板入口**。
 *
 * `available: false` 表示该能力本轮**尚未接通** —— UI 必须显示为「未启用 / 即将支持」，
 * 不允许伪装成可运行。这是防止设计稿倒逼假数据的硬约束。
 */
export interface AutomationRuleTemplate {
  id: string
  name: string
  description: string
  /** 本轮是否已接通的真实能力。 */
  available: boolean
  /** 未接通时的说明文案。 */
  unavailableReason?: string
}

export const AUTOMATION_RULE_TEMPLATES: AutomationRuleTemplate[] = [
  {
    id: 'scheduled-report',
    name: '定时发送日报',
    description: '按固定时间自动生成并发送群日报',
    available: false,
    unavailableReason: ''
  },
  {
    id: 'keyword-reply',
    name: '关键词自动回复',
    description: '消息命中关键词时自动回复指定内容',
    available: false,
    unavailableReason: ''
  }
]

/** 内置规则 id。固定值，便于升级时不重复创建。 */
export const BUILTIN_DAILY_REPORT_RULE_ID = 'builtin-mention-me-daily-report'

/**
 * 内置「退群通知」规则 id。
 *
 * 这是一个 **singleton / system rule**：保存永远按这个 id upsert，
 * 不允许"每打开一次编辑页多一条规则"。
 */
export const BUILTIN_LEAVE_NOTIFICATION_RULE_ID = 'builtin-leave-notification'

/** 退群通知的默认展示名。 */
export const LEAVE_NOTIFICATION_RULE_NAME = '退群通知'

export const AUTOMATION_STEP_LABELS: Record<AutomationStepKey, string> = {
  received: '收到消息',
  matched: '规则匹配',
  reply: '回复确认',
  report: '生成日报',
  send: '发送日报图片',
  exit_received: '检测到成员退出',
  exit_matched: '规则匹配',
  exit_target: '确定通知目标',
  exit_send: '发送退群通知'
}

/**
 * 执行结果的展示文案。
 *
 * `skipped` 是**中性**状态（命中了但被规则自身的冷却 / 去重拦下），
 * 不是失败 —— 界面不能用红色渲染它。
 */
export const AUTOMATION_EXECUTION_STATUS_LABELS: Record<AutomationExecutionStatus, string> = {
  running: '执行中',
  success: '成功',
  failed: '失败'
}

export const KEYWORD_MATCH_MODE_LABELS: Record<KeywordMatchMode, string> = {
  contains: '包含',
  exact: '完全匹配',
  prefix: '以…开头'
}

export const SCOPE_LABELS: Record<AutomationMessageScope, string> = {
  group: '群聊',
  direct: '私聊',
  all: '全部'
}

/**
 * 关键词匹配（纯函数）。
 *
 * 大小写不敏感 + 去首尾空白；空关键词视为「不限制」。
 */
export function matchKeyword(
  content: string | undefined,
  keyword: string,
  mode: KeywordMatchMode
): boolean {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return true
  const haystack = String(content ?? '').toLowerCase()
  if (!haystack) return false
  if (mode === 'exact') return haystack.trim() === needle
  if (mode === 'prefix') return haystack.trim().startsWith(needle)
  return haystack.includes(needle)
}

/**
 * 退群通知的四种发送目标（展示层单一来源）。
 *
 * UI 单选项与首页卡片摘要都从这里取文案，避免同一句话在两个文件里各写一份、慢慢漂移。
 * **顺序即界面顺序**：`当前群聊` 排第一，因为它也是默认值。
 */
export const LEAVE_NOTIFICATION_TARGET_OPTIONS: ReadonlyArray<{
  type: LeaveNotificationTargetType
  label: string
  description: string
}> = [
  {
    type: 'source_chat',
    label: '当前群聊',
    description: '将通知发送到发生成员退出的群聊。'
  },
  {
    type: 'file_transfer',
    label: '文件传输助手',
    description: '将通知发送到文件传输助手。'
  },
  {
    type: 'self',
    label: '发给自己',
    description: '将通知发送到当前登录微信账号自己的会话。'
  },
  {
    type: 'contact',
    label: '指定好友',
    description: '将通知发送给一个指定联系人。'
  }
]

/**
 * 新安装 / 无历史配置时的默认目标。
 *
 * 「当前群聊」= 旧「退群监控」通知的原始行为（通知发回事件所在群），
 * 所以它既是默认值、也排在选项第一位。
 */
export const LEAVE_NOTIFICATION_DEFAULT_TARGET_TYPE: LeaveNotificationTargetType = 'source_chat'

/** 目标类型 → 界面短标签。 */
export function leaveNotificationTargetLabel(type: LeaveNotificationTargetType): string {
  return LEAVE_NOTIFICATION_TARGET_OPTIONS.find((option) => option.type === type)?.label ?? ''
}

/**
 * 「范围」摘要：退群通知覆盖多少个已监控群聊。
 *
 * 数字**必须**来自退群监控（`GroupExitMonitorState`），自动化不维护副本。
 */
export function describeMonitoredScope(monitoredCount: number): string {
  return `${Math.max(0, Math.floor(Number(monitoredCount) || 0))} 个已监控群聊`
}

/**
 * 目标的一句话描述（首页卡片摘要用）。
 *
 * `contact` 需要外部把联系人显示名传进来 —— shared 不读通讯录。
 * 名字拿不到时如实说「未选择好友」，不伪造一个收件人。
 */
export function describeLeaveNotificationTarget(
  config: LeaveNotificationConfig | undefined,
  contactDisplayName?: string
): string {
  const target = config?.target
  if (!target) return '未配置'
  if (target.type === 'contact') return contactDisplayName?.trim() || '未选择好友'
  return leaveNotificationTargetLabel(target.type)
}

/** 触发条件的一句话摘要（UI 展示用，不含任何内部 id）。 */
export function describeRuleTrigger(rule: AutomationRule): string {
  if (rule.ruleType === 'leave_notification') return '检测到群成员退出'
  const parts: string[] = []
  if (rule.conditions.requireMentionMe) parts.push('@我')
  if (rule.conditions.keyword.trim()) {
    parts.push(`关键词「${rule.conditions.keyword.trim()}」`)
  }
  return parts.length ? parts.join(' + ') : '任意消息'
}

/** 动作链的一句话摘要。 */
export function describeRuleActions(rule: AutomationRule): string {
  if (rule.ruleType === 'leave_notification') return '发送退群通知'
  const labels: Record<AutomationActionType, string> = {
    replyText: '回复确认',
    generateReport: '生成日报',
    sendReportImage: '发送图片'
  }
  const enabled = rule.actions.filter((action) => action.enabled)
  return enabled.length ? enabled.map((action) => labels[action.type]).join(' → ') : '无动作'
}

/** 内置「@我生成日报」的默认回复文案。 */
export const DEFAULT_REPLY_TEXT = '收到，正在生成今日日报'

/**
 * 构造内置规则「@我生成日报」。
 *
 * 纯函数，方便 main（首次启动时落盘）与 UI（模板预览）共用同一份默认值，
 * 避免两处默认值漂移。
 *
 * `conversationIds` 刻意留空 = **不限会话**：首次启动时用户还没选群，
 * 强行要求选群会让内置规则「看起来存在但永不触发」，比留空更糟。
 */
export function createDefaultDailyReportRule(now: number): AutomationRule {
  return {
    id: BUILTIN_DAILY_REPORT_RULE_ID,
    name: '@我生成日报',
    enabled: true,
    ruleType: 'daily_report',
    trigger: 'message',
    scope: 'group',
    conditions: {
      requireMentionMe: true,
      keyword: '日报',
      keywordMatchMode: 'contains',
      conversationIds: [],
      ignoreSelf: true
    },
    actions: [
      { type: 'replyText', enabled: true, text: DEFAULT_REPLY_TEXT },
      { type: 'generateReport', enabled: true },
      { type: 'sendReportImage', enabled: true }
    ],
    cooldownSeconds: 60,
    replyDelaySeconds: AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS,
    createdAt: now,
    updatedAt: now
  }
}

/** 构造内置规则「退群通知」（singleton，固定 id）。 */
export function createDefaultLeaveNotificationRule(
  now: number,
  options: {
    template?: string
    target?: LeaveNotificationTarget
    enabled?: boolean
    targetNeedsReview?: boolean
  } = {}
): AutomationRule {
  return {
    id: BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
    name: LEAVE_NOTIFICATION_RULE_NAME,
    // 规则级启停是**唯一**开关；退群通知没有第二个"发送"开关。
    enabled: options.enabled !== false,
    ruleType: 'leave_notification',
    // 由退群事件驱动，不参与消息匹配。这两个字段保留只是为了 schema 完整。
    trigger: 'message',
    scope: 'group',
    conditions: {
      requireMentionMe: false,
      keyword: '',
      keywordMatchMode: 'contains',
      conversationIds: [],
      ignoreSelf: true
    },
    // 退群通知没有动作链，动作由 leaveNotification 表达。
    actions: [],
    // 不套用消息型规则的 cooldown：两次退群不能被 60 秒窗口合并。
    cooldownSeconds: 0,
    replyDelaySeconds: AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS,
    leaveNotification: {
      target: options.target ?? { type: LEAVE_NOTIFICATION_DEFAULT_TARGET_TYPE },
      template: normalizeLeaveNotificationTemplate(options.template),
      ...(options.targetNeedsReview ? { targetNeedsReview: true } : {})
    },
    createdAt: now,
    updatedAt: now
  }
}

/**
 * 模板归一化。
 *
 * 复用退群监控那份校验/归一化（含 legacy 模板升级），保证
 * 「模板规则只有一处实现」——迁移不产生第二套占位符解析。
 */
export function normalizeLeaveNotificationTemplate(value: unknown): string {
  return normalizeGroupExitNotificationTemplate(value)
}

/** 归一化用户提交的草稿：把未知值收敛成合法值，避免脏数据落盘。 */
export function normalizeRuleDraft(
  input: unknown,
  fallbackName = '未命名自动化'
): AutomationRuleDraft {
  const raw = (input ?? {}) as Partial<AutomationRuleDraft>
  const conditions = (raw.conditions ?? {}) as Partial<AutomationConditions>
  const ruleType: AutomationRuleType =
    raw.ruleType === 'leave_notification' ? 'leave_notification' : 'daily_report'
  const keywordMatchMode: KeywordMatchMode =
    conditions.keywordMatchMode === 'exact' || conditions.keywordMatchMode === 'prefix'
      ? conditions.keywordMatchMode
      : 'contains'
  const scope: AutomationMessageScope =
    raw.scope === 'direct' || raw.scope === 'all' ? raw.scope : 'group'
  const actions = Array.isArray(raw.actions) ? raw.actions : []
  const normalizedActions: AutomationAction[] = actions
    .filter((action): action is AutomationAction => Boolean(action && typeof action === 'object'))
    .map((action) => ({
      type: action.type,
      enabled: action.enabled !== false,
      ...(typeof action.text === 'string' ? { text: action.text } : {})
    }))
    .filter(
      (action) =>
        action.type === 'replyText' ||
        action.type === 'generateReport' ||
        action.type === 'sendReportImage'
    )
  const cooldown = Number(raw.cooldownSeconds)
  const base = {
    name: String(raw.name ?? '').trim() || fallbackName,
    enabled: raw.enabled !== false,
    ruleType,
    trigger: 'message' as AutomationTriggerType,
    scope,
    conditions: {
      requireMentionMe: conditions.requireMentionMe !== false,
      keyword: String(conditions.keyword ?? '').trim(),
      keywordMatchMode,
      conversationIds: Array.isArray(conditions.conversationIds)
        ? conditions.conversationIds.map((id) => String(id)).filter(Boolean)
        : [],
      ignoreSelf: conditions.ignoreSelf !== false
    },
    actions: normalizedActions,
    cooldownSeconds: Number.isFinite(cooldown) ? Math.max(0, Math.floor(cooldown)) : 60,
    replyDelaySeconds: normalizeReplyDelaySeconds(raw.replyDelaySeconds)
  }
  if (ruleType !== 'leave_notification') return base
  return { ...base, leaveNotification: normalizeLeaveNotificationConfig(raw.leaveNotification) }
}

/**
 * 收敛退群通知配置。
 *
 * 目标是**必填**的：缺失一律回落到默认目标（文件传输助手），
 * 而不是留一个"没有目标"的规则 —— 那种规则在运行时只能失败。
 * `contact` 缺 contactId 时同样回落，避免存下一条永远发不出去的规则。
 */
export function normalizeLeaveNotificationConfig(input: unknown): LeaveNotificationConfig {
  const raw = (input ?? {}) as Partial<LeaveNotificationConfig>
  const targetRaw = (raw.target ?? {}) as Partial<LeaveNotificationTarget>
  const allowed: LeaveNotificationTargetType[] = ['source_chat', 'self', 'file_transfer', 'contact']
  const type: LeaveNotificationTargetType = allowed.includes(
    targetRaw.type as LeaveNotificationTargetType
  )
    ? (targetRaw.type as LeaveNotificationTargetType)
    : LEAVE_NOTIFICATION_DEFAULT_TARGET_TYPE
  const contactId = String(targetRaw.contactId ?? '').trim()
  // `contact` 但没有 id → 回落默认目标；宁可发到文件助手，也不能存一条必然失败的规则。
  const effectiveType: LeaveNotificationTargetType =
    type === 'contact' && !contactId ? LEAVE_NOTIFICATION_DEFAULT_TARGET_TYPE : type
  return {
    target: {
      type: effectiveType,
      ...(effectiveType === 'contact' ? { contactId } : {})
    },
    template: normalizeLeaveNotificationTemplate(raw.template),
    // 用户手动保存一次即视为已确认目标，清除迁移提示。
    ...(raw.targetNeedsReview === true ? { targetNeedsReview: true } : {})
  }
}
