import { describe, expect, it, vi } from 'vitest'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'
import type { ScheduledReportTask } from '../../src/shared/scheduled-report'
import {
  ScheduledReportApiService,
  type ScheduledReportApiDependencies
} from '../../src/main/services/scheduled-report-api-service'

type ApiTestService = ScheduledReportApiDependencies['service'] & {
  createTask: ReturnType<typeof vi.fn>
  updateTask: ReturnType<typeof vi.fn>
}
type ApiTestResult = {
  api: ScheduledReportApiService
  service: ApiTestService
}

const contacts = [
  {
    md5: 'tech-md5',
    m_nsUsrName: 'tech@chatroom',
    m_nsNickName: '技术交流群',
    type: 'group' as const
  },
  {
    md5: 'product-md5',
    m_nsUsrName: 'product@chatroom',
    m_nsNickName: '产品交流群',
    type: 'group' as const
  }
]

const task = (overrides: Partial<ScheduledReportTask> = {}): ScheduledReportTask => ({
  id: 'task-1',
  name: '技术交流群 · 每日日报',
  group: 'tech-md5',
  target: 'tech@chatroom',
  scheduleTime: '09:00',
  reportRange: 'yesterday',
  enabled: true,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
  nextRunAt: '2026-08-28T01:00:00.000Z',
  ...overrides
})

const capability = (
  status: PersonalWechatSendCapability['status']
): PersonalWechatSendCapability => ({
  supported: status !== 'unsupported',
  ready: status === 'ready',
  status,
  capabilities: { text: status === 'ready', image: status === 'ready', voice: status === 'ready' },
  senderStatus: {} as PersonalWechatSendCapability['senderStatus'],
  message: status === 'ready' ? 'ready' : '请先配置微信'
})

function makeApi(
  options: { capability?: PersonalWechatSendCapability; tasks?: ScheduledReportTask[] } = {}
): ApiTestResult {
  const tasks = options.tasks || []
  const service = {
    listTasks: vi.fn(async () => tasks),
    listExecutions: vi.fn(async () => []),
    createTask: vi.fn(async (input: Record<string, unknown>) => {
      const created = task({
        id: `task-${tasks.length + 1}`,
        name: String(input.name),
        group: String(input.group),
        target: String(input.target),
        scheduleTime: String(input.scheduleTime),
        reportRange: input.reportRange as ScheduledReportTask['reportRange'],
        enabled: Boolean(input.enabled)
      })
      tasks.push(created)
      return { success: true, data: created }
    }),
    updateTask: vi.fn(async () => ({ success: true, data: tasks[0] })),
    deleteTask: vi.fn(async (id: string) => ({ success: true, data: { deletedId: id } })),
    setTaskEnabled: vi.fn(async (id: string, enabled: boolean) => ({
      success: true,
      data: task({ id, enabled })
    })),
    runScheduledReportNow: vi.fn(async (id: string) => ({
      success: true,
      data: {
        id: 'execution-1',
        taskId: id,
        startedAt: '2026-08-27T01:00:00.000Z',
        status: 'success' as const
      }
    }))
  }
  return {
    api: new ScheduledReportApiService({
      service,
      getCapability: async () => options.capability || capability('ready'),
      listContacts: () => contacts,
      isDatabaseReady: () => true,
      platform: 'darwin'
    }),
    service
  }
}

describe('ScheduledReportApiService', () => {
  it('resolves a unique group and maps the public create request to the existing service', async () => {
    const { api, service } = makeApi()
    const result = await api.create({
      group: { name: '技术交流群' },
      schedule: { type: 'daily', time: '09:00' },
      reportRange: 'yesterday'
    })
    expect(result).toMatchObject({
      name: '技术交流群 · 每日日报',
      group: { talker: 'tech@chatroom', name: '技术交流群' },
      schedule: { type: 'daily', time: '09:00' },
      target: { type: 'wechat_group', talker: 'tech@chatroom' }
    })
    expect(service.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ group: 'tech-md5', target: 'tech@chatroom' })
    )
  })

  it.each(['unsupported', 'unconfigured', 'needs_binding', 'needs_verification', 'error'] as const)(
    'rejects creation before touching the task service for capability state %s',
    async (status) => {
      const { api, service } = makeApi({ capability: capability(status) })
      await expect(
        api.create({
          group: '技术交流群',
          schedule: { type: 'daily', time: '09:00' }
        })
      ).rejects.toMatchObject({ code: 'wechat_not_ready', status: 409 })
      expect(service.createTask).not.toHaveBeenCalled()
    }
  )

  it('enforces the macOS platform gate even if a provider reports ready', async () => {
    const { service } = makeApi()
    const api = new ScheduledReportApiService({
      service,
      getCapability: async () => capability('ready'),
      listContacts: () => contacts,
      isDatabaseReady: () => true,
      platform: 'win32'
    })
    await expect(
      api.create({ group: '技术交流群', schedule: { type: 'daily', time: '09:00' } })
    ).rejects.toMatchObject({ code: 'wechat_not_ready', status: 409 })
    expect(service.createTask).not.toHaveBeenCalled()
  })

  it('returns candidates for ambiguous group names and rejects duplicate tasks', async () => {
    const ambiguousContacts = contacts.map((contact) => ({ ...contact, m_nsNickName: '重复群' }))
    const { service: ambiguousService } = makeApi()
    const ambiguousApi = new ScheduledReportApiService({
      service: ambiguousService,
      getCapability: async () => capability('ready'),
      listContacts: () => ambiguousContacts,
      isDatabaseReady: () => true,
      platform: 'darwin'
    })
    await expect(
      ambiguousApi.create({ group: '重复群', schedule: { type: 'daily', time: '09:00' } })
    ).rejects.toMatchObject({ code: 'group_ambiguous', status: 409 })

    const duplicateApi = makeApi({ tasks: [task()] }).api
    await expect(
      duplicateApi.create({ group: '技术交流群', schedule: { type: 'daily', time: '09:00' } })
    ).rejects.toMatchObject({ code: 'duplicate', status: 409 })
  })

  it('updates a changed group target together when target is omitted', async () => {
    const existing = task()
    const { api, service } = makeApi({ tasks: [existing] })
    vi.mocked(service.updateTask).mockResolvedValue({
      success: true,
      data: task({ group: 'product-md5', target: 'product@chatroom', name: '产品日报' })
    })
    const result = await api.update('task-1', {
      group: { name: '产品交流群' },
      name: '产品日报'
    })
    expect(result.group).toMatchObject({ talker: 'product@chatroom', name: '产品交流群' })
    expect(service.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ group: 'product-md5', target: 'product@chatroom' })
    )
  })

  it('serializes concurrent creates so only one identical task is created', async () => {
    const { api, service } = makeApi()
    const request = {
      group: '技术交流群',
      schedule: { type: 'daily' as const, time: '09:00' },
      reportRange: 'yesterday' as const
    }
    const results = await Promise.allSettled([api.create(request), api.create(request)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(service.createTask).toHaveBeenCalledOnce()
  })
})
