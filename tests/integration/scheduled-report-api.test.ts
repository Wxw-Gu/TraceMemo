import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  capability: {
    supported: true,
    ready: true,
    status: 'ready' as const,
    capabilities: { text: true, image: true, voice: true },
    senderStatus: {} as never,
    message: '个人微信已准备好发送日报'
  },
  contacts: [
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
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tracememo-scheduled-report-api' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))
vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => true,
  listContacts: () => fixture.contacts,
  listMessages: () => [],
  getGroupSnapshot: () => null,
  listRecentChat: () => [],
  resolveMd5: () => null
}))
vi.mock('../../src/main/services/personal-wechat-capability-service', () => ({
  personalWechatCapabilityService: {
    getPersonalWechatSendCapability: vi.fn(async () => fixture.capability)
  }
}))
vi.mock('../../src/main/services/scheduled-report-service', () => ({ scheduledReportService: {} }))
vi.mock('../../src/main/services/agent-group-report-service', () => ({
  generateAgentGroupReport: vi.fn(async () => ({ success: true }))
}))
vi.mock('../../src/main/group-report-service', () => ({
  exportGroupReport: vi.fn(async () => ({ success: true }))
}))
vi.mock('../../src/main/services/agent-hub-service', () => ({
  agentHubService: { getStatus: () => ({}), testSend: vi.fn(async () => ({ success: true })) }
}))

import { startHttpServer, type HttpServerHandle } from '../../src/main/http-server'
import type { ScheduledReportTask } from '../../src/shared/scheduled-report'
import type { ScheduledReportApiDependencies } from '../../src/main/services/scheduled-report-api-service'

const TOKEN = 'A'.repeat(43)
const handles: HttpServerHandle[] = []
const originalContacts = fixture.contacts

