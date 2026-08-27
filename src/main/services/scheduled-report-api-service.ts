import type { PersonalWechatSendCapability } from '../../shared/personal-wechat'
import type {
  ScheduledReportApiCreateRequest,
  ScheduledReportApiExecution,
  ScheduledReportApiGroupRef,
  ScheduledReportApiTargetRef,
  ScheduledReportApiTask,
  ScheduledReportApiUpdateRequest
} from '../../shared/scheduled-report-api'
import type {
  ScheduledReportExecution,
  ScheduledReportRange,
  ScheduledReportTask,
  ScheduledReportUpdateInput
} from '../../shared/scheduled-report'
import type { FormattedContact } from './chat-service'
import { resolveContact } from './contact-resolution-service'
import type { ScheduledReportService } from './scheduled-report-service'

export interface ScheduledReportApiDependencies {
  service: Pick<
    ScheduledReportService,
    | 'listTasks'
    | 'listExecutions'
    | 'createTask'
    | 'updateTask'
    | 'deleteTask'
    | 'setTaskEnabled'
    | 'runScheduledReportNow'
  >
  getCapability: () => Promise<PersonalWechatSendCapability>
  listContacts: () => FormattedContact[]
  isDatabaseReady: () => boolean
  platform?: NodeJS.Platform
}

export class ScheduledReportApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'ScheduledReportApiError'
  }
}

