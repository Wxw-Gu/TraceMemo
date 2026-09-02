import { app } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import type {
  PersonalWechatSendCapability,
  PersonalWechatSendRequest
} from '../../shared/personal-wechat'
import type { AgentHubStatus } from '../../shared/agent-hub'
import type {
  ScheduledReportCreateInput,
  ScheduledReportExecution,
  ScheduledReportExecutionStage,
  ScheduledReportMessageType,
  ScheduledReportMemberNameMode,
  ScheduledReportNotification,
  ScheduledReportNotificationCapabilityReason,
  ScheduledReportNotificationCapability,
  ScheduledReportNotificationSettings,
  ScheduledReportNotificationSettingsResult,
  ScheduledReportNotificationSeverity,
  ScheduledReportNotificationType,
  ScheduledReportRange,
  ScheduledReportResult,
  ScheduledReportSendStatus,
  ScheduledReportTask,
  ScheduledReportUpdateInput
} from '../../shared/scheduled-report'
import {
  legacyScheduledReportError,
  normalizeScheduledReportError
} from '../../shared/scheduled-report-error'
import type { SaveGeneratedReportRequest } from '../../shared/report-history'
import { saveGeneratedReport } from '../report-history-service'
import { generateAgentGroupReport } from './agent-group-report-service'
import { personalWechatSendService } from './personal-wechat-send-service'
import { personalWechatCapabilityService } from './personal-wechat-capability-service'
import { getContactAvatars, isReady as isChatReady, resolveMd5 } from './chat-service'
import { agentHubService, type AgentHubNotificationResult } from './agent-hub-service'

const STORAGE_DIR = 'scheduled-reports'
const TASKS_FILE = 'tasks.json'
const EXECUTIONS_FILE = 'executions.json'
const NOTIFICATIONS_FILE = 'notifications.json'
const SETTINGS_FILE = 'settings.json'
const TICK_MS = 15_000
const NOTIFICATION_TEST_MESSAGE = `✅ TraceMemo 定时日报通知已开启

以后定时日报生成或发送出现异常时，
我会通过这里通知你。`

export interface ScheduledReportDependencies {
  getCapability: () => Promise<PersonalWechatSendCapability>
  generateReport: typeof generateAgentGroupReport
  saveGeneratedReport: (
    request: SaveGeneratedReportRequest
  ) => ReturnType<typeof saveGeneratedReport>
  send: (request: PersonalWechatSendRequest) => ReturnType<typeof personalWechatSendService.send>
  sendNotification: (input: { to?: string; text: string }) => Promise<AgentHubNotificationResult>
  getNotificationRecipient: () => string | undefined
  getAgentHubStatus: () => AgentHubStatus
  getContactAvatars?: (usernames: string[]) => Promise<Record<string, string>>
  storageDir: string
  isDatabaseReady: () => boolean
  now?: () => Date
}

const defaultDependencies = (): ScheduledReportDependencies => ({
  getCapability: () => personalWechatCapabilityService.getPersonalWechatSendCapability(),
  generateReport: generateAgentGroupReport,
  saveGeneratedReport,
  send: (request) => personalWechatSendService.send(request),
  sendNotification: (input) => agentHubService.sendNotification(input),
  getNotificationRecipient: () => agentHubService.getNotificationRecipient(),
  getAgentHubStatus: () => agentHubService.getStatus(),
  getContactAvatars: (usernames) => getContactAvatars(usernames),
  storageDir: path.join(app.getPath('userData'), STORAGE_DIR),
  isDatabaseReady: () => isChatReady()
})

const rangeValues = new Set<ScheduledReportRange>(['today', 'yesterday', '7days', 'recent24h'])

const reportRangeLabel = (range: ScheduledReportRange): string =>
  range === 'recent24h'
    ? '最近 24 小时'
    : range === '7days'
      ? '近 7 天'
      : range === 'today'
        ? '今天'
        : '昨日'

interface ScheduledReportNotificationPayload {
  type: ScheduledReportNotificationType
  severity: ScheduledReportNotificationSeverity
  title: string
  message: string
  suggestedAction?: string
}

export function validateScheduleTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim())
}

