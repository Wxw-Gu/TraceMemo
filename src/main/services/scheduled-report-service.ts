import { app } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import type { AgentHubStatus } from '../../shared/agent-hub'
import {
  AUTOMATION_RULE_TYPE_LABELS,
  calculateNextRunAt,
  isValidScheduleTime,
  normalizeScheduledReportConfig,
  type AutomationRule,
  type ScheduledReportAutomationConfig,
  type ScheduledReportTargetType
} from '../../shared/automation'
import type {
  ScheduledReportCreateInput,
  ScheduledReportExecution,
  ScheduledReportExecutionStage,
  ScheduledReportNotification,
  ScheduledReportNotificationCapability,
  ScheduledReportNotificationCapabilityReason,
  ScheduledReportNotificationSettings,
  ScheduledReportNotificationSettingsResult,
  ScheduledReportNotificationSeverity,
  ScheduledReportNotificationType,
  ScheduledReportResult,
  ScheduledReportSendStatus,
  ScheduledReportTask,
  ScheduledReportUpdateInput
} from '../../shared/scheduled-report'
import {
  automationRuleStore
} from './automation-rule-store'
import {
  automationExecutionLogService,
  type AutomationExecutionLogService
} from './automation-execution-log-service'
import {
  getAutomationService,
  type ScheduledRuleRunOutcome
} from './automation-service'
import { agentHubService, type AgentHubNotificationResult } from './agent-hub-service'

/**
 * ScheduledReportService —— **退役后的定时日报服务**。
 *
 * 职责被压到三件事，且**只有这三件**：
 *
 * 1. **调度器（scheduler）**：只改任务来源，不重写计时器。
 *    ```text
 *    Before:  ScheduledReportStore(tasks.json) → Scheduler
 *    After:   AutomationRuleStore ─ ruleType='scheduled_report' ↓ Scheduler
 *    ```
 *    真正干活的一律交给 `AutomationService.executeScheduledRule()` ——
 *    这个类**不认识微信、不认识 OCR、不认识日报生成**。
 * 2. **微信异常通知**：定时日报生成 / 发送异常时，经 Agent Hub 推一条消息。
 *    这是定时日报功能的**全局能力**（与具体任务无关），因此随功能一起保留。
 * 3. **旧数据只读存档**：旧 `tasks.json` / `executions.json` 不再参与运行期调度，
 *    但历史执行记录**不能丢**，所以保留只读投影给 UI 展示。
 *
 * 已移除的能力：
 * - 任务 CRUD 的**存储**（改由 `AutomationRuleStore` 承担；这里只保留一层
 *   面向 HTTP API 的**只读兼容投影**，不落第二份数据）；
 * - 日报生成 / 发送（`generateAgentGroupReport` / `saveGeneratedReport` /
 *   `WechatActionGateway`）—— 全部搬进 `AutomationActionRunner.runScheduledReport()`；
 * - `executions.json` 的写入（新执行记录进 Automation Execution Log）。
 */

const STORAGE_DIR = 'scheduled-reports'
const TASKS_FILE = 'tasks.json'
const EXECUTIONS_FILE = 'executions.json'
const NOTIFICATIONS_FILE = 'notifications.json'
const SETTINGS_FILE = 'settings.json'
const TICK_MS = 15_000
const NOTIFICATION_TEST_MESSAGE = `✅ TraceMemo 定时日报通知已开启

以后定时日报生成或发送出现异常时，
我会通过这里通知你。`

/**
 * 生成失败但**不该打扰用户**的错误码。
 *
 * 这类错误照常记为 `failed`（如实），只是不该打扰用户 ——
 * 把"不通知"这个判断放在**通知桥**这一层。
 */
const NON_NOTIFYING_ERROR_CODES = new Set(['NO_MESSAGES'])

export interface ScheduledReportDependencies {
  /** 执行一条定时日报规则。默认走 `AutomationService`。 */
  executeRule: (
    ruleId: string,
    options: { trigger: 'schedule' | 'manual'; scheduledSlot?: string }
  ) => Promise<ScheduledRuleRunOutcome>
  /** 调度器的**唯一任务来源**。 */
  listRules: () => AutomationRule[]
  /** Automation 执行日志（用于把新执行记录投影给 HTTP API）。 */
  listExecutions: (query?: { limit?: number }) => ReturnType<AutomationExecutionLogService['list']>
  sendNotification: (input: { to?: string; text: string }) => Promise<AgentHubNotificationResult>
  getNotificationRecipient: () => string | undefined
  getAgentHubStatus: () => AgentHubStatus
  storageDir: string
  /** 数据库未就绪时不调度：目标解析必然失败，跑了只会留下误导性的失败记录。 */
  isDatabaseReady: () => boolean
  now?: () => Date
}

