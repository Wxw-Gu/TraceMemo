import fs from 'fs-extra'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const root = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracememo-agent-api-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => root, getVersion: () => 'test-version' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => true,
  listContacts: () => [],
  listContactsAsync: async () => [],
  listMessages: () => [],
  getGroupSnapshot: () => null,
  listRecentChat: () => [],
  resolveMd5: () => null
}))

vi.mock('../../src/main/group-report-service', () => ({ exportGroupReport: vi.fn() }))
vi.mock('../../src/main/services/agent-group-report-service', () => ({
  generateAgentGroupReport: vi.fn()
}))
vi.mock('../../src/main/services/agent-hub-service', () => ({
  agentHubService: {
    getStatus: () => ({ connector: 'offline' }),
    testSend: vi.fn()
  }
}))
vi.mock('../../src/main/services/group-exit-monitor-service', () => ({
  groupExitMonitorService: {
    getState: () => ({ enabled: false, running: false, monitoredRoomIds: [] })
  }
}))

import {
  BUILTIN_DAILY_REPORT_RULE_ID,
  BUILTIN_LEAVE_NOTIFICATION_RULE_ID
} from '../../src/shared/automation'
import { GROUP_EXIT_NOTIFICATION_TEMPLATE } from '../../src/shared/group-exit-monitor'
import type { Contact } from '../../src/shared/types'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'
import { AutomationExecutionLogService } from '../../src/main/services/automation-execution-log-service'
import { AutomationRuleStore } from '../../src/main/services/automation-rule-store'
import { LocalAgentApiService } from '../../src/main/services/local-agent-api-service'
import {
  apiServer,
  startHttpServer,
  type HttpServerHandle,
  type HttpServerOptions
} from '../../src/main/http-server'
import type { LocalQueryApiService } from '../../src/main/services/local-query-api-service'

const TOKEN = 'T'.repeat(43)
const handles: HttpServerHandle[] = []
type TestDailyDraft = {
  name: string
  ruleType: string
  scope: string
  conditions: {
    requireMentionMe: boolean
    keyword: string
    keywordMatchMode: string
    conversationIds: string[]
    ignoreSelf: boolean
  }
  actions: Array<{ type: string; enabled: boolean; text?: string }>
  cooldownSeconds: number
  replyDelaySeconds: number
}
type TestScheduledDraft = {
  name: string
  ruleType: string
  scheduledReport: {
    schedule: { time: string }
    report: {
      sourceConversationId: string
      range: string
      messageTypes: string[]
      templateId: string
      memberNameMode: string
      timeoutSeconds: number
    }
    target: { type: string; contactId: string }
    postfixText: string
  }
}
type TestLeaveNotificationDraft = {
  name: string
  ruleType: string
  leaveNotification: {
    target: { type: string }
    template: string
    notifyScope: string
    notifyRoomIds: string[]
    targetNeedsReview?: boolean
  }
}
const contacts: Contact[] = [
  {
    m_nsUsrName: 'room@chatroom',
    m_nsNickName: '产品群',
    md5: 'group-md5',
    type: 'group'
  },
  {
    m_nsUsrName: 'wxid_friend',
    wxid: 'wxid_friend',
    m_nsNickName: 'Alice',
    md5: 'friend-md5',
    type: 'user'
  }
]

let databaseReady = true
let personalReady = false
let currentStore: AutomationRuleStore
let currentExecutionLog: AutomationExecutionLogService

function createApiService(
  store = currentStore,
  executionLog = currentExecutionLog
): LocalAgentApiService {
  const personal = {
    supported: true,
    ready: personalReady,
    status: personalReady ? 'ready' : 'needs_binding',
    capabilities: { text: personalReady, image: false, voice: false },
    senderStatus: { executablePath: '/private/wechat/runtime' }
  } as unknown as PersonalWechatSendCapability
  return new LocalAgentApiService({
    automationRuleStore: store,
    automationExecutionLogService: executionLog,
    listContacts: async () => contacts,
    isDatabaseReady: () => databaseReady,
    getVersion: () => 'test-version',
    getPersonalWechatCapability: async () => personal,
    getAgentHubStatus: () => ({ connector: 'offline' }),
    getGroupExitMonitorState: () => ({ enabled: false, running: false, monitoredRoomIds: [] })
  })
}

