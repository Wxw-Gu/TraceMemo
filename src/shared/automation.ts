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
  createdAt: number
  updatedAt: number
}

/** 执行步骤状态。`skipped` 用于「上一步失败所以这一步不做」。 */
export type AutomationStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

/** 执行步骤键。只有**真正进入执行**的规则才会有步骤。 */
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
  report: 'automation_report'
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
  trigger: AutomationTriggerType
  scope: AutomationMessageScope
  conditions: AutomationConditions
  actions: AutomationAction[]
  cooldownSeconds: number
  /** 命中后等多久再回复确认（秒）。0 = 立刻回复。 */
  replyDelaySeconds: number
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
    replyDelaySeconds: AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS,
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
    cooldownSeconds: Number.isFinite(cooldown) ? Math.max(0, Math.floor(cooldown)) : 60,
    replyDelaySeconds: normalizeReplyDelaySeconds(raw.replyDelaySeconds)
  }
}