const defaultDependencies = (): ScheduledReportDependencies => ({
  executeRule: (ruleId, options) => getAutomationService().executeScheduledRule(ruleId, options),
  listRules: () => automationRuleStore.listRules(),
  listExecutions: (query) => automationExecutionLogService.list(query),
  sendNotification: (input) => agentHubService.sendNotification(input),
  getNotificationRecipient: () => agentHubService.getNotificationRecipient(),
  getAgentHubStatus: () => agentHubService.getStatus(),
  storageDir: path.join(app.getPath('userData'), STORAGE_DIR),
  isDatabaseReady: () => true
})

interface ScheduledReportNotificationPayload {
  type: ScheduledReportNotificationType
  severity: ScheduledReportNotificationSeverity
  title: string
  message: string
  suggestedAction?: string
}

/** `HH:mm` 校验（保留既有导出名，与共享层同一实现）。 */
export const validateScheduleTime = isValidScheduleTime
export { calculateNextRunAt, isValidScheduleTime }

/**
 * **已经到点、且最近的那个**每日槽位（ISO）。
 *
 * 与 `calculateNextRunAt`（返回"下一个"）配对使用：
 * - 编辑页展示「下次执行」→ `calculateNextRunAt`；
 * - 调度器判断「今天这一枪该不该开」→ 本函数。
 */
export function resolveDueScheduledSlot(scheduleTime: string, at: Date = new Date()): string {
  if (!isValidScheduleTime(scheduleTime)) throw new Error('执行时间必须是 HH:mm')
  const [hour, minute] = String(scheduleTime).trim().split(':').map(Number)
  const slot = new Date(at)
  slot.setHours(hour, minute, 0, 0)
  if (slot.getTime() > at.getTime()) slot.setDate(slot.getDate() - 1)
  return slot.toISOString()
}

export class ScheduledReportService {
  private readonly deps: ScheduledReportDependencies
  /** 旧存档：只在 `load()` 读一次，**永不被运行期调度使用**。 */
  private legacyTasks: ScheduledReportTask[] | null = null
  private legacyExecutions: ScheduledReportExecution[] | null = null
  private notifications: ScheduledReportNotification[] | null = null
  private notificationSettings: ScheduledReportNotificationSettings | null = null
  private timer: NodeJS.Timeout | null = null
  /** 已 fire-and-forget 起飞的执行（仅用于测试等待；不影响业务语义）。 */
  private readonly pending = new Set<Promise<unknown>>()