const REPORT_RANGES = new Set<ScheduledReportRange>(['today', 'yesterday', '7days', 'recent24h'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const asTrimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function publicCapability(capability: PersonalWechatSendCapability): Record<string, unknown> {
  return {
    supported: capability.supported,
    ready: capability.ready,
    status: capability.status,
    capabilities: capability.capabilities,
    message: capability.message,
    ...(capability.error ? { error: capability.error } : {})
  }
}

export class ScheduledReportApiService {
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: ScheduledReportApiDependencies) {}

  async getCapability(): Promise<Record<string, unknown>> {
    try {
      return publicCapability(this.applyPlatformCapability(await this.deps.getCapability()))
    } catch (error) {
      throw new ScheduledReportApiError(
        503,
        'wechat_capability_unavailable',
        '微信发送能力检测失败，请在 TraceMemo 设置中检查个人微信。',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  async list(): Promise<ScheduledReportApiTask[]> {
    this.assertDatabaseReady()
    return (await this.deps.service.listTasks()).map((task) => this.toPublicTask(task))
  }

  async get(taskId: string): Promise<ScheduledReportApiTask> {
    this.assertDatabaseReady()
    const task = await this.findTask(taskId)
    if (!task) throw new ScheduledReportApiError(404, 'not_found', '未找到定时日报任务')
    return this.toPublicTask(task)
  }

  async create(request: ScheduledReportApiCreateRequest): Promise<ScheduledReportApiTask> {
    return this.withMutationLock(() => this.createUnlocked(request))
  }

  private async createUnlocked(
    request: ScheduledReportApiCreateRequest
  ): Promise<ScheduledReportApiTask> {
    this.assertDatabaseReady()
    await this.assertCapabilityReady()
    if (!isRecord(request))
      throw new ScheduledReportApiError(400, 'invalid_request', '请求体格式无效')

    const groupRef = request.group
    if (!(typeof groupRef === 'string' || isRecord(groupRef))) {
      throw new ScheduledReportApiError(400, 'invalid_group', 'group 需要提供 name 或 talker')
    }
    const group = this.resolveGroup(groupRef as ScheduledReportApiGroupRef | string)
    const targetRef = request.target
    if (targetRef !== undefined && !isRecord(targetRef)) {
      throw new ScheduledReportApiError(400, 'invalid_target', 'target 格式无效')
    }
    const target = this.resolveTarget(targetRef as ScheduledReportApiTargetRef | undefined, group)
    const schedule = this.parseSchedule(request.schedule)
    const reportRange = this.parseRange(request.reportRange)
    const name = asTrimmed(request.name) || `${group.m_nsNickName} · 每日日报`
    const enabled = request.enabled !== false

    const duplicate = await this.findDuplicate({
      group: group.md5,
      target: target.m_nsUsrName,
      scheduleTime: schedule.time,
      reportRange,
      enabled
    })
    if (duplicate) {
      throw new ScheduledReportApiError(409, 'duplicate', '相同的定时日报任务已经存在', {
        existingTaskId: duplicate.id,
        task: this.toPublicTask(duplicate)
      })
    }

    const result = await this.deps.service.createTask({
      name,
      group: group.md5,
      target: target.m_nsUsrName,
      scheduleTime: schedule.time,
      reportRange,
      enabled
    })
    if (!result.success || !result.data) {
      throw new ScheduledReportApiError(400, 'invalid_request', result.error || '定时日报创建失败')
    }
    return this.toPublicTask(result.data)
  }

  async update(
    taskId: string,
    request: ScheduledReportApiUpdateRequest
  ): Promise<ScheduledReportApiTask> {
    return this.withMutationLock(() => this.updateUnlocked(taskId, request))
  }

  private async updateUnlocked(
    taskId: string,
    request: ScheduledReportApiUpdateRequest
  ): Promise<ScheduledReportApiTask> {
    this.assertDatabaseReady()
    const current = await this.findTask(taskId)
    if (!current) throw new ScheduledReportApiError(404, 'not_found', '未找到定时日报任务')
    if (!isRecord(request))
      throw new ScheduledReportApiError(400, 'invalid_request', '请求体格式无效')

    const currentGroup = this.contactForTask(current)
    let group = currentGroup
    if (request.group !== undefined) {
      if (!(typeof request.group === 'string' || isRecord(request.group))) {
        throw new ScheduledReportApiError(400, 'invalid_group', 'group 需要提供 name 或 talker')
      }
      group = this.resolveGroup(request.group as ScheduledReportApiGroupRef | string)
    }
    if (request.target !== undefined && !isRecord(request.target)) {
      throw new ScheduledReportApiError(400, 'invalid_target', 'target 格式无效')
    }
    const target =
      request.target === undefined
        ? group
        : this.resolveTarget(request.target as unknown as ScheduledReportApiTargetRef, group)
    const schedule =
      request.schedule === undefined
        ? { type: 'daily' as const, time: current.scheduleTime }
        : this.parseSchedule(request.schedule)
    const reportRange =
      request.reportRange === undefined ? current.reportRange : this.parseRange(request.reportRange)
    const enabled = request.enabled === undefined ? current.enabled : Boolean(request.enabled)
    const name = request.name === undefined ? current.name : asTrimmed(request.name)
    if (!name) throw new ScheduledReportApiError(400, 'invalid_request', '日报名称不能为空')

    const duplicate = await this.findDuplicate(
      {
        group: group.md5,
        target: target.m_nsUsrName,
        scheduleTime: schedule.time,
        reportRange,
        enabled
      },
      taskId
    )
    if (duplicate) {
      throw new ScheduledReportApiError(409, 'duplicate', '相同的定时日报任务已经存在', {
        existingTaskId: duplicate.id,
        task: this.toPublicTask(duplicate)
      })
    }

    const patch: ScheduledReportUpdateInput = {
      name,
      group: group.md5,
      target: target.m_nsUsrName,
      scheduleTime: schedule.time,
      reportRange,
      enabled
    }
    const result = await this.deps.service.updateTask(taskId, patch)
    if (!result.success || !result.data) {
      throw new ScheduledReportApiError(400, 'invalid_request', result.error || '定时日报更新失败')
    }
    return this.toPublicTask(result.data)
  }

  async delete(taskId: string): Promise<{ deletedId: string }> {
    this.assertDatabaseReady()
    const result = await this.deps.service.deleteTask(taskId)
    if (!result.success || !result.data) {
      throw new ScheduledReportApiError(404, 'not_found', result.error || '未找到定时日报任务')
    }
    return result.data
  }

  async setEnabled(taskId: string, enabled: boolean): Promise<ScheduledReportApiTask> {
    this.assertDatabaseReady()
    const result = await this.deps.service.setTaskEnabled(taskId, enabled)
    if (!result.success || !result.data) {
      throw new ScheduledReportApiError(404, 'not_found', result.error || '未找到定时日报任务')
    }
    return this.toPublicTask(result.data)
  }

  async run(taskId: string): Promise<ScheduledReportExecution> {
    this.assertDatabaseReady()
    const result = await this.deps.service.runScheduledReportNow(taskId)
    if (!result.data) {
      throw new ScheduledReportApiError(404, 'not_found', result.error || '未找到定时日报任务')
    }
    return result.data
  }

  async executions(taskId: string): Promise<ScheduledReportApiExecution[]> {
    this.assertDatabaseReady()
    const task = await this.findTask(taskId)
    if (!task) throw new ScheduledReportApiError(404, 'not_found', '未找到定时日报任务')
    return (await this.deps.service.listExecutions(taskId)).map((execution) => ({ ...execution }))
  }

  private assertDatabaseReady(): void {
    if (!this.deps.isDatabaseReady()) {
      throw new ScheduledReportApiError(503, 'database_not_ready', 'TraceMemo 数据库未初始化')
    }
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue
    let release!: () => void
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async assertCapabilityReady(): Promise<void> {
    let capability: PersonalWechatSendCapability
    try {
      capability = this.applyPlatformCapability(await this.deps.getCapability())
    } catch (error) {
      throw new ScheduledReportApiError(
        503,
        'wechat_capability_unavailable',
        '微信发送能力检测失败，请在 TraceMemo 设置中检查个人微信。',
        error instanceof Error ? error.message : String(error)
      )
    }
    if (capability.ready && capability.capabilities.image) return
    throw new ScheduledReportApiError(
      409,
      'wechat_not_ready',
      capability.message || 'TraceMemo 当前还没有完成微信消息发送能力配置',
      { capability: publicCapability(capability) }
    )
  }

  private applyPlatformCapability(
    capability: PersonalWechatSendCapability
  ): PersonalWechatSendCapability {
    if ((this.deps.platform || process.platform) === 'darwin') return capability
    return {
      ...capability,
      supported: false,
      ready: false,
      status: 'unsupported',
      capabilities: { text: false, image: false, voice: false },
      message: '微信消息发送目前仅支持 macOS'
    }
  }

  private async findTask(taskId: string): Promise<ScheduledReportTask | undefined> {
    const normalized = asTrimmed(taskId)
    if (!normalized) return undefined
    return (await this.deps.service.listTasks()).find((task) => task.id === normalized)
  }

  private resolveGroup(ref: ScheduledReportApiGroupRef | string): FormattedContact {
    const contacts = this.deps.listContacts().filter((contact) => contact.type === 'group')
    const query = typeof ref === 'string' ? ref : isRecord(ref) ? asTrimmed(ref.name) : ''
    const talker = typeof ref === 'string' ? '' : isRecord(ref) ? asTrimmed(ref.talker) : ''
    if (!query && !talker) {
      throw new ScheduledReportApiError(400, 'invalid_group', 'group 需要提供 name 或 talker')
    }
    if (talker) {
      const direct = contacts.find(
        (contact) => contact.m_nsUsrName === talker || contact.md5 === talker
      )
      if (direct) return direct
      throw new ScheduledReportApiError(404, 'group_not_found', '未找到 talker 对应的唯一群聊')
    }
    const resolution = resolveContact(query || talker, contacts, 'group')
    if (resolution.ambiguous) {
      throw new ScheduledReportApiError(
        409,
        'group_ambiguous',
        '群聊名称匹配到多个群，请先确认目标群聊',
        {
          candidates: resolution.candidates
        }
      )
    }
    if (!resolution.matched || !resolution.conversationId) {
      throw new ScheduledReportApiError(404, 'group_not_found', '未找到唯一的目标群聊')
    }
    const contact = contacts.find((item) => item.md5 === resolution.conversationId)
    if (!contact) throw new ScheduledReportApiError(404, 'group_not_found', '未找到唯一的目标群聊')
    return contact
  }

  private resolveTarget(
    ref: ScheduledReportApiTargetRef | undefined,
    group: FormattedContact
  ): FormattedContact {
    if (!ref) return group
    if (!isRecord(ref) || ref.type !== 'wechat_group') {
      throw new ScheduledReportApiError(400, 'invalid_target', 'target.type 必须是 wechat_group')
    }
    const talker = asTrimmed(ref.talker)
    const name = asTrimmed(ref.name)
    const target = this.resolveGroup({ talker, name })
    if (target.md5 !== group.md5) {
      throw new ScheduledReportApiError(400, 'target_mismatch', '发送目标必须是选择的微信群')
    }
    return target
  }

  private parseSchedule(value: unknown): { type: 'daily'; time: string } {
    if (!isRecord(value) || value.type !== 'daily' || !asTrimmed(value.time)) {
      throw new ScheduledReportApiError(
        400,
        'invalid_schedule',
        'schedule 目前只支持 { type: "daily", time: "HH:mm" }'
      )
    }
    const time = asTrimmed(value.time)
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new ScheduledReportApiError(400, 'invalid_schedule', 'schedule.time 必须是 HH:mm')
    }
    return { type: 'daily', time }
  }

  private parseRange(value: unknown): ScheduledReportRange {
    const range = value === undefined ? 'yesterday' : value
    if (typeof range !== 'string' || !REPORT_RANGES.has(range as ScheduledReportRange)) {
      throw new ScheduledReportApiError(400, 'invalid_report_range', 'reportRange 不受支持')
    }
    return range as ScheduledReportRange
  }

  private contactForTask(task: ScheduledReportTask): FormattedContact {
    const contacts = this.deps.listContacts().filter((contact) => contact.type === 'group')
    const contact = contacts.find(
      (item) =>
        item.md5 === task.group ||
        item.m_nsUsrName === task.target ||
        item.m_nsUsrName === task.group
    )
    if (contact) return contact
    return {
      md5: task.group,
      m_nsUsrName: task.target,
      m_nsNickName: task.group,
      type: 'group'
    }
  }

  private async findDuplicate(
    candidate: {
      group: string
      target: string
      scheduleTime: string
      reportRange: ScheduledReportRange
      enabled: boolean
    },
    excludeTaskId?: string
  ): Promise<ScheduledReportTask | undefined> {
    const tasks = await this.deps.service.listTasks()
    return tasks.find(
      (task) =>
        task.id !== excludeTaskId &&
        task.group === candidate.group &&
        task.target === candidate.target &&
        task.scheduleTime === candidate.scheduleTime &&
        task.reportRange === candidate.reportRange &&
        task.enabled === candidate.enabled
    )
  }

  private toPublicTask(task: ScheduledReportTask): ScheduledReportApiTask {
    const group = this.contactForTask(task)
    const talker = task.target || group.m_nsUsrName
    const name = group.m_nsNickName || task.group
    return {
      id: task.id,
      name: task.name,
      group: { talker, name },
      schedule: { type: 'daily', time: task.scheduleTime },
      reportRange: task.reportRange,
      target: { type: 'wechat_group', talker, name },
      enabled: task.enabled,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.lastRunAt ? { lastRunAt: task.lastRunAt } : {}),
      nextRunAt: task.nextRunAt
    }
  }
}
