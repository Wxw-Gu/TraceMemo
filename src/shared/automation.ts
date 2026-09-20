/**
 * Automation v1 的跨层契约。
 *
 * 设计原则：**只包含当前真正需要的字段**。
 * 第一版不做：regex、IF/ELSE 嵌套、可视化编排、Webhook、通用 AI 机器人。
 */

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
  trigger: AutomationTriggerType
  scope: AutomationMessageScope
  conditions: AutomationConditions
  actions: AutomationAction[]
  /** 同一规则在同一会话内的最小触发间隔（秒）。防刷屏。 */
  cooldownSeconds: number
  createdAt: number
  updatedAt: number
}

/** 执行步骤状态。`skipped` 用于「上一步失败所以这一步不做」。 */
export type AutomationStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

export type AutomationStepKey = 'received' | 'matched' | 'reply' | 'report' | 'send'

export interface AutomationStep {
  key: AutomationStepKey
  /** 用户可读的步骤名（中文）。 */
  label: string
  status: AutomationStepStatus
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  /** 用户可读的错误信息。**禁止**含 wxid / 文件路径 / 原始 payload。 */
  error?: string
}

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
  report: 'automation_report'
} as const

/** 审计日志里的来源标识（`WechatActionOrigin`）。 */
export const AUTOMATION_SEND_ORIGIN = 'automation'

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
  trigger: AutomationTriggerType
  scope: AutomationMessageScope
  conditions: AutomationConditions
  actions: AutomationAction[]
  cooldownSeconds: number
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
    unavailableReason: '沿用现有「定时日报」能力，本轮不迁移'
  },
  {
    id: 'member-exit-notice',
    name: '退群通知',
    description: '群成员退出时自动发送通知',
    available: false,
    unavailableReason: '现有「退群监控」已具备该能力，本轮不迁移'
  },
  {
    id: 'keyword-reply',
    name: '关键词自动回复',
    description: '消息命中关键词时自动回复指定内容',
    available: false,
    unavailableReason: '本轮验收对象为「@我生成日报」，关键词模板下一轮开放'
  }
]

/** 内置规则 id。固定值，便于升级时不重复创建。 */
export const BUILTIN_DAILY_REPORT_RULE_ID = 'builtin-mention-me-daily-report'

export const AUTOMATION_STEP_LABELS: Record<AutomationStepKey, string> = {
  received: '收到消息',
  matched: '规则匹配',
  reply: '回复确认',
  report: '生成日报',
  send: '发送日报图片'
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

/** 触发条件的一句话摘要（UI 展示用，不含任何内部 id）。 */
export function describeRuleTrigger(rule: AutomationRule): string {
  const parts: string[] = []
  if (rule.conditions.requireMentionMe) parts.push('@我')
  if (rule.conditions.keyword.trim()) {
    parts.push(`关键词「${rule.conditions.keyword.trim()}」`)
  }
  return parts.length ? parts.join(' + ') : '任意消息'
}

/** 动作链的一句话摘要。 */
export function describeRuleActions(rule: AutomationRule): string {
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
    createdAt: now,
    updatedAt: now
  }
}

/** 归一化用户提交的草稿：把未知值收敛成合法值，避免脏数据落盘。 */
export function normalizeRuleDraft(input: unknown, fallbackName = '未命名自动化'): AutomationRuleDraft {
  const raw = (input ?? {}) as Partial<AutomationRuleDraft>
  const conditions = (raw.conditions ?? {}) as Partial<AutomationConditions>
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
    .filter((action) =>
      action.type === 'replyText' || action.type === 'generateReport' || action.type === 'sendReportImage'
    )
  const cooldown = Number(raw.cooldownSeconds)
  return {
    name: String(raw.name ?? '').trim() || fallbackName,
    enabled: raw.enabled !== false,
    trigger: 'message',
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
    cooldownSeconds: Number.isFinite(cooldown) ? Math.max(0, Math.floor(cooldown)) : 60
  }
}