  constructor(deps?: Partial<ScheduledReportDependencies>) {
    this.deps = { ...defaultDependencies(), ...deps }
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.load()
    if (this.timer) return
    await this.flushNotifications()
    this.timer = setInterval(() => {
      void this.tick().catch((error) => console.warn('[ScheduledReport] tick failed:', error))
    }, TICK_MS)
    // 首轮扫描也登记进 `pending`：否则 `settle()` 会在它真正起飞**之前**就返回，
    // 调用方（主要是测试）拿不到确定性。
    this.track(
      this.tick().catch((error) => console.warn('[ScheduledReport] initial tick failed:', error))
    )
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 等待所有 fire-and-forget 的执行结束（测试用；运行期不调用）。 */
  async settle(): Promise<void> {
    while (this.pending.size) {
      await Promise.all([...this.pending])
    }
  }

  // ---------------------------------------------------------------------------
  // 调度器
  // ---------------------------------------------------------------------------

  /**
   * 一次调度扫描。**不重写计时器**：仍然是 15 秒一次的 `setInterval`。
   *
   * 每个到点且未消费的槽位调用一次 `AutomationService.executeScheduledRule(ruleId, …)`：
   * - 并发保护（同规则同时只跑一个）在 `AutomationService` 里；
   * - 槽位游标（`lastScheduledSlot`）由 `AutomationService` 写；
   * - 这里**只负责**"读规则 → 判断到点 → 触发 → 失败时推异常通知"。
   */
  async tick(at = this.deps.now?.() || new Date()): Promise<void> {
    await this.load()
    await this.flushNotifications()
    if (!this.deps.isDatabaseReady()) return

    let rules: AutomationRule[]
    try {
      rules = this.deps.listRules()
    } catch (error) {
      console.warn('[ScheduledReport] 读取自动化规则失败:', error)
      return
    }

    for (const rule of rules) {
      const config = rule.scheduledReport
      if (rule.ruleType !== 'scheduled_report' || !config) continue
      if (!rule.enabled) continue
      // 迁移遗留的"目标待重选"：不调度、不创建记录，由 UI 提示用户处理。
      if (config.targetNeedsReview) continue
      if (!isValidScheduleTime(config.schedule.time)) continue

      // `resolveDueScheduledSlot` 承诺返回「已经到点、最近的那个」槽位
      // （一定是 `<= at`），所以不需要再自己判一次到点。
      let slot: string
      try {
        slot = resolveDueScheduledSlot(config.schedule.time, at)
      } catch {
        continue
      }
      const slotMs = Date.parse(slot)
      if (!Number.isFinite(slotMs)) continue

      // 闸门 1：槽位必须晚于规则创建时间。
      //
      // 新建规则时（例：今天 10:00 建、执行时间 18:30），"最近的槽位"是**昨天 18:30**，
      // 那不属于这条规则 —— 少了这道闸，新建规则会在下一次 tick（15 秒内）就补发一份
      // 昨天的报告。这是绝不能出现的副作用。
      if (slotMs < rule.createdAt) continue

      // 闸门 2：槽位必须比**已消费的游标**更新。
      //
      // 槽位时间单调递增，所以用数值比较而不是字符串相等：
      // 游标比槽位新（用户改过执行时间等）同样说明这个槽位已经过期，不该再补。
      // 用 `===` 会漏掉"游标更新"这一类，用 `<=` 一并覆盖。
      const consumed = config.lastScheduledSlot ? Date.parse(config.lastScheduledSlot) : NaN
      if (Number.isFinite(consumed) && slotMs <= consumed) continue

      const promise = this.runRule(rule, {
        trigger: 'schedule',
        scheduledSlot: slot
      }).catch((error) => console.warn('[ScheduledReport] execution failed:', error))
      this.track(promise)
    }
  }

  /**
   * 立即执行（用户点「立即执行」）。
   *
   * **不消耗槽位**：手动执行不该导致今天不再定时跑。
   */
  async runScheduledReportNow(ruleId: string): Promise<ScheduledReportResult<ScheduledReportExecution>> {
    await this.load()
    const rule = this.findRule(ruleId)
    if (!rule) return { success: false, error: '未找到定时日报规则' }
    const outcome = await this.runRule(rule, { trigger: 'manual' })
    const execution = this.projectOutcome(outcome, rule, 'manual')
    return {
      success: outcome.status !== 'failed',
      data: execution,
      ...(outcome.status === 'failed' && outcome.errorSummary
        ? { error: outcome.errorSummary }
        : {})
    }
  }

  /**
   * 一次执行结果 → 旧 `ScheduledReportExecution` 形状（HTTP API 契约用）。
   *
   * 新状态模型只有 3 态，这里做**有损但方向明确**的投影：
   * 未执行（停用 / 目标待重选 / 并发占用）→ `skipped`；
   * 执行了但失败 → `failed`；成功 → `success`。
   */
  private projectOutcome(
    outcome: ScheduledRuleRunOutcome,
    rule: AutomationRule,
    trigger: 'schedule' | 'manual'
  ): ScheduledReportExecution {
    const nowMs = (this.deps.now?.() || new Date()).getTime()
    const startedAt = new Date(nowMs).toISOString()
    const status = !outcome.executed
      ? ('skipped' as const)
      : outcome.status === 'success'
        ? ('success' as const)
        : ('failed' as const)
    return {
      id: outcome.executionId || `${rule.id}:${nowMs}`,
      taskId: rule.id,
      // 旧存档的字段名是 `scheduled`（不是新的 `schedule`）—— 投影时如实转换。
      triggerType: trigger === 'manual' ? 'manual' : 'scheduled',
      startedAt,
      finishedAt: startedAt,
      status,
      currentStage: 'send',
      message: outcome.errorSummary || '日报执行完成',
      ...(outcome.errorSummary ? { error: outcome.errorSummary } : {}),
      retryCount: 0,
      sendStatus: status === 'success' ? 'success' : 'failed',
      notificationStatus: 'not_needed'
    }
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise))
  }

  /**
   * 触发一次执行 + 失败时推异常通知。
   *
   * **手动执行不推通知**：只有定时任务失败才打扰用户。
   */
  private async runRule(
    rule: AutomationRule,
    options: { trigger: 'schedule' | 'manual'; scheduledSlot?: string }
  ): Promise<ScheduledRuleRunOutcome> {
    const outcome = await this.deps.executeRule(rule.id, options)
    if (
      options.trigger === 'schedule' &&
      outcome.executed &&
      outcome.status === 'failed' &&
      !NON_NOTIFYING_ERROR_CODES.has(outcome.errorCode || '')
    ) {
      await this.notifyRuleFailure(rule, outcome)
    }
    return outcome
  }

  // ---------------------------------------------------------------------------
  // 微信异常通知（独立能力，随定时日报功能保留）
  // ---------------------------------------------------------------------------

  async getNotificationSettings(): Promise<ScheduledReportNotificationSettings> {
    await this.load()
    return { ...this.notificationSettings! }
  }

  async listNotifications(): Promise<ScheduledReportNotification[]> {
    await this.load()
    return this.notifications!.map((item) => ({ ...item }))
  }

  async checkNotificationCapability(): Promise<ScheduledReportNotificationCapability> {
    let status: AgentHubStatus
    try {
      status = this.deps.getAgentHubStatus()
    } catch (error) {
      return {
        ready: false,
        reason: 'agent_hub_offline',
        error: error instanceof Error ? error.message : String(error)
      }
    }
    if (status.hub !== 'online') {
      return {
        ready: false,
        reason: 'agent_hub_offline',
        error: '需要先连接 Agent Hub 微信机器人，才能接收异常通知。'
      }
    }
    if (status.connector !== 'online') {
      return {
        ready: false,
        reason: 'connector_offline',
        error: 'Agent Hub 微信连接器当前未在线。'
      }
    }
    let recipient: string | undefined
    try {
      recipient = String(this.deps.getNotificationRecipient() || '').trim() || undefined
    } catch (error) {
      return {
        ready: false,
        reason: 'recipient_not_bound',
        error: error instanceof Error ? error.message : String(error)
      }
    }
    if (!recipient) {
      return {
        ready: false,
        reason: 'recipient_not_bound',
        error:
          'Agent Hub 已连接，但还不知道异常通知应该发送给谁。请先在微信中给 TraceMemo 机器人发送一条消息，完成通知接收者绑定。'
      }
    }
    return { ready: true, recipient }
  }

  async setNotificationEnabled(
    enabled: boolean
  ): Promise<ScheduledReportNotificationSettingsResult> {
    await this.load()
    const currentEnabled = this.notificationSettings!.enabled
    if (!enabled && !currentEnabled) {
      await this.suppressPendingNotifications()
      return { success: true, data: { enabled: false } }
    }
    if (enabled && currentEnabled) {
      return { success: true, data: { enabled: true } }
    }

    if (!enabled) {
      this.notificationSettings = { enabled: false }
      try {
        await this.saveNotificationSettings()
      } catch (error) {
        this.notificationSettings = { enabled: currentEnabled }
        return {
          success: false,
          data: { enabled: currentEnabled },
          reason: 'settings_persist_failed',
          error: error instanceof Error ? error.message : String(error)
        }
      }
      try {
        await this.suppressPendingNotifications()
      } catch (error) {
        console.warn('[ScheduledReport] failed to suppress pending notifications:', error)
      }
      return { success: true, data: { enabled: false } }
    }

    await this.suppressPendingNotifications()
    const capability = await this.checkNotificationCapability()
    if (!capability.ready || !capability.recipient) {
      return {
        success: false,
        data: { enabled: false },
        reason: capability.reason || 'send_failed',
        error: capability.error || '定时日报异常通知能力尚未就绪。'
      }
    }

    let testResult: AgentHubNotificationResult
    try {
      testResult = await this.deps.sendNotification({
        to: capability.recipient,
        text: NOTIFICATION_TEST_MESSAGE
      })
    } catch (error) {
      return {
        success: false,
        data: { enabled: false },
        reason: 'send_failed',
        error: error instanceof Error ? error.message : String(error)
      }
    }
    if (!testResult.success) {
      return {
        success: false,
        data: { enabled: false },
        reason: this.notificationCapabilityReasonForSend(testResult),
        error: testResult.error || '异常通知测试发送失败。'
      }
    }

    this.notificationSettings = { enabled: true }
    try {
      await this.saveNotificationSettings()
    } catch (error) {
      this.notificationSettings = { enabled: false }
      return {
        success: false,
        data: { enabled: false },
        reason: 'settings_persist_failed',
        error: error instanceof Error ? error.message : String(error)
      }
    }
    return { success: true, data: { enabled: true } }
  }

  /**
   * 发一条**模拟**异常通知，验证 Agent Hub 推送链路。
   *
   * 迁移前这是旧「定时日报」页面上的调试入口。页面退役后入口挪到
   * Automation 的定时日报区域，能力本身**一字不改**（否则等于把功能删了）。
   */
  async testScheduledReportErrorNotification(
    ruleId: string
  ): Promise<ScheduledReportResult<ScheduledReportNotification>> {
    await this.load()
    if (!this.notificationSettings!.enabled) {
      return { success: false, error: '请先开启微信异常通知，再发送测试错误信息。' }
    }
    const rule = this.findRule(ruleId)
    const ruleName = rule?.name || AUTOMATION_RULE_TYPE_LABELS.scheduled_report
    const now = (this.deps.now?.() || new Date()).toISOString()
    const notification = await this.enqueueNotification({
      ruleId: rule?.id || String(ruleId || '').trim(),
      ruleName,
      dedupeKey: `debug:${randomUUID()}`,
      payload: {
        type: 'failure',
        severity: 'error',
        title: '定时日报错误通知测试',
        message: '这是一条调试用的模拟错误通知，用于验证 Agent Hub 推送链路。',
        suggestedAction: '确认微信中是否收到这条测试通知。'
      },
      createdAt: now
    })
    return {
      success: notification.status === 'sent',
      data: { ...notification },
      ...(notification.status === 'sent' ? {} : { error: '测试错误已创建，但通知尚未送达。' })
    }
  }

  /** 定时日报失败 → 入队 + 立刻尝试送达。 */
  private async notifyRuleFailure(
    rule: AutomationRule,
    outcome: ScheduledRuleRunOutcome
  ): Promise<void> {
    await this.load()
    if (!this.notificationSettings!.enabled) return
    const executionId = outcome.executionId || `${rule.id}:${this.deps.now?.()?.getTime() ?? 0}`
    const message = outcome.errorSummary || '定时日报执行失败。'
    await this.enqueueNotification({
      ruleId: rule.id,
      ruleName: rule.name,
      executionId,
      dedupeKey: `${executionId}:failure`,
      payload: {
        type: 'failure',
        severity: 'error',
        title: '定时日报执行失败',
        message
      },
      createdAt: (this.deps.now?.() || new Date()).toISOString()
    })
  }

  private async enqueueNotification(input: {
    ruleId: string
    ruleName: string
    executionId?: string
    dedupeKey: string
    payload: ScheduledReportNotificationPayload
    createdAt: string
  }): Promise<ScheduledReportNotification> {
    await this.load()
    const existing = this.notifications!.find((item) => item.dedupeKey === input.dedupeKey)
    if (existing) return { ...existing }
    let recipient: string | undefined
    try {
      recipient = this.deps.getNotificationRecipient()
    } catch {
      recipient = undefined
    }
    const notification: ScheduledReportNotification = {
      id: `scheduled_report_notification_${randomUUID()}`,
      executionId: input.executionId || input.dedupeKey,
      // 字段名沿用旧存档（`taskId`）—— 迁移后 rule.id === 旧 task.id，语义一致。
      taskId: input.ruleId,
      type: input.payload.type,
      severity: input.payload.severity,
      title: input.payload.title,
      message: input.payload.message,
      dedupeKey: input.dedupeKey,
      channel: 'agent_hub',
      ...(recipient ? { recipient } : {}),
      status: 'pending',
      createdAt: input.createdAt,
      attempts: 0
    }
    this.notifications!.unshift(notification)
    this.notifications = this.notifications!.slice(0, 500)
    await this.saveNotifications()
    await this.tryDeliverNotification(notification, input.ruleName, input.payload)
    return { ...notification }
  }

  private async tryDeliverNotification(
    notification: ScheduledReportNotification,
    ruleName: string,
    payload?: ScheduledReportNotificationPayload
  ): Promise<void> {
    if (notification.status === 'sent') return
    await this.load()
    if (!this.notificationSettings!.enabled) {
      notification.status = 'suppressed'
      notification.suppressedAt = (this.deps.now?.() || new Date()).toISOString()
      notification.lastError = '定时日报微信异常通知已关闭。'
      await this.saveNotifications()
      return
    }
    let recipient = notification.recipient
    if (!recipient) {
      try {
        recipient = this.deps.getNotificationRecipient()
      } catch {
        recipient = undefined
      }
    }
    if (!recipient) return
    notification.recipient = recipient
    notification.attempts += 1
    try {
      const result = await this.deps.sendNotification({
        to: recipient,
        text: this.notificationText(
          ruleName,
          payload?.severity || notification.severity,
          payload?.title || notification.title,
          payload?.message || notification.message,
          payload?.suggestedAction
        )
      })
      if (result.success) {
        notification.status = 'sent'
        notification.sentAt = (this.deps.now?.() || new Date()).toISOString()
        delete notification.lastError
      } else {
        notification.status = 'pending'
        notification.lastError = result.error || result.status
      }
    } catch (error) {
      notification.status = 'pending'
      notification.lastError = error instanceof Error ? error.message : String(error)
    }
    await this.saveNotifications()
  }

  private async flushNotifications(): Promise<void> {
    await this.load()
    if (!this.notificationSettings!.enabled) {
      await this.suppressPendingNotifications()
      return
    }
    const pending = this.notifications!.filter((item) => item.status === 'pending')
    if (!pending.length) return
    let rules: AutomationRule[] = []
    try {
      rules = this.deps.listRules()
    } catch {
      rules = []
    }
    for (const notification of pending) {
      const name =
        rules.find((rule) => rule.id === notification.taskId)?.name ||
        AUTOMATION_RULE_TYPE_LABELS.scheduled_report
      await this.tryDeliverNotification(notification, name)
    }
  }

  private async suppressPendingNotifications(): Promise<void> {
    await this.load()
    const pending = this.notifications!.filter((item) => item.status === 'pending')
    if (!pending.length) return
    const suppressedAt = (this.deps.now?.() || new Date()).toISOString()
    for (const notification of pending) {
      notification.status = 'suppressed'
      notification.suppressedAt = suppressedAt
      notification.lastError = '定时日报微信异常通知已关闭。'
    }
    await this.saveNotifications()
  }

  private notificationCapabilityReasonForSend(
    result: AgentHubNotificationResult
  ): ScheduledReportNotificationCapabilityReason {
    if (result.status === 'recipient_unavailable') return 'recipient_not_bound'
    if (result.status === 'connector_offline') return 'connector_offline'
    return 'send_failed'
  }

  private notificationText(
    ruleName: string,
    severity: ScheduledReportNotificationSeverity,
    title: string,
    message: string,
    suggestedAction?: string
  ): string {
    const icon = severity === 'error' ? '❌' : severity === 'warning' ? '⚠️' : '✅'
    return [
      `${icon} ${ruleName}`,
      title,
      message,
      suggestedAction ? `建议：${suggestedAction}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  }

  // ---------------------------------------------------------------------------
  // 旧数据只读存档 + HTTP API 兼容投影
  // ---------------------------------------------------------------------------

  /**
   * 旧 `tasks.json` 的**只读**快照。
   *
   * 运行期调度**绝不**用它（唯一 source of truth 是 `AutomationRuleStore`）。
   * 保留它只为一件事：把历史执行记录还原成"当时那条任务叫什么"。
   */
  async listLegacyTasks(): Promise<ScheduledReportTask[]> {
    await this.load()
    return this.legacyTasks!.map((task) => ({ ...task }))
  }

  /**
   * 历史执行记录（只读存档）。
   *
   * 旧执行记录**无法无损转换**成新的步骤模型（旧的是 7 态 + stage + sendStatus，
   * 新的是 3 态 + 通用步骤），所以**不迁移、不改写**，原样只读保留。
   */
  async listLegacyExecutions(ruleId?: string): Promise<ScheduledReportExecution[]> {
    await this.load()
    if (!ruleId) return this.legacyExecutions!.map((item) => ({ ...item }))
    const key = String(ruleId).trim()
    return this.legacyExecutions!
      .filter((item) => this.matchesRuleId(item.taskId, key))
      .map((item) => ({ ...item }))
  }

  /** 旧 taskId ↔ 新 ruleId 的对应（复用旧 id 时两者相同）。 */
  private matchesRuleId(taskId: string | undefined, ruleId: string): boolean {
    const raw = String(taskId || '').trim()
    if (!raw) return false
    return raw === ruleId || `scheduled-report:${raw}` === ruleId
  }

  /**
   * 兼容投影：`scheduled_report` 规则 → 旧 `ScheduledReportTask` 形状。
   *
   * **只读、内存内转换**，不产生第二份存储。只投影目标为「发回来源群」的规则 ——
   * 这是旧 HTTP API 契约（`target.type === 'wechat_group'`）唯一能如实表达的形态。
   */
  async listTasks(): Promise<ScheduledReportTask[]> {
    const now = this.deps.now?.() || new Date()
    return this.scheduledRules()
      .filter((rule) => this.isHttpProjectable(rule))
      .map((rule) => this.ruleToLegacyTask(rule, now))
  }

  async listExecutions(taskId?: string): Promise<ScheduledReportExecution[]> {
    const key = String(taskId || '').trim()
    const legacy = await this.listLegacyExecutions(key || undefined)
    // 新增的执行记录从 Automation Execution Log 投影（同一 ruleId）。
    let projected: ScheduledReportExecution[] = []
    try {
      const executions = this.deps.listExecutions({ limit: 500 })
      projected = executions
        .filter((item) => (key ? item.ruleId === key : true))
        .filter((item) => {
          const rule = this.findRule(item.ruleId)
          return rule?.ruleType === 'scheduled_report'
        })
        .map((item) => this.automationExecutionToLegacy(item))
    } catch (error) {
      console.warn('[ScheduledReport] 读取 Automation 执行日志失败:', error)
    }
    // 旧记录在前（更早），新记录追加在后，按开始时间排序。
    return [...legacy, ...projected].sort(
      (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)
    )
  }

  async createTask(
    input: ScheduledReportCreateInput
  ): Promise<ScheduledReportResult<ScheduledReportTask>> {
    const group = String(input.group || '').trim()
    if (!group) return { success: false, error: '微信群不能为空' }
    const name = String(input.name || '').trim()
    if (!name) return { success: false, error: '日报名称不能为空' }
    const scheduleTime = String(input.scheduleTime || '').trim()
    if (!isValidScheduleTime(scheduleTime)) return { success: false, error: '执行时间必须是 HH:mm' }

    const config = normalizeScheduledReportConfig({
      schedule: { time: scheduleTime },
      report: {
        sourceConversationId: group,
        range: input.reportRange,
        messageTypes: input.messageTypes,
        templateId: input.templateId,
        memberNameMode: input.memberNameMode,
        timeoutSeconds: input.timeoutSeconds
      },
      // HTTP 契约里 target 必须等于 group，等价于 source_chat。
      target: { type: 'source_chat' }
    })
    const created = automationRuleStore.createRule({
      name,
      enabled: input.enabled !== false,
      ruleType: 'scheduled_report',
      scheduledReport: config
    })
    return { success: true, data: this.ruleToLegacyTask(created, this.deps.now?.() || new Date()) }
  }

  async updateTask(
    taskId: string,
    input: ScheduledReportUpdateInput
  ): Promise<ScheduledReportResult<ScheduledReportTask>> {
    const rule = this.findRule(taskId)
    if (!rule) return { success: false, error: '未找到定时日报任务' }
    const current = normalizeScheduledReportConfig(rule.scheduledReport)
    const scheduleTime = String(input.scheduleTime ?? current.schedule.time).trim()
    if (!isValidScheduleTime(scheduleTime)) return { success: false, error: '执行时间必须是 HH:mm' }
    const next = normalizeScheduledReportConfig({
      ...current,
      schedule: { time: scheduleTime },
      report: {
        sourceConversationId: String(input.group ?? current.report.sourceConversationId).trim(),
        range: input.reportRange ?? current.report.range,
        messageTypes: input.messageTypes ?? current.report.messageTypes,
        templateId: input.templateId ?? current.report.templateId,
        memberNameMode: input.memberNameMode ?? current.report.memberNameMode,
        timeoutSeconds: input.timeoutSeconds ?? current.report.timeoutSeconds
      },
      target: current.target,
      targetNeedsReview: false
    })
    const updated = automationRuleStore.updateRule(rule.id, {
      ...rule,
      name: input.name !== undefined ? String(input.name).trim() : rule.name,
      enabled: input.enabled !== undefined ? input.enabled !== false : rule.enabled,
      scheduledReport: next
    })
    if (!updated) return { success: false, error: '未找到定时日报任务' }
    return { success: true, data: this.ruleToLegacyTask(updated, this.deps.now?.() || new Date()) }
  }

  async deleteTask(taskId: string): Promise<ScheduledReportResult<{ deletedId: string }>> {
    const rule = this.findRule(taskId)
    if (!rule) return { success: false, error: '未找到定时日报任务' }
    const deleted = automationRuleStore.deleteRule(rule.id)
    if (!deleted) return { success: false, error: '未找到定时日报任务' }
    return { success: true, data: { deletedId: rule.id } }
  }

  async setTaskEnabled(
    taskId: string,
    enabled: boolean
  ): Promise<ScheduledReportResult<ScheduledReportTask>> {
    const rule = this.findRule(taskId)
    if (!rule) return { success: false, error: '未找到定时日报任务' }
    const updated = automationRuleStore.setRuleEnabled(rule.id, enabled)
    if (!updated) return { success: false, error: '未找到定时日报任务' }
    return { success: true, data: this.ruleToLegacyTask(updated, this.deps.now?.() || new Date()) }
  }

  /** 新建一条定时日报规则（Automation UI 用；与兼容投影无关）。 */
  createScheduledReportRule(input: {
    name: string
    enabled?: boolean
    config: ScheduledReportAutomationConfig
  }): AutomationRule {
    return automationRuleStore.createRule({
      name: input.name,
      enabled: input.enabled !== false,
      ruleType: 'scheduled_report',
      scheduledReport: input.config
    })
  }

  private scheduledRules(): AutomationRule[] {
    try {
      return this.deps.listRules().filter((rule) => rule.ruleType === 'scheduled_report')
    } catch (error) {
      console.warn('[ScheduledReport] 读取自动化规则失败:', error)
      return []
    }
  }

  private findRule(ruleId: string): AutomationRule | undefined {
    const key = String(ruleId || '').trim()
    if (!key) return undefined
    const rule = this.scheduledRules().find((item) => item.id === key)
    return rule
  }

  private isHttpProjectable(rule: AutomationRule): boolean {
    const config = rule.scheduledReport
    if (!config) return false
    if (config.targetNeedsReview) return false
    return this.scheduledTargetType(rule) === 'source_chat'
  }

  private scheduledTargetType(rule: AutomationRule): ScheduledReportTargetType {
    const type = rule.scheduledReport?.target?.type
    if (type === 'self' || type === 'file_transfer' || type === 'contact' || type === 'source_chat') {
      return type
    }
    return 'source_chat'
  }

  private ruleToLegacyTask(rule: AutomationRule, now: Date): ScheduledReportTask {
    const config = normalizeScheduledReportConfig(rule.scheduledReport)
    const source = config.report.sourceConversationId
    return {
      id: rule.id,
      name: rule.name,
      group: source,
      scheduleTime: config.schedule.time,
      reportRange: config.report.range,
      messageTypes: config.report.messageTypes,
      templateId: config.report.templateId,
      memberNameMode: config.report.memberNameMode,
      timeoutSeconds: config.report.timeoutSeconds,
      // 旧契约里 target 必须是群：source_chat 时就是来源群本身。
      target: source,
      enabled: rule.enabled,
      createdAt: new Date(rule.createdAt).toISOString(),
      updatedAt: new Date(rule.updatedAt).toISOString(),
      nextRunAt: calculateNextRunAt(config.schedule.time, now),
      ...(config.lastRunAt ? { lastRunAt: config.lastRunAt } : {}),
      ...(config.lastScheduledSlot ? { lastScheduledSlot: config.lastScheduledSlot } : {})
    }
  }

  /** Automation 执行记录 → 旧 `ScheduledReportExecution` 形状（只读投影）。 */
  private automationExecutionToLegacy(
    execution: ReturnType<AutomationExecutionLogService['list']>[number]
  ): ScheduledReportExecution {
    const startedAt = new Date(execution.triggerTime).toISOString()
    const finishedAt = new Date(execution.triggerTime + Math.max(0, execution.durationMs)).toISOString()
    const sent = execution.steps.some((step) => step.key === 'report_sent' && step.status === 'success')
    const currentStage: ScheduledReportExecutionStage = execution.steps.some(
      (step) => step.key === 'report_sent' && step.status !== 'pending'
    )
      ? 'send'
      : 'report'
    return {
      id: execution.executionId,
      taskId: execution.ruleId,
      triggerType: execution.trigger === 'manual' ? 'manual' : 'scheduled',
      startedAt,
      finishedAt,
      status: execution.status,
      currentStage,
      message: execution.errorSummary || '日报执行完成',
      ...(execution.status === 'failed' ? { error: execution.errorSummary } : {}),
      retryCount: 0,
      sendStatus: (sent ? 'success' : execution.status === 'failed' ? 'failed' : 'pending') as ScheduledReportSendStatus,
      notificationStatus: 'not_needed'
    }
  }

  // ---------------------------------------------------------------------------
  // 落盘 / 读盘
  // ---------------------------------------------------------------------------

  private async load(): Promise<void> {
    if (this.legacyTasks && this.legacyExecutions && this.notifications && this.notificationSettings) {
      return
    }
    await fs.mkdir(this.deps.storageDir, { recursive: true })
    const [tasks, executions, notifications, settings] = await Promise.all([
      this.readJson<ScheduledReportTask[]>(TASKS_FILE),
      this.readJson<ScheduledReportExecution[]>(EXECUTIONS_FILE),
      this.readJson<ScheduledReportNotification[]>(NOTIFICATIONS_FILE),
      this.readJson<Partial<ScheduledReportNotificationSettings>>(SETTINGS_FILE)
    ])
    this.legacyTasks = asArray<ScheduledReportTask>(tasks)
    this.legacyExecutions = asArray<ScheduledReportExecution>(executions).map(normalizeExecution)
    this.notifications = asArray<ScheduledReportNotification>(notifications)
    this.notificationSettings = { enabled: settings?.enabled === true }
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.deps.storageDir, file), 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[ScheduledReport] failed to read ${file}:`, error)
      }
      return undefined
    }
  }

  /** **只写通知**：旧 tasks.json / executions.json 已冻结为只读存档。 */
  private async saveNotifications(): Promise<void> {
    await fs.writeFile(
      path.join(this.deps.storageDir, NOTIFICATIONS_FILE),
      JSON.stringify(this.notifications, null, 2),
      'utf8'
    )
  }

  private async saveNotificationSettings(): Promise<void> {
    await fs.writeFile(
      path.join(this.deps.storageDir, SETTINGS_FILE),
      JSON.stringify(this.notificationSettings, null, 2),
      'utf8'
    )
  }
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

const executionStatuses = new Set<ScheduledReportExecution['status']>([
  'running',
  'success',
  'waiting_to_send',
  'partial_success',
  'failed',
  'waiting_for_recovery',
  'skipped'
])

/** 旧存档里的状态收敛：非法值靠「有没有 error」推断，绝不丢记录。 */
const normalizeExecution = (value: ScheduledReportExecution): ScheduledReportExecution => {
  const status = executionStatuses.has(value.status)
    ? value.status
    : value.error
      ? 'failed'
      : 'success'
  const retryCount = Number(value.retryCount)
  return {
    ...value,
    status,
    triggerType: value.triggerType || 'scheduled',
    retryCount: Number.isFinite(retryCount) && retryCount >= 0 ? retryCount : 0
  }
}

export const scheduledReportService = new ScheduledReportService()
