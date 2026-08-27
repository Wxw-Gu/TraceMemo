import { app } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import type {
  PersonalWechatSendCapability,
  PersonalWechatSendRequest
} from '../../shared/personal-wechat'
import type {
  ScheduledReportCreateInput,
  ScheduledReportExecution,
  ScheduledReportRange,
  ScheduledReportResult,
  ScheduledReportTask,
  ScheduledReportUpdateInput
} from '../../shared/scheduled-report'
import { generateAgentGroupReport } from './agent-group-report-service'
import { personalWechatSendService } from './personal-wechat-send-service'
import { personalWechatCapabilityService } from './personal-wechat-capability-service'
import { isReady as isChatReady, resolveMd5 } from './chat-service'

const STORAGE_DIR = 'scheduled-reports'
const TASKS_FILE = 'tasks.json'
const EXECUTIONS_FILE = 'executions.json'
const TICK_MS = 15_000

export interface ScheduledReportDependencies {
  getCapability: () => Promise<PersonalWechatSendCapability>
  generateReport: typeof generateAgentGroupReport
  send: (request: PersonalWechatSendRequest) => ReturnType<typeof personalWechatSendService.send>
  storageDir: string
  isDatabaseReady: () => boolean
  now?: () => Date
}

const defaultDependencies = (): ScheduledReportDependencies => ({
  getCapability: () => personalWechatCapabilityService.getPersonalWechatSendCapability(),
  generateReport: generateAgentGroupReport,
  send: (request) => personalWechatSendService.send(request),
  storageDir: path.join(app.getPath('userData'), STORAGE_DIR),
  isDatabaseReady: () => isChatReady()
})

const rangeValues = new Set<ScheduledReportRange>(['yesterday', 'recent24h'])

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

export class ScheduledReportService {
  private readonly deps: ScheduledReportDependencies
  private tasks: ScheduledReportTask[] | null = null
  private executions: ScheduledReportExecution[] | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly running = new Map<string, Promise<ScheduledReportExecution>>()

  constructor(deps?: Partial<ScheduledReportDependencies>) {
    this.deps = { ...defaultDependencies(), ...deps }
  }

  async start(): Promise<void> {
    await this.load()
    if (this.timer) return
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

  async createTask(
    input: ScheduledReportCreateInput
  ): Promise<ScheduledReportResult<ScheduledReportTask>> {
    const capability = await this.deps.getCapability()
    if (!capability.ready) return { success: false, error: this.creationError(capability) }
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
      success: execution.status === 'success',
      data: execution,
      ...(execution.error ? { error: execution.error } : {})
    }
  }