async function startServer(
  api = createApiService(),
  queryApiService?: HttpServerOptions['queryApiService']
): Promise<HttpServerHandle> {
  const handle = await startHttpServer('127.0.0.1', 0, {
    tokenProvider: () => TOKEN,
    agentApiService: api,
    queryApiService
  })
  handles.push(handle)
  return handle
}

function url(handle: HttpServerHandle, pathName: string): string {
  return `http://${handle.host}:${handle.port}${pathName}`
}

async function request(
  handle: HttpServerHandle,
  pathName: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(url(handle, pathName), {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
}

const validDailyDraft = (): TestDailyDraft => ({
  name: '产品群日报自动化',
  ruleType: 'daily_report',
  scope: 'group',
  conditions: {
    requireMentionMe: true,
    keyword: '日报',
    keywordMatchMode: 'contains',
    conversationIds: ['room@chatroom'],
    ignoreSelf: true
  },
  actions: [{ type: 'replyText', enabled: true, text: '收到' }],
  cooldownSeconds: 60,
  replyDelaySeconds: 0
})

const validScheduledDraft = (): TestScheduledDraft => ({
  name: '产品群每日日报',
  ruleType: 'scheduled_report',
  scheduledReport: {
    schedule: { time: '20:00' },
    report: {
      sourceConversationId: 'room@chatroom',
      range: 'today',
      messageTypes: ['text', 'image'],
      templateId: 'v1',
      memberNameMode: 'groupNickname',
      timeoutSeconds: 300
    },
    target: { type: 'contact', contactId: 'wxid_friend' },
    postfixText: '日报已生成'
  }
})

const validLeaveNotificationDraft = (): TestLeaveNotificationDraft => ({
  name: '退群通知',
  ruleType: 'leave_notification',
  leaveNotification: {
    target: { type: 'file_transfer' },
    template: GROUP_EXIT_NOTIFICATION_TEMPLATE,
    notifyScope: 'all',
    notifyRoomIds: []
  }
})

describe('Local Agent API', () => {
  beforeEach(() => {
    fs.removeSync(path.join(root, 'automation'))
    databaseReady = true
    personalReady = false
    currentStore = new AutomationRuleStore({ userDataPath: () => root })
    currentExecutionLog = new AutomationExecutionLogService({ userDataPath: () => root })
  })

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()))
    await apiServer.stop()
  })

  afterAll(() => fs.removeSync(root))

  it('reports application version and separates supported from runtime availability', async () => {
    const handle = await startServer()
    let response = await request(handle, '/api/v1/capabilities')
    expect(response.status).toBe(200)
    let body = await response.json()
    expect(body).toMatchObject({
      version: 'test-version',
      apiVersion: 'v1',
      database: { ready: true },
      query: { supported: true, available: true },
      automations: {
        supported: true,
        available: true,
        ruleTypes: ['daily_report', 'scheduled_report', 'leave_notification']
      },
      wechat: {
        personal: { supported: true, available: false, status: 'needs_binding' },
        ilink: { supported: true, available: false, status: 'offline' }
      }
    })
    expect(JSON.stringify(body)).not.toMatch(/private\/wechat|executablePath|token|context_token/i)

    databaseReady = false
    response = await request(handle, '/api/v1/capabilities')
    body = await response.json()
    expect(body).toMatchObject({
      database: { ready: false },
      query: { supported: true, available: false, reason: 'database_not_ready' },
      groupStats: { supported: true, available: false, reason: 'database_not_ready' }
    })
  })

  it('uses the Agent error envelope for authorization, method, missing route, and size failures', async () => {
    const handle = await startServer()
    const unauthorized = await fetch(url(handle, '/api/v1/capabilities'))
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED' },
      requestId: expect.any(String)
    })

    const wrongMethod = await request(handle, '/api/v1/capabilities', 'POST')
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('GET')
    expect(await wrongMethod.json()).toMatchObject({
      error: { code: 'METHOD_NOT_ALLOWED' },
      requestId: expect.any(String)
    })

    const missingRoute = await request(handle, '/api/v1/automations/rule-1/run')
    expect(missingRoute.status).toBe(404)
    expect(await missingRoute.json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
      requestId: expect.any(String)
    })

    const oversized = await fetch(url(handle, '/api/v1/automations'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify('x'.repeat(1024 * 1024 + 1))
    })
    expect(oversized.status).toBe(413)
    expect(oversized.headers.get('x-request-id')).toEqual(expect.any(String))
    expect(await oversized.json()).toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
      requestId: expect.any(String)
    })
  })

  it('preserves the existing Query operation request and response contract', async () => {
    const queryApi = {
      messages: vi.fn(async (payload: unknown) => ({ status: 'completed', payload }))
    } as unknown as LocalQueryApiService
    const handle = await startServer(createApiService(), queryApi)
    const payload = { target: { query: 'Alice' }, timeRange: { kind: 'all' } }
    const response = await request(handle, '/api/v1/query/messages', 'POST', payload)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'completed', payload })
    expect(queryApi.messages).toHaveBeenCalledWith(payload)
  })

  it('validates rule fields and resolves scheduled IDs without persisting', async () => {
    const handle = await startServer()
    const scheduled = validScheduledDraft()
    const response = await request(handle, '/api/v1/automations/validate', 'POST', scheduled)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ valid: true, normalized: { enabled: false } })
    expect(result.normalized.scheduledReport.report.sourceConversationId).toBe('room@chatroom')
    expect(result.normalized.scheduledReport.target.contactId).toBe('wxid_friend')
    expect(result.effects).toMatchObject({ sendsWechatMessage: true })
    expect(result.nextRunAt).toEqual(expect.any(String))
    expect(currentStore.listRules().some((rule) => rule.name === '产品群每日日报')).toBe(false)

    const mentionOnly = validDailyDraft()
    mentionOnly.conditions.keyword = ''
    const mentionOnlyResponse = await request(
      handle,
      '/api/v1/automations/validate',
      'POST',
      mentionOnly
    )
    expect((await mentionOnlyResponse.json()).valid).toBe(true)

    const invalidEnum = validDailyDraft()
    invalidEnum.conditions.keywordMatchMode = 'regex'
    const enumResponse = await request(handle, '/api/v1/automations/validate', 'POST', invalidEnum)
    const enumResult = await enumResponse.json()
    expect(enumResult.valid).toBe(false)
    expect(enumResult.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'conditions.keywordMatchMode', code: 'invalid_enum' })
      ])
    )

    const invalidTime = validScheduledDraft()
    invalidTime.scheduledReport.schedule.time = '29:90'
    const timeResponse = await request(handle, '/api/v1/automations/validate', 'POST', invalidTime)
    expect((await timeResponse.json()).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'scheduledReport.schedule.time', code: 'invalid_time' })
      ])
    )

    const unknownFieldResponse = await request(handle, '/api/v1/automations/validate', 'POST', {
      ...validDailyDraft(),
      callbackUrl: 'http://127.0.0.1'
    })
    expect((await unknownFieldResponse.json()).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'draft.callbackUrl', code: 'unknown_field' })
      ])
    )

    const invalidRuleTypeResponse = await request(handle, '/api/v1/automations/validate', 'POST', {
      ...validDailyDraft(),
      ruleType: 'webhook'
    })
    expect((await invalidRuleTypeResponse.json()).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'ruleType', code: 'invalid_enum' })])
    )

    const enabledInputResponse = await request(handle, '/api/v1/automations/validate', 'POST', {
      ...validDailyDraft(),
      enabled: true
    })
    expect((await enabledInputResponse.json()).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'enabled', code: 'use_enable_operation' })
      ])
    )

    const invalidAllScopeRoomResponse = await request(
      handle,
      '/api/v1/automations/validate',
      'POST',
      {
        ...validLeaveNotificationDraft(),
        leaveNotification: {
          ...validLeaveNotificationDraft().leaveNotification,
          notifyRoomIds: ['missing-room@chatroom']
        }
      }
    )
    expect((await invalidAllScopeRoomResponse.json()).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'leaveNotification.notifyRoomIds[0]',
          code: 'contact_not_found'
        })
      ])
    )
  })

  it('creates disabled rules, updates them, validates on enable, and protects system rules', async () => {
    const handle = await startServer()
    const createResponse = await request(handle, '/api/v1/automations', 'POST', validDailyDraft(), {
      'X-Request-Id': 'agent:create-rule'
    })
    expect(createResponse.status).toBe(201)
    expect(createResponse.headers.get('x-request-id')).toBe('agent:create-rule')
    const created = (await createResponse.json()).rule
    expect(created).toMatchObject({ enabled: false, ruleType: 'daily_report' })
    expect(created.conditions.conversationIds).toEqual(['room@chatroom'])

    const getResponse = await request(handle, `/api/v1/automations/${created.id}`)
    expect(getResponse.status).toBe(200)
    expect((await getResponse.json()).rule.id).toBe(created.id)

    const patchResponse = await request(handle, `/api/v1/automations/${created.id}`, 'PATCH', {
      name: '更新后的名称'
    })
    expect((await patchResponse.json()).rule).toMatchObject({
      id: created.id,
      name: '更新后的名称',
      enabled: false
    })

    const immutableResponse = await request(handle, `/api/v1/automations/${created.id}`, 'PATCH', {
      ruleType: 'scheduled_report'
    })
    expect(immutableResponse.status).toBe(400)
    expect(await immutableResponse.json()).toMatchObject({
      error: { code: 'RULE_TYPE_IMMUTABLE' },
      requestId: expect.any(String)
    })

    const metadataResponse = await request(handle, `/api/v1/automations/${created.id}`, 'PATCH', {
      createdAt: 0
    })
    expect(metadataResponse.status).toBe(400)
    expect((await metadataResponse.json()).error.code).toBe('IMMUTABLE_FIELD')

    databaseReady = false
    const unavailableEnableResponse = await request(
      handle,
      `/api/v1/automations/${created.id}/enable`,
      'POST'
    )
    expect(unavailableEnableResponse.status).toBe(409)
    expect((await unavailableEnableResponse.json()).error.code).toBe('VALIDATION_FAILED')
    expect(currentStore.getRule(created.id)?.enabled).toBe(false)

    databaseReady = true
    const enableResponse = await request(handle, `/api/v1/automations/${created.id}/enable`, 'POST')
    expect((await enableResponse.json()).rule.enabled).toBe(true)
    const disableResponse = await request(
      handle,
      `/api/v1/automations/${created.id}/disable`,
      'POST'
    )
    expect((await disableResponse.json()).rule.enabled).toBe(false)

    const filteredResponse = await request(
      handle,
      '/api/v1/automations?type=daily_report&enabled=false'
    )
    const filtered = await filteredResponse.json()
    expect(filtered.rules.some((rule: { id: string }) => rule.id === created.id)).toBe(true)

    const protectedDaily = await request(
      handle,
      `/api/v1/automations/${BUILTIN_DAILY_REPORT_RULE_ID}`,
      'DELETE'
    )
    expect(protectedDaily.status).toBe(409)
    expect((await protectedDaily.json()).error.code).toBe('PROTECTED_RULE')
    const protectedLeave = await request(
      handle,
      `/api/v1/automations/${BUILTIN_LEAVE_NOTIFICATION_RULE_ID}`,
      'DELETE'
    )
    expect(protectedLeave.status).toBe(409)

    const nonBuiltinLeave = currentStore.createRule(validLeaveNotificationDraft())
    const protectedNonBuiltinLeave = await request(
      handle,
      `/api/v1/automations/${nonBuiltinLeave.id}`,
      'DELETE'
    )
    expect(protectedNonBuiltinLeave.status).toBe(409)
    expect((await protectedNonBuiltinLeave.json()).error.code).toBe('PROTECTED_RULE')

    const duplicateLeave = await request(handle, '/api/v1/automations', 'POST', {
      name: '第二条退群通知',
      ruleType: 'leave_notification',
      leaveNotification: {
        target: { type: 'file_transfer' },
        template: '{groupName} {user}',
        notifyScope: 'all',
        notifyRoomIds: []
      }
    })
    expect(duplicateLeave.status).toBe(409)
    expect((await duplicateLeave.json()).error.code).toBe('SINGLETON_RULE')

    const deleteCustom = await request(handle, `/api/v1/automations/${created.id}`, 'DELETE')
    expect(deleteCustom.status).toBe(200)
    expect((await deleteCustom.json()).deletedId).toBe(created.id)
  })

  it('lists bounded execution records with structured filters', async () => {
    const handle = await startServer()
    currentExecutionLog.record({
      executionId: 'execution-1',
      ruleId: BUILTIN_DAILY_REPORT_RULE_ID,
      ruleName: '内置日报',
      triggerTime: Date.parse('2025-01-02T03:04:05.000Z'),
      trigger: 'message',
      sourceDisplayName: '产品群',
      status: 'failed',
      durationMs: 1_250,
      steps: [],
      errorSummary: '日报生成失败'
    })
    const response = await request(
      handle,
      '/api/v1/automations/executions?ruleId=builtin-mention-me-daily-report&status=failed&since=2025-01-01T00%3A00%3A00Z&until=2025-01-03T00%3A00%3A00Z&limit=10'
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      count: 1,
      executions: [
        {
          executionId: 'execution-1',
          ruleId: BUILTIN_DAILY_REPORT_RULE_ID,
          ruleType: 'daily_report',
          trigger: 'message',
          status: 'failed',
          startedAt: '2025-01-02T03:04:05.000Z',
          finishedAt: '2025-01-02T03:04:06.250Z',
          error: '日报生成失败'
        }
      ]
    })
    const invalidLimit = await request(handle, '/api/v1/automations/executions?limit=201')
    expect(invalidLimit.status).toBe(400)
    expect((await invalidLimit.json()).error.code).toBe('INVALID_ARGUMENT')
  })

  it('only clears target review when a valid replacement target is supplied', async () => {
    const handle = await startServer()
    currentStore.saveLeaveNotificationRule({
      ...validLeaveNotificationDraft(),
      enabled: false,
      leaveNotification: {
        ...validLeaveNotificationDraft().leaveNotification,
        targetNeedsReview: true
      }
    })

    const bypass = await request(
      handle,
      `/api/v1/automations/${BUILTIN_LEAVE_NOTIFICATION_RULE_ID}`,
      'PATCH',
      { leaveNotification: { targetNeedsReview: false } }
    )
    expect(bypass.status).toBe(400)
    expect((await bypass.json()).error.code).toBe('IMMUTABLE_FIELD')
    expect(
      currentStore.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)?.leaveNotification?.targetNeedsReview
    ).toBe(true)

    const invalidTarget = await request(
      handle,
      `/api/v1/automations/${BUILTIN_LEAVE_NOTIFICATION_RULE_ID}`,
      'PATCH',
      { leaveNotification: { target: {} } }
    )
    expect(invalidTarget.status).toBe(422)
    expect(
      currentStore.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)?.leaveNotification?.targetNeedsReview
    ).toBe(true)

    const updated = await request(
      handle,
      `/api/v1/automations/${BUILTIN_LEAVE_NOTIFICATION_RULE_ID}`,
      'PATCH',
      { leaveNotification: { target: { type: 'self' } } }
    )
    expect(updated.status).toBe(200)
    expect((await updated.json()).rule.leaveNotification).not.toHaveProperty('targetNeedsReview')
    expect(
      currentStore.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)?.leaveNotification?.target
    ).toEqual({ type: 'self' })
  })

  it('returns a standard persistence error and rolls back the in-memory rule on write failure', async () => {
    const blockedPath = path.join(root, 'not-a-directory')
    fs.writeFileSync(blockedPath, 'file')
    const failingStore = new AutomationRuleStore({ userDataPath: () => blockedPath })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const handle = await startServer(createApiService(failingStore, currentExecutionLog))
    try {
      const response = await request(handle, '/api/v1/automations', 'POST', {
        ...validDailyDraft(),
        name: '不得假成功'
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({
        error: { code: 'PERSISTENCE_FAILED' },
        requestId: expect.any(String)
      })
      expect(failingStore.listRules().some((rule) => rule.name === '不得假成功')).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