const makeTask = (overrides: Partial<ScheduledReportTask> = {}): ScheduledReportTask => ({
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

function baseUrl(handle: HttpServerHandle): string {
  return `http://${handle.host}:${handle.port}`
}

async function startFixture(
  options: { tasks?: ScheduledReportTask[] } = {}
): Promise<{ handle: HttpServerHandle; service: ScheduledReportApiDependencies['service'] }> {
  const tasks = options.tasks || []
  const executions: Array<Record<string, unknown>> = []
  const service = {
    listTasks: vi.fn(async () => tasks),
    listExecutions: vi.fn(async (taskId?: string) =>
      taskId ? executions.filter((item) => item.taskId === taskId) : executions
    ),
    createTask: vi.fn(async (input: Record<string, unknown>) => {
      const created = makeTask({
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
    updateTask: vi.fn(async (id: string, input: Record<string, unknown>) => {
      const current = tasks.find((item) => item.id === id)
      if (!current) return { success: false, error: '未找到定时日报任务' }
      const updated = { ...current, ...input, updatedAt: '2026-08-27T02:00:00.000Z' }
      tasks[tasks.indexOf(current)] = updated
      return { success: true, data: updated }
    }),
    deleteTask: vi.fn(async (id: string) => {
      const index = tasks.findIndex((item) => item.id === id)
      if (index < 0) return { success: false, error: '未找到定时日报任务' }
      tasks.splice(index, 1)
      return { success: true, data: { deletedId: id } }
    }),
    setTaskEnabled: vi.fn(async (id: string, enabled: boolean) => {
      const current = tasks.find((item) => item.id === id)
      if (!current) return { success: false, error: '未找到定时日报任务' }
      const updated = { ...current, enabled }
      tasks[tasks.indexOf(current)] = updated
      return { success: true, data: updated }
    }),
    runScheduledReportNow: vi.fn(async (id: string) => {
      const execution = {
        id: `execution-${executions.length + 1}`,
        taskId: id,
        startedAt: '2026-08-27T01:00:00.000Z',
        finishedAt: '2026-08-27T01:01:00.000Z',
        status: 'success' as const,
        message: '日报生成成功，微信发送成功'
      }
      executions.push(execution)
      return { success: true, data: execution }
    })
  }
  const handle = await startHttpServer('127.0.0.1', 0, {
    tokenProvider: () => TOKEN,
    scheduledReportService: service,
    scheduledReportCapabilityProvider: async () => fixture.capability,
    scheduledReportContactsProvider: () => fixture.contacts,
    scheduledReportDatabaseReadyProvider: () => true,
    scheduledReportPlatform: 'darwin'
  })
  handles.push(handle)
  return { handle, service }
}

const auth = { Authorization: `Bearer ${TOKEN}` }

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  fixture.contacts = originalContacts
  fixture.capability = {
    ...fixture.capability,
    ready: true,
    status: 'ready',
    message: '个人微信已准备好发送日报'
  }
})

describe('scheduled report Local HTTP API', () => {
  it('requires authentication and exposes capability plus CRUD lifecycle', async () => {
    const unauthenticated = await startFixture()
    expect(
      (await fetch(`${baseUrl(unauthenticated.handle)}/api/v1/scheduled-reports`)).status
    ).toBe(401)

    const { handle, service } = await startFixture()
    const create = await fetch(`${baseUrl(handle)}/api/v1/scheduled-reports`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group: { name: '技术交流群' },
        schedule: { type: 'daily', time: '09:00' },
        reportRange: 'yesterday'
      })
    })
    expect(create.status).toBe(201)
    const created = await create.json()
    expect(created).toMatchObject({ created: true, task: { group: { talker: 'tech@chatroom' } } })
    const taskId = created.task.id

    const list = await fetch(`${baseUrl(handle)}/api/v1/scheduled-reports`, { headers: auth })
    expect(await list.json()).toMatchObject({ count: 1, tasks: [{ id: taskId }] })
    const get = await fetch(`${baseUrl(handle)}/api/v1/scheduled-reports/${taskId}`, {
      headers: auth
    })
    expect((await get.json()).task.id).toBe(taskId)

    const update = await fetch(`${baseUrl(handle)}/api/v1/scheduled-reports/${taskId}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { type: 'daily', time: '10:00' } })
    })
    expect((await update.json()).task.schedule.time).toBe('10:00')
    await fetch(`${baseUrl(handle)}/api/v1/scheduled-reports/${taskId}/disable`, {
      method: 'POST',
      headers: auth
    })
    await fetch(`${baseUrl(handle)}/api/v1/scheduled-reports/${taskId}/enable`, {
      method: 'POST',
      headers: auth
    })
    const run = await fetch(`${baseUrl(handle)}/api/v1/scheduled-reports/${taskId}/run`, {
      method: 'POST',
      headers: auth
    })
    expect(await run.json()).toMatchObject({ success: true, execution: { status: 'success' } })
    const executions = await fetch(
      `${baseUrl(handle)}/api/v1/scheduled-reports/${taskId}/executions`,
      { headers: auth }
    )
    expect((await executions.json()).executions).toHaveLength(1)
    const capability = await fetch(`${baseUrl(handle)}/api/v1/wechat-personal/send-capability`, {
      headers: auth
    })
    expect(await capability.json()).toMatchObject({ capability: { status: 'ready' } })
    expect(service.createTask).toHaveBeenCalledOnce()
  })

  it('rejects unsupported capability, ambiguous groups, and duplicate tasks', async () => {
    fixture.capability = {
      ...fixture.capability,
      ready: false,
      status: 'needs_binding',
      message: '请先绑定个人微信'
    }
    const first = await startFixture()
    const blocked = await fetch(`${baseUrl(first.handle)}/api/v1/scheduled-reports`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: '技术交流群', schedule: { type: 'daily', time: '09:00' } })
    })
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({ error: 'wechat_not_ready' })

    fixture.capability = { ...fixture.capability, ready: true, status: 'ready' }
    fixture.contacts = fixture.contacts.map((contact) => ({ ...contact, m_nsNickName: '重复群' }))
    const ambiguous = await startFixture()
    const ambiguousResponse = await fetch(`${baseUrl(ambiguous.handle)}/api/v1/scheduled-reports`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: '重复群', schedule: { type: 'daily', time: '09:00' } })
    })
    expect(ambiguousResponse.status).toBe(409)
    expect(await ambiguousResponse.json()).toMatchObject({ error: 'group_ambiguous' })
  })
})
