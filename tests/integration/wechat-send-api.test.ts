import fs from 'fs-extra'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracememo-wechat-send-api-'))
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
vi.mock('../../src/main/services/wechat-action-gateway', () => ({
  wechatActionGateway: { execute: vi.fn() }
}))

import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'
import type { WechatActionRequest, WechatActionResult } from '../../src/shared/wechat-action'
import type { LocalAgentApiService } from '../../src/main/services/local-agent-api-service'
import { startHttpServer, type HttpServerHandle } from '../../src/main/http-server'

const TOKEN = 'T'.repeat(43)

function capabilityOf(
  overrides: Partial<PersonalWechatSendCapability> = {}
): PersonalWechatSendCapability {
  return {
    supported: true,
    ready: true,
    status: 'ready',
    capabilities: { text: true, image: true, voice: true },
    senderStatus: {} as PersonalWechatSendCapability['senderStatus'],
    message: '可以发送',
    ...overrides
  }
}

function sentResult(overrides: Partial<WechatActionResult> = {}): WechatActionResult {
  return {
    actionId: 'action-1',
    status: 'sent',
    decision: 'allow',
    startedAt: '2026-10-20T00:00:00.000Z',
    finishedAt: '2026-10-20T00:00:00.500Z',
    ...overrides
  }
}

let handle: HttpServerHandle
let capability: PersonalWechatSendCapability
let executeResult: WechatActionResult
const execute = vi.fn()
const lastAction = (): WechatActionRequest => execute.mock.calls[0][0] as WechatActionRequest

async function post(body: unknown, token: string | null = TOKEN): Promise<Response> {
  return fetch(`http://${handle.host}:${handle.port}/api/v1/wechat/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  })
}

beforeAll(async () => {
  handle = await startHttpServer('127.0.0.1', 0, {
    tokenProvider: () => TOKEN,
    agentApiService: {} as LocalAgentApiService,
    wechatSendCapabilityProvider: async () => capability,
    wechatSendExecutor: execute
  })
})

afterAll(async () => {
  await handle.close()
  await fs.remove(root)
})

beforeEach(() => {
  capability = capabilityOf()
  executeResult = sentResult()
  execute.mockReset()
  execute.mockImplementation(async () => executeResult)
})

describe('POST /api/v1/wechat/send', () => {
  it('未携带 Token 时返回 401', async () => {
    const response = await post({ to: 'filehelper', text: 'hi' }, null)
    expect(response.status).toBe(401)
    expect(execute).not.toHaveBeenCalled()
  })

  it('缺少 to 时返回 400 且不进入投递', async () => {
    const response = await post({ text: 'hi' })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.errorCode).toBe('INVALID_RECIPIENT')
    expect(execute).not.toHaveBeenCalled()
  })

  it('text 超过 2000 字符时返回 400 并给出实际长度', async () => {
    const response = await post({ to: 'filehelper', text: 'x'.repeat(2_001) })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.errorCode).toBe('INVALID_REQUEST')
    expect(body.error).toContain('2001')
    expect(execute).not.toHaveBeenCalled()
  })

  it('type 非法时返回 400', async () => {
    const response = await post({ to: 'filehelper', type: 'video', text: 'hi' })
    expect(response.status).toBe(400)
    expect((await response.json()).errorCode).toBe('INVALID_REQUEST')
  })

  it('媒体类型缺少 filePath 或文件不存在时返回 400', async () => {
    const missing = await post({ to: 'filehelper', type: 'image' })
    expect(missing.status).toBe(400)

    const absent = await post({
      to: 'filehelper',
      type: 'image',
      filePath: path.join(root, 'no-such-image.png')
    })
    expect(absent.status).toBe(400)
    expect((await absent.json()).error).toContain('不存在')
    expect(execute).not.toHaveBeenCalled()
  })

  it('发送能力未就绪时返回 503', async () => {
    capability = capabilityOf({
      ready: false,
      status: 'needs_binding',
      message: '请先绑定个人微信'
    })
    const response = await post({ to: 'filehelper', text: 'hi' })
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.errorCode).toBe('SEND_CAPABILITY_UNAVAILABLE')
    expect(body.capabilityStatus).toBe('needs_binding')
    expect(execute).not.toHaveBeenCalled()
  })

  it('能力就绪但不支持该内容类型时返回 503 SEND_NOT_READY', async () => {
    capability = capabilityOf({ capabilities: { text: true, image: false, voice: false } })
    const response = await post({ to: 'filehelper', type: 'voice', filePath: __filename })
    expect(response.status).toBe(503)
    expect((await response.json()).errorCode).toBe('SEND_NOT_READY')
    expect(execute).not.toHaveBeenCalled()
  })

  it('文本发送成功时以 http_api 来源经过 Gateway', async () => {
    const response = await post({ to: 'filehelper', type: 'text', text: '  你好  ' })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.actionId).toBe('action-1')
    expect(body.recipient).toEqual({ type: 'contact', id: 'filehelper' })
    expect(body.durationMs).toBe(500)

    const action = lastAction()
    expect(action.origin).toBe('http_api')
    expect(action.purpose).toBe('api_text')
    expect(action.triggerType).toBe('user')
    expect(action.content).toEqual({ type: 'text', text: '你好' })
  })

  it('type 省略时按文本发送', async () => {
    await post({ to: 'wxid_friend', text: 'hi' })
    expect(lastAction().content).toEqual({ type: 'text', text: 'hi' })
  })

  it('群 id 自动判定为 group', async () => {
    await post({ to: 'room@chatroom', text: 'hi' })
    expect(lastAction().recipient).toEqual({ type: 'group', id: 'room@chatroom' })
  })

  it('idempotencyKey 原样透传给 Gateway', async () => {
    await post({ to: 'filehelper', text: 'hi', idempotencyKey: 'agent-run-42' })
    expect(lastAction().idempotencyKey).toBe('agent-run-42')
  })

  it('图片发送使用本地文件路径', async () => {
    const imagePath = path.join(root, 'report.png')
    await fs.writeFile(imagePath, 'png')
    const response = await post({ to: 'filehelper', type: 'image', filePath: imagePath })
    expect(response.status).toBe(200)
    expect(lastAction().content).toEqual({ type: 'image', path: imagePath })
  })

  it('底层发送失败时返回 502 并带上 errorCode', async () => {
    executeResult = sentResult({
      status: 'failed',
      decision: 'allow',
      errorCode: 'SEND_FAILED',
      reason: '微信发送失败'
    })
    const response = await post({ to: 'filehelper', text: 'hi' })
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.success).toBe(false)
    expect(body.errorCode).toBe('SEND_FAILED')
    expect(body.error).toBe('微信发送失败')
  })

  it('策略拒绝时返回 403', async () => {
    executeResult = sentResult({
      status: 'blocked',
      decision: 'block',
      errorCode: 'POLICY_BLOCKED',
      reason: '该发送动作未通过策略检查'
    })
    const response = await post({ to: 'filehelper', text: 'hi' })
    expect(response.status).toBe(403)
  })
})