export function calculateNextRunAt(scheduleTime: string, from = new Date()): string {
  if (!validateScheduleTime(scheduleTime)) throw new Error('执行时间必须是 HH:mm')
  const [hour, minute] = scheduleTime.split(':').map(Number)
  const next = new Date(from)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  return next.toISOString()
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

export class ScheduledReportService {
  private readonly deps: ScheduledReportDependencies
  private tasks: ScheduledReportTask[] | null = null
  private executions: ScheduledReportExecution[] | null = null
  private notifications: ScheduledReportNotification[] | null = null
  private notificationSettings: ScheduledReportNotificationSettings | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly running = new Map<string, Promise<ScheduledReportExecution>>()
  private readonly retrying = new Map<string, Promise<ScheduledReportExecution>>()

  constructor(deps?: Partial<ScheduledReportDependencies>) {
    this.deps = { ...defaultDependencies(), ...deps }
  }

  async start(): Promise<void> {
    await this.load()
    if (this.timer) return
    await this.flushNotifications()
    this.timer = setInterval(() => {
      void this.tick().catch((error) => console.warn('[ScheduledReport] tick failed:', error))
    }, TICK_MS)
    void this.tick().catch((error) => console.warn('[ScheduledReport] initial tick failed:', error))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async listTasks(): Promise<ScheduledReportTask[]> {
    await this.load()
    return this.tasks!.map((task) => ({ ...task }))
  }

  async listExecutions(taskId?: string): Promise<ScheduledReportExecution[]> {
    await this.load()
    const items = taskId
      ? this.executions!.filter((item) => item.taskId === taskId)
      : this.executions!
    return items.map((item) => ({ ...item }))
  }

  async listNotifications(): Promise<ScheduledReportNotification[]> {
    await this.load()
    return this.notifications!.map((notification) => ({ ...notification }))
  }

  async getNotificationSettings(): Promise<ScheduledReportNotificationSettings> {
    await this.load()
    return { ...this.notificationSettings! }
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

  async createTask(
    input: ScheduledReportCreateInput
  ): Promise<ScheduledReportResult<ScheduledReportTask>> {
    const normalized = this.normalizeInput(input)
    if (!normalized.success) return { success: false, error: normalized.error }
    const values = normalized.data!
    await this.load()
    const now = this.deps.now?.() || new Date()
    const task: ScheduledReportTask = {
      id: `scheduled_report_${randomUUID()}`,
      name: values.name,
      group: values.group,
      scheduleTime: values.scheduleTime,
      reportRange: values.reportRange,
      messageTypes: values.messageTypes,
      templateId: values.templateId,
      memberNameMode: values.memberNameMode,
      timeoutSeconds: values.timeoutSeconds,
      target: values.target,
      enabled: values.enabled,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: calculateNextRunAt(values.scheduleTime, now)
    }
    this.tasks!.push(task)
    await this.saveTasks()
    return { success: true, data: { ...task } }
  }

  async updateTask(
    taskId: string,
    input: ScheduledReportUpdateInput
  ): Promise<ScheduledReportResult<ScheduledReportTask>> {
    await this.load()
    const index = this.tasks!.findIndex((task) => task.id === taskId)
    if (index < 0) return { success: false, error: '未找到定时日报任务' }
    const current = this.tasks![index]
    const normalized = this.normalizeInput({ ...current, ...input })
    if (!normalized.success) return { success: false, error: normalized.error }
    const values = normalized.data!
    const now = this.deps.now?.() || new Date()
    const scheduleChanged = values.scheduleTime !== current.scheduleTime
    const updated: ScheduledReportTask = {
      ...current,
      ...values,
      updatedAt: now.toISOString(),
      ...(scheduleChanged ? { nextRunAt: calculateNextRunAt(values.scheduleTime, now) } : {})
    }
    this.tasks![index] = updated
    await this.saveTasks()
    return { success: true, data: { ...updated } }
  }

  async deleteTask(taskId: string): Promise<ScheduledReportResult<{ deletedId: string }>> {
    await this.load()
    const before = this.tasks!.length
    this.tasks = this.tasks!.filter((task) => task.id !== taskId)
    if (this.tasks.length === before) return { success: false, error: '未找到定时日报任务' }
    await this.saveTasks()
    return { success: true, data: { deletedId: taskId } }
  }

  async setTaskEnabled(
    taskId: string,
    enabled: boolean
  ): Promise<ScheduledReportResult<ScheduledReportTask>> {
    if (!enabled) return this.updateTask(taskId, { enabled: false })
    await this.load()
    const task = this.tasks!.find((item) => item.id === taskId)
    if (!task) return { success: false, error: '未找到定时日报任务' }
    const now = this.deps.now?.() || new Date()
    const updated = {
      ...task,
      enabled: true,
      nextRunAt: calculateNextRunAt(task.scheduleTime, now),
      updatedAt: now.toISOString()
    }
    this.tasks![this.tasks!.findIndex((item) => item.id === taskId)] = updated
    await this.saveTasks()
    return { success: true, data: { ...updated } }
  }

  async runScheduledReportNow(
    taskId: string
  ): Promise<ScheduledReportResult<ScheduledReportExecution>> {
    await this.load()
    const task = this.tasks!.find((item) => item.id === taskId)
    if (!task) return { success: false, error: '未找到定时日报任务' }
    const execution = await this.runTask(task)
    return {
      success: execution.status !== 'failed',
      data: execution,
      ...(execution.error ? { error: execution.error } : {})
    }
  }

  async retryScheduledReportSend(
    executionId: string
  ): Promise<ScheduledReportResult<ScheduledReportExecution>> {
    await this.load()
    const execution = this.executions!.find((item) => item.id === executionId)
    if (!execution) return { success: false, error: '未找到定时日报执行记录' }
    const existing = this.retrying.get(executionId)
    if (existing) return { success: true, data: await existing }
    const promise = this.retrySend(execution).finally(() => this.retrying.delete(executionId))
    this.retrying.set(executionId, promise)
    const result = await promise
    return {
      success: result.status !== 'failed',
      data: result,
      ...(result.error ? { error: result.error } : {})
    }
  }

  async testScheduledReportErrorNotification(
    taskId: string
  ): Promise<ScheduledReportResult<ScheduledReportExecution>> {
    await this.load()
    const task = this.tasks!.find((item) => item.id === taskId)
    if (!task) return { success: false, error: '未找到定时日报任务' }
    if (!this.notificationSettings!.enabled) {
      return {
        success: false,
        error: '请先开启微信异常通知，再发送测试错误信息。'
      }
    }

    const now = (this.deps.now?.() || new Date()).toISOString()
    const execution: ScheduledReportExecution = {
      id: `scheduled_report_execution_${randomUUID()}`,
      taskId: task.id,
      triggerType: 'scheduled',
      startedAt: now,
      finishedAt: now,
      status: 'failed',
      currentStage: 'report',
      failedStage: 'report',
      error: 'debug_test_notification:模拟定时日报生成错误',
      errorCode: 'DEBUG_TEST_NOTIFICATION',
      technicalMessage: '这是调试用的模拟错误信息；本次没有调用 AI，也没有生成或发送日报图片。',
      userTitle: '定时日报错误通知测试',
      userMessage: '这是一条调试用的模拟错误通知，用于验证 Agent Hub 推送链路。',
      suggestedAction: '确认微信中是否收到这条测试通知。',
      retryable: false,
      retryCount: 0,
      sendStatus: 'unavailable',
      notificationStatus: 'pending'
    }
    this.executions!.unshift(execution)
    this.executions = this.executions!.slice(0, 500)
    await this.saveExecutions()

    const notified = await this.notifyExecution(task, execution, {
      type: 'failure',
      severity: 'error',
      title: execution.userTitle || '定时日报错误通知测试',
      message:
        execution.userMessage || '这是一条调试用的模拟错误通知，用于验证 Agent Hub 推送链路。',
      suggestedAction: execution.suggestedAction || '确认微信中是否收到这条测试通知。'
    })
    return {
      success: notified.notificationStatus === 'sent',
      data: notified,
      ...(notified.notificationStatus === 'sent'
        ? {}
        : { error: '测试错误已创建，但通知尚未送达。' })
    }
  }

  async tick(at = this.deps.now?.() || new Date()): Promise<void> {
    await this.load()
    await this.flushNotifications()
    if (!this.deps.isDatabaseReady()) return
    const nowMs = at.getTime()
    for (const task of [...this.tasks!]) {
      if (!task.enabled || Date.parse(task.nextRunAt) > nowMs) continue
      const slot = task.nextRunAt
      if (task.lastScheduledSlot === slot) continue
      const slotMs = Date.parse(slot)
      const recentExecution = this.executions!.filter((item) => item.taskId === task.id).sort(
        (left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)
      )[0]
      const executionOverlapsSlot = Boolean(
        recentExecution &&
        Date.parse(recentExecution.startedAt) >= slotMs - 60_000 &&
        Date.parse(recentExecution.startedAt) <= nowMs
      )
      const index = this.tasks!.findIndex((item) => item.id === task.id)
      if (index < 0 || !this.tasks![index].enabled) continue
      const claimed: ScheduledReportTask = {
        ...this.tasks![index],
        lastScheduledSlot: slot,
        nextRunAt: calculateNextRunAt(task.scheduleTime, new Date(nowMs + 60_000)),
        updatedAt: at.toISOString()
      }
      this.tasks![index] = claimed
      await this.saveTasks()
      if (executionOverlapsSlot) continue
      void this.runTask(claimed, slot, 'scheduled').catch((error) =>
        console.warn('[ScheduledReport] execution failed:', error)
      )
    }
  }

  private async runTask(
    task: ScheduledReportTask,
    scheduledSlot?: string,
    triggerType: 'scheduled' | 'manual' = 'manual'
  ): Promise<ScheduledReportExecution> {
    const existing = this.running.get(task.id)
    if (existing) return existing
    const promise = this.executeTask(task, scheduledSlot, triggerType).finally(() =>
      this.running.delete(task.id)
    )
    this.running.set(task.id, promise)
    return promise
  }

  private async executeTask(
    task: ScheduledReportTask,
    scheduledSlot?: string,
    triggerType: 'scheduled' | 'manual' = 'manual'
  ): Promise<ScheduledReportExecution> {
    await this.load()
    const startedAt = (this.deps.now?.() || new Date()).toISOString()
    const execution: ScheduledReportExecution = {
      id: `scheduled_report_execution_${randomUUID()}`,
      taskId: task.id,
      triggerType,
      startedAt,
      status: 'running',
      currentStage: 'precheck',
      retryCount: 0,
      sendStatus: 'pending',
      notificationStatus: 'not_needed',
      ...(scheduledSlot ? { scheduledSlot } : {})
    }
    this.executions!.push(execution)
    await this.saveExecutions()
    const update = async (patch: Partial<ScheduledReportExecution>): Promise<void> => {
      Object.assign(execution, patch)
      await this.persistExecution(execution)
    }
    const finishError = async (
      rawError: unknown,
      fallbackStage: ScheduledReportExecutionStage,
      status: 'failed' | 'waiting_to_send' | 'partial_success' = 'failed',
      patch: Partial<ScheduledReportExecution> = {},
      notificationType: ScheduledReportNotificationType = 'failure',
      code?: string,
      errorStatus?: number,
      errorType?: string
    ): Promise<ScheduledReportExecution> => {
      const normalized = normalizeScheduledReportError(
        {
          error: rawError,
          code,
          status: errorStatus,
          type: errorType,
          stage: fallbackStage
        },
        fallbackStage
      )
      if (normalized.code === 'NO_MESSAGES') {
        return this.finalizeExecution(task, execution, {
          ...patch,
          status: 'skipped',
          currentStage: 'data',
          errorCode: 'NO_MESSAGES',
          userTitle: '暂无可生成的日报',
          userMessage: normalized.userMessage,
          message: normalized.userMessage,
          suggestedAction: normalized.suggestedAction,
          retryable: false,
          sendStatus: 'unavailable',
          notificationStatus: 'not_needed'
        })
      }
      const completed = await this.finalizeExecution(
        task,
        execution,
        {
          ...patch,
          status,
          currentStage: normalized.stage,
          failedStage: normalized.stage,
          error: legacyScheduledReportError(normalized.code, normalized.technicalMessage),
          message: normalized.userMessage,
          errorCode: normalized.code,
          technicalMessage: normalized.technicalMessage,
          userTitle: normalized.userTitle,
          userMessage: normalized.userMessage,
          suggestedAction: normalized.suggestedAction,
          retryable: normalized.retryable
        },
        {
          type: notificationType,
          severity: normalized.severity,
          title: normalized.userTitle,
          message: normalized.userMessage,
          suggestedAction: normalized.suggestedAction
        }
      )
      return completed
    }

    try {
      await update({ currentStage: 'precheck' })
      let capability: PersonalWechatSendCapability | null = null
      let capabilityCheckError = ''

      await update({ currentStage: 'data' })
      await update({ currentStage: 'ai' })
      let generated: Awaited<ReturnType<typeof this.deps.generateReport>>
      try {
        generated = await this.deps.generateReport({
          group: task.group,
          range: task.reportRange,
          messageTypes: task.messageTypes,
          templateId: task.templateId,
          memberNameMode: task.memberNameMode,
          timeoutSeconds: task.timeoutSeconds
        })
      } catch (error) {
        return finishError(error, 'report')
      }
      if (!generated.success || !generated.pngPath) {
        return finishError(
          generated.error || '日报生成失败',
          generated.errorStage || 'report',
          'failed',
          {},
          'failure',
          generated.errorCode,
          generated.errorStatus,
          generated.errorType
        )
      }

      await update({ currentStage: 'persist' })
      const reportContact = resolveMd5(task.group)
      let contactAvatar = reportContact?.avatar
      if (!contactAvatar && reportContact?.m_nsUsrName && this.deps.getContactAvatars) {
        try {
          const avatars = await this.deps.getContactAvatars([reportContact.m_nsUsrName])
          contactAvatar = avatars[reportContact.m_nsUsrName]
        } catch (error) {
          console.warn('[ScheduledReport] failed to hydrate group avatar:', error)
        }
      }
      let savedHistory: Awaited<ReturnType<ScheduledReportDependencies['saveGeneratedReport']>>
      try {
        savedHistory = await this.deps.saveGeneratedReport({
          contactId: reportContact?.md5 || task.group,
          contactName: generated.groupName || reportContact?.m_nsNickName || task.group,
          contactAvatar,
          source: 'scheduled',
          dateRange: generated.reportMetadata?.dateRange || reportRangeLabel(task.reportRange),
          reportDate: generated.reportMetadata?.reportDate,
          messageCount: generated.messageCount ?? generated.reportMetadata?.messageCount ?? 0,
          generatedAt: (this.deps.now?.() || new Date()).toISOString(),
          htmlPath: generated.htmlPath,
          pngPath: generated.pngPath,
          duration: generated.duration,
          modelName: generated.modelName,
          tokenUsage: generated.tokenUsage,
          reportSnapshot: generated.reportSnapshot,
          reportMetadata: generated.reportMetadata,
          templateId: task.templateId
        })
      } catch (error) {
        return finishError(error, 'persist')
      }
      if (!savedHistory.success) {
        return finishError(
          savedHistory.error || '日报历史保存失败',
          'persist',
          'failed',
          {},
          'failure',
          'REPORT_HISTORY_SAVE_FAILED'
        )
      }

      const reportId = savedHistory.record?.id
      const pngPath = savedHistory.record?.pngPath || generated.pngPath
      const htmlPath = savedHistory.record?.htmlPath || generated.htmlPath
      if (!pngPath) {
        return finishError(
          '日报历史未返回可发送的 PNG 文件',
          'persist',
          'failed',
          {},
          'failure',
          'REPORT_HISTORY_SAVE_FAILED'
        )
      }
      await update({ reportId, htmlPath, pngPath, currentStage: 'send' })

      try {
        capability = await this.deps.getCapability()
      } catch (error) {
        capabilityCheckError = error instanceof Error ? error.message : String(error)
      }
      if (!capability?.ready || !capability.capabilities.image) {
        const technicalMessage =
          capabilityCheckError ||
          capability?.error ||
          capability?.message ||
          '个人微信发送能力不可用'
        return finishError(
          technicalMessage,
          'send',
          'waiting_to_send',
          { sendStatus: 'unavailable', sendError: technicalMessage },
          'partial_success',
          'WECHAT_SEND_UNAVAILABLE'
        )
      }

      const target = this.resolveTarget(task)
      if (!target) {
        return finishError(
          '未找到指定微信群',
          'send',
          'partial_success',
          { sendStatus: 'failed', sendError: '未找到指定微信群' },
          'partial_success',
          'WECHAT_SEND_FAILED'
        )
      }
      await update({ sendTarget: target, currentStage: 'send' })
      let sent: Awaited<ReturnType<ScheduledReportDependencies['send']>>
      try {
        sent = await this.deps.send({
          type: 'image',
          to: target,
          isGroup: true,
          filePath: pngPath
        })
      } catch (error) {
        return finishError(
          error,
          'send',
          'partial_success',
          {
            sendStatus: 'failed',
            sendError: error instanceof Error ? error.message : String(error)
          },
          'partial_success',
          'WECHAT_SEND_FAILED'
        )
      }
      if (!sent.success) {
        return finishError(
          sent.error || '微信发送失败',
          'send',
          'partial_success',
          { sendStatus: 'failed', sendError: sent.error || '微信发送失败' },
          'partial_success',
          'WECHAT_SEND_FAILED'
        )
      }
      return this.finalizeExecution(task, execution, {
        status: 'success',
        currentStage: 'send',
        sendTarget: target,
        sendStatus: 'success',
        notificationStatus: 'not_needed',
        message: '日报生成成功，微信发送成功'
      })
    } catch (error) {
      return finishError(error, execution.currentStage || 'report')
    }
  }

  private async retrySend(original: ScheduledReportExecution): Promise<ScheduledReportExecution> {
    const task = this.tasks!.find((item) => item.id === original.taskId)
    if (!task) return original
    const retryCount = (original.retryCount || 0) + 1
    const working: ScheduledReportExecution = {
      ...original,
      status: 'running',
      currentStage: 'send',
      retryCount,
      sendStatus: 'pending'
    }
    await this.persistExecution(working)

    const finishRetryError = async (
      rawError: unknown,
      code: string,
      sendStatus: ScheduledReportSendStatus,
      preferredStatus: 'waiting_to_send' | 'partial_success'
    ): Promise<ScheduledReportExecution> => {
      const normalized = normalizeScheduledReportError(
        { error: rawError, code, stage: 'send' },
        'send'
      )
      return this.finalizeExecution(task, working, {
        status: preferredStatus,
        currentStage: normalized.stage,
        failedStage: normalized.stage,
        error: legacyScheduledReportError(normalized.code, normalized.technicalMessage),
        message: normalized.userMessage,
        errorCode: normalized.code,
        technicalMessage: normalized.technicalMessage,
        userTitle: normalized.userTitle,
        userMessage: normalized.userMessage,
        suggestedAction: normalized.suggestedAction,
        retryable: normalized.retryable,
        retryCount,
        sendStatus,
        sendError: normalized.technicalMessage
      })
    }

    if (!working.pngPath) {
      return finishRetryError(
        '执行记录缺少已保存的 PNG 文件',
        'REPORT_HISTORY_SAVE_FAILED',
        'failed',
        'partial_success'
      )
    }

    let capability: PersonalWechatSendCapability | null = null
    try {
      capability = await this.deps.getCapability()
    } catch (error) {
      return finishRetryError(error, 'WECHAT_SEND_UNAVAILABLE', 'unavailable', 'waiting_to_send')
    }
    if (!capability.ready || !capability.capabilities.image) {
      return finishRetryError(
        capability.error || capability.message || '个人微信发送能力不可用',
        'WECHAT_SEND_UNAVAILABLE',
        'unavailable',
        'waiting_to_send'
      )
    }

    const target = working.sendTarget || this.resolveTarget(task)
    if (!target) {
      return finishRetryError('未找到指定微信群', 'WECHAT_SEND_FAILED', 'failed', 'partial_success')
    }
    try {
      const sent = await this.deps.send({
        type: 'image',
        to: target,
        isGroup: true,
        filePath: working.pngPath
      })
      if (!sent.success) {
        return finishRetryError(
          sent.error || '微信发送失败',
          'WECHAT_SEND_FAILED',
          'failed',
          'partial_success'
        )
      }
    } catch (error) {
      return finishRetryError(error, 'WECHAT_SEND_FAILED', 'failed', 'partial_success')
    }

    const previousStatus = original.status
    const cleared = this.clearFailureFields(working, {
      status: 'success',
      currentStage: 'send',
      sendTarget: target,
      sendStatus: 'success',
      retryCount,
      message: '日报生成成功，微信发送成功',
      notificationStatus: original.notificationStatus || 'not_needed'
    })
    const completed = await this.finalizeExecution(task, cleared, {})
    if (previousStatus === 'waiting_to_send' || previousStatus === 'partial_success') {
      return this.notifyExecution(task, completed, {
        type: 'recovery',
        severity: 'info',
        title: `${task.name} 已恢复`,
        message: '刚才未发送的日报已经成功发送。'
      })
    }
    return completed
  }

  private clearFailureFields(
    execution: ScheduledReportExecution,
    patch: Partial<ScheduledReportExecution>
  ): ScheduledReportExecution {
    const next = { ...execution, ...patch }
    delete next.error
    delete next.failedStage
    delete next.errorCode
    delete next.technicalMessage
    delete next.userTitle
    delete next.userMessage
    delete next.suggestedAction
    delete next.retryable
    delete next.sendError
    return next
  }

  private async finalizeExecution(
    task: ScheduledReportTask,
    execution: ScheduledReportExecution,
    patch: Partial<ScheduledReportExecution>,
    notification?: ScheduledReportNotificationPayload
  ): Promise<ScheduledReportExecution> {
    const completed: ScheduledReportExecution = {
      ...execution,
      ...patch,
      finishedAt: (this.deps.now?.() || new Date()).toISOString()
    }
    await this.persistExecution(completed)
    const taskIndex = this.tasks!.findIndex((item) => item.id === task.id)
    if (taskIndex >= 0) {
      this.tasks![taskIndex] = {
        ...this.tasks![taskIndex],
        lastRunAt: completed.finishedAt,
        updatedAt: completed.finishedAt!
      }
      await this.saveTasks()
    }
    if (notification) return this.notifyExecution(task, completed, notification)
    return { ...completed }
  }

  private async persistExecution(execution: ScheduledReportExecution): Promise<void> {
    const index = this.executions!.findIndex((item) => item.id === execution.id)
    if (index >= 0) this.executions![index] = { ...execution }
    else this.executions!.push({ ...execution })
    await this.saveExecutions()
  }

  private async notifyExecution(
    task: ScheduledReportTask,
    execution: ScheduledReportExecution,
    payload: ScheduledReportNotificationPayload
  ): Promise<ScheduledReportExecution> {
    await this.load()
    if (
      execution.triggerType !== 'scheduled' ||
      execution.status === 'skipped' ||
      !this.notificationSettings!.enabled
    ) {
      if (execution.notificationStatus !== 'not_needed') {
        const updated = { ...execution, notificationStatus: 'not_needed' as const }
        await this.persistExecution(updated)
        return updated
      }
      return { ...execution }
    }
    let notification: ScheduledReportNotification
    try {
      notification = await this.enqueueNotification(task, execution, payload)
    } catch (error) {
      notification = {
        id: `scheduled_report_notification_${randomUUID()}`,
        executionId: execution.id,
        taskId: task.id,
        type: payload.type,
        severity: payload.severity,
        title: payload.title,
        message: payload.message,
        dedupeKey: `${execution.id}:${payload.type}`,
        channel: 'agent_hub',
        status: 'failed',
        createdAt: (this.deps.now?.() || new Date()).toISOString(),
        attempts: 0,
        lastError: error instanceof Error ? error.message : String(error)
      }
    }
    const updated: ScheduledReportExecution = {
      ...execution,
      currentStage: 'notify',
      notificationStatus: notification.status
    }
    await this.persistExecution(updated)
    return { ...updated }
  }

  private async enqueueNotification(
    task: ScheduledReportTask,
    execution: ScheduledReportExecution,
    payload: ScheduledReportNotificationPayload
  ): Promise<ScheduledReportNotification> {
    await this.load()
    const dedupeKey = `${execution.id}:${payload.type}`
    const existing = this.notifications!.find((item) => item.dedupeKey === dedupeKey)
    if (existing) return { ...existing }
    let recipient: string | undefined
    try {
      recipient = this.deps.getNotificationRecipient()
    } catch {
      recipient = undefined
    }
    const notification: ScheduledReportNotification = {
      id: `scheduled_report_notification_${randomUUID()}`,
      executionId: execution.id,
      taskId: task.id,
      type: payload.type,
      severity: payload.severity,
      title: payload.title,
      message: payload.message,
      dedupeKey,
      channel: 'agent_hub',
      ...(recipient ? { recipient } : {}),
      status: 'pending',
      createdAt: (this.deps.now?.() || new Date()).toISOString(),
      attempts: 0
    }
    this.notifications!.unshift(notification)
    this.notifications = this.notifications!.slice(0, 500)
    await this.saveNotifications()
    if (recipient) await this.tryDeliverNotification(notification, payload, task)
    return { ...notification }
  }

  private async tryDeliverNotification(
    notification: ScheduledReportNotification,
    payload?: ScheduledReportNotificationPayload,
    task?: ScheduledReportTask
  ): Promise<void> {
    if (notification.status === 'sent') return
    await this.load()
    const execution = this.executions!.find((item) => item.id === notification.executionId)
    if (
      !this.notificationSettings!.enabled ||
      execution?.triggerType === 'manual' ||
      execution?.status === 'skipped'
    ) {
      notification.status = 'suppressed'
      notification.suppressedAt = (this.deps.now?.() || new Date()).toISOString()
      notification.lastError = '定时日报微信异常通知已关闭或不适用于本次执行。'
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
          task?.name || '定时日报',
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
    for (const notification of pending) {
      const task = this.tasks!.find((item) => item.id === notification.taskId)
      await this.tryDeliverNotification(notification, undefined, task)
      const execution = this.executions!.find((item) => item.id === notification.executionId)
      if (execution) {
        execution.notificationStatus = notification.status
        await this.persistExecution(execution)
      }
    }
  }

  private async suppressPendingNotifications(): Promise<void> {
    await this.load()
    const pending = this.notifications!.filter((item) => item.status === 'pending')
    if (!pending.length) return
    const suppressedAt = (this.deps.now?.() || new Date()).toISOString()
    const executionIds = new Set<string>()
    for (const notification of pending) {
      notification.status = 'suppressed'
      notification.suppressedAt = suppressedAt
      notification.lastError = '定时日报微信异常通知已关闭。'
      executionIds.add(notification.executionId)
    }
    for (const execution of this.executions!) {
      if (executionIds.has(execution.id) && execution.notificationStatus === 'pending') {
        execution.notificationStatus = 'suppressed'
      }
    }
    await Promise.all([this.saveNotifications(), this.saveExecutions()])
  }

  private notificationCapabilityReasonForSend(
    result: AgentHubNotificationResult
  ): ScheduledReportNotificationCapabilityReason {
    if (result.status === 'recipient_unavailable') return 'recipient_not_bound'
    if (result.status === 'connector_offline') return 'connector_offline'
    return 'send_failed'
  }

  private notificationText(
    taskName: string,
    severity: ScheduledReportNotificationSeverity,
    title: string,
    message: string,
    suggestedAction?: string
  ): string {
    const icon = severity === 'error' ? '❌' : severity === 'warning' ? '⚠️' : '✅'
    return [
      `${icon} ${taskName}`,
      title,
      message,
      suggestedAction ? `建议：${suggestedAction}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  }

  private resolveTarget(task: ScheduledReportTask): string | undefined {
    const explicit = String(task.target || '').trim()
    if (explicit.endsWith('@chatroom')) return explicit
    const contact = resolveMd5(task.group || explicit)
    return contact?.m_nsUsrName?.endsWith('@chatroom') ? contact.m_nsUsrName : undefined
  }

  private normalizeInput(input: ScheduledReportCreateInput): ScheduledReportResult<{
    name: string
    group: string
    scheduleTime: string
    reportRange: ScheduledReportRange
    messageTypes: ScheduledReportMessageType[]
    templateId: ScheduledReportTask['templateId']
    memberNameMode: ScheduledReportMemberNameMode
    timeoutSeconds: number
    target: string
    enabled: boolean
  }> {
    const name = String(input.name || '').trim()
    const group = String(input.group || '').trim()
    const scheduleTime = String(input.scheduleTime || '').trim()
    const reportRange = input.reportRange || 'yesterday'
    const messageTypes: ScheduledReportMessageType[] = input.messageTypes?.length
      ? input.messageTypes
      : ['text']
    const templateId = input.templateId || 'v1'
    const memberNameMode = input.memberNameMode || 'groupNickname'
    const timeoutSeconds = Math.max(
      30,
      Math.min(1800, Math.round(Number(input.timeoutSeconds) || 300))
    )
    const target = String(input.target || group).trim()
    if (!name) return { success: false, error: '日报名称不能为空' }
    if (!group) return { success: false, error: '微信群不能为空' }
    if (!validateScheduleTime(scheduleTime))
      return { success: false, error: '执行时间必须是 HH:mm' }
    if (!rangeValues.has(reportRange)) return { success: false, error: '日报范围不受支持' }
    return {
      success: true,
      data: {
        name,
        group,
        scheduleTime,
        reportRange,
        messageTypes,
        templateId,
        memberNameMode,
        timeoutSeconds,
        target,
        enabled: input.enabled !== false
      }
    }
  }

  private async load(): Promise<void> {
    if (this.tasks && this.executions && this.notifications && this.notificationSettings) return
    await fs.mkdir(this.deps.storageDir, { recursive: true })
    const [tasks, executions, notifications, settings] = await Promise.all([
      this.readJson<ScheduledReportTask[]>(TASKS_FILE),
      this.readJson<ScheduledReportExecution[]>(EXECUTIONS_FILE),
      this.readJson<ScheduledReportNotification[]>(NOTIFICATIONS_FILE),
      this.readJson<Partial<ScheduledReportNotificationSettings>>(SETTINGS_FILE)
    ])
    this.tasks = asArray<ScheduledReportTask>(tasks)
    this.executions = asArray<ScheduledReportExecution>(executions).map(normalizeExecution)
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

  private async saveTasks(): Promise<void> {
    await fs.writeFile(
      path.join(this.deps.storageDir, TASKS_FILE),
      JSON.stringify(this.tasks, null, 2),
      'utf8'
    )
  }

  private async saveExecutions(): Promise<void> {
    await fs.writeFile(
      path.join(this.deps.storageDir, EXECUTIONS_FILE),
      JSON.stringify(this.executions, null, 2),
      'utf8'
    )
  }

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

export const scheduledReportService = new ScheduledReportService()