  async tick(at = this.deps.now?.() || new Date()): Promise<void> {
    await this.load()
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
      void this.runTask(claimed, slot).catch((error) =>
        console.warn('[ScheduledReport] execution failed:', error)
      )
    }
  }

  private async runTask(
    task: ScheduledReportTask,
    scheduledSlot?: string
  ): Promise<ScheduledReportExecution> {
    const existing = this.running.get(task.id)
    if (existing) return existing
    const promise = this.executeTask(task, scheduledSlot).finally(() =>
      this.running.delete(task.id)
    )
    this.running.set(task.id, promise)
    return promise
  }

  private async executeTask(
    task: ScheduledReportTask,
    scheduledSlot?: string
  ): Promise<ScheduledReportExecution> {
    await this.load()
    const startedAt = (this.deps.now?.() || new Date()).toISOString()
    const execution: ScheduledReportExecution = {
      id: `scheduled_report_execution_${randomUUID()}`,
      taskId: task.id,
      startedAt,
      status: 'running',
      ...(scheduledSlot ? { scheduledSlot } : {})
    }
    this.executions!.push(execution)
    await this.saveExecutions()
    const finish = async (
      status: ScheduledReportExecution['status'],
      error?: string,
      message?: string
    ): Promise<ScheduledReportExecution> => {
      const completed: ScheduledReportExecution = {
        ...execution,
        status,
        finishedAt: (this.deps.now?.() || new Date()).toISOString(),
        ...(error ? { error } : {}),
        ...(message ? { message } : {})
      }
      const index = this.executions!.findIndex((item) => item.id === execution.id)
      if (index >= 0) this.executions![index] = completed
      await this.saveExecutions()
      const taskIndex = this.tasks!.findIndex((item) => item.id === task.id)
      if (taskIndex >= 0) {
        this.tasks![taskIndex] = {
          ...this.tasks![taskIndex],
          ...(status !== 'running' ? { lastRunAt: completed.finishedAt } : {}),
          updatedAt: completed.finishedAt!
        }
        await this.saveTasks()
      }
      return completed
    }

    try {
      const capability = await this.deps.getCapability()
      if (!capability.ready) {
        return finish('failed', `wechat_not_ready:${capability.status}`, capability.message)
      }
      let generated: Awaited<ReturnType<typeof this.deps.generateReport>>
      try {
        generated = await this.deps.generateReport({ group: task.group, range: task.reportRange })
      } catch (error) {
        return finish(
          'failed',
          `report_generation_failed:${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (!generated.success || !generated.pngPath) {
        return finish('failed', `report_generation_failed:${generated.error || '日报生成失败'}`)
      }
      const target = this.resolveTarget(task)
      if (!target) return finish('failed', 'wechat_send_failed:未找到指定微信群')
      let sent: Awaited<ReturnType<typeof this.deps.send>>
      try {
        sent = await this.deps.send({
          type: 'image',
          to: target,
          isGroup: true,
          filePath: generated.pngPath
        })
      } catch (error) {
        return finish(
          'failed',
          `wechat_send_failed:${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (!sent.success)
        return finish('failed', `wechat_send_failed:${sent.error || '微信发送失败'}`)
      return finish('success', undefined, '日报生成成功，微信发送成功')
    } catch (error) {
      return finish(
        'failed',
        `wechat_not_ready:${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private resolveTarget(task: ScheduledReportTask): string | undefined {
    const explicit = String(task.target || '').trim()
    if (explicit.endsWith('@chatroom')) return explicit
    const contact = resolveMd5(task.group || explicit)
    return contact?.m_nsUsrName?.endsWith('@chatroom') ? contact.m_nsUsrName : undefined
  }

  private creationError(capability: PersonalWechatSendCapability): string {
    if (capability.status === 'unsupported') return '微信消息发送目前仅支持 macOS'
    if (capability.status === 'needs_binding' || capability.status === 'unconfigured')
      return '请先绑定个人微信'
    if (capability.status === 'needs_verification') return '请先完成微信消息能力检测'
    return capability.error || capability.message || '个人微信发送能力异常'
  }

  private normalizeInput(input: ScheduledReportCreateInput): ScheduledReportResult<{
    name: string
    group: string
    scheduleTime: string
    reportRange: ScheduledReportRange
    target: string
    enabled: boolean
  }> {
    const name = String(input.name || '').trim()
    const group = String(input.group || '').trim()
    const scheduleTime = String(input.scheduleTime || '').trim()
    const reportRange = input.reportRange || 'yesterday'
    const target = String(input.target || group).trim()
    if (!name) return { success: false, error: '日报名称不能为空' }
    if (!group) return { success: false, error: '微信群不能为空' }
    if (!validateScheduleTime(scheduleTime))
      return { success: false, error: '执行时间必须是 HH:mm' }
    if (!rangeValues.has(reportRange)) return { success: false, error: '日报范围不受支持' }
    return {
      success: true,
      data: { name, group, scheduleTime, reportRange, target, enabled: input.enabled !== false }
    }
  }

  private async load(): Promise<void> {
    if (this.tasks && this.executions) return
    await fs.mkdir(this.deps.storageDir, { recursive: true })
    const [tasks, executions] = await Promise.all([
      this.readJson<ScheduledReportTask[]>(TASKS_FILE),
      this.readJson<ScheduledReportExecution[]>(EXECUTIONS_FILE)
    ])
    this.tasks = asArray<ScheduledReportTask>(tasks)
    this.executions = asArray<ScheduledReportExecution>(executions)
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
}

export const scheduledReportService = new ScheduledReportService()
