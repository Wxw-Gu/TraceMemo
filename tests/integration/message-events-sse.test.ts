import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => `/tmp/tracememo-sse-${process.pid}`,
    getAppPath: () => `/tmp/tracememo-sse-${process.pid}`,
    getVersion: () => 'test-version',
    isPackaged: false
  },
  shell: {
    openPath: async () => '',
    openExternal: async () => undefined
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))

vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => true,
  listContacts: () => [],
  listContactsAsync: async () => [],
  listMessages: () => [],
  getGroupSnapshot: () => ({ members: [] }),
  listRecentChat: () => [],
  resolveMd5: () => null
}))

vi.mock('../../src/main/group-report-service', () => ({
  exportGroupReport: vi.fn(async () => ({ success: true }))
}))

vi.mock('../../src/main/services/agent-group-report-service', () => ({
  generateAgentGroupReport: vi.fn(async () => ({ success: true }))
}))

vi.mock('../../src/main/services/agent-hub-service', () => ({
  agentHubService: {
    getStatus: () => ({
      hub: 'online',
      connector: 'online',
      dataApi: 'online',
      databaseReady: true
    }),
    testSend: vi.fn(async () => ({ success: true }))
  }
}))

import {
  startHttpServer,
  setAgentTaskInspector,
  type HttpServerHandle
} from '../../src/main/http-server'
import { MessageEventBroker } from '../../src/main/services/message-event-broker'
import {
  normalizeIncomingMessage,
  type NormalizedIncomingMessage
} from '../../src/main/services/message-listener-service'
import { decodeMessageRef } from '../../src/shared/local-query-api'
import type { Wcdb4Message } from '../../src/main/wcdb4-client'

/**
 * `/api/v1/events/messages` 的端到端契约。
 *
 * 用真实 `http` 连接而不是直接调 handler：SSE 的正确性很大一部分在
 * 响应头、帧格式、连接关闭与 `server.close()` 的行为里，函数级测试覆盖不到。
 */

const TOKEN = 'S'.repeat(43)
const SESSION_A = 'group_A@chatroom'
const SESSION_B = 'user_B'
const CONVERSATION_A = 'md5_conversation_a'
const CONVERSATION_B = 'md5_conversation_b'

const makeRow = (localId: string, content = 'hello'): Wcdb4Message => ({
  mesLocalID: localId,
  serverId: `server-${localId}`,
  mesDes: 1,
  messageType: '1',
  msgCreateTime: String(Math.floor(Date.now() / 1000)),
  msgContent: content,
  sender: 'OTHER_USER',
  senderNickname: '对方',
  senderAvatar: '',
  raw: {}
})

const normalize = (
  sessionId: string,
  localId: string,
  content?: string
): NormalizedIncomingMessage => normalizeIncomingMessage(sessionId, makeRow(localId, content))!

interface SseFrame {
  id?: string
  event?: string
  data?: Record<string, unknown>
}

interface SseClient {
  frames: SseFrame[]
  close(): void
  waitFor(predicate: (frame: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>
}

const clients: SseClient[] = []
const handles: HttpServerHandle[] = []

function parseBlock(block: string): SseFrame | null {
  const frame: SseFrame = {}
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const field = line.slice(0, separator)
    const value = line.slice(separator + 1).replace(/^ /, '')
    if (field === 'id') frame.id = value
    else if (field === 'event') frame.event = value
    else if (field === 'data') {
      try {
        frame.data = JSON.parse(value) as Record<string, unknown>
      } catch {
        frame.data = { raw: value }
      }
    }
  }
  return Object.keys(frame).length > 0 ? frame : null
}

function openSse(
  handle: HttpServerHandle,
  query = '',
  options: { token?: string | null; lastEventId?: string } = {}
): Promise<SseClient> {
  const url = `http://${handle.host}:${handle.port}/api/v1/events/messages${query}`
  const headers: Record<string, string> = { Accept: 'text/event-stream' }
  const token = options.token === undefined ? TOKEN : options.token
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId

  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body}`)))
        return
      }

      const frames: SseFrame[] = []
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const frame = parseBlock(block)
          if (frame) frames.push(frame)
          boundary = buffer.indexOf('\n\n')
        }
      })

      const client: SseClient = {
        frames,
        close: () => {
          res.destroy()
          req.destroy()
        },
        waitFor: (predicate, timeoutMs = 2_000) =>
          new Promise<SseFrame>((resolveFrame, rejectFrame) => {
            const startedAt = Date.now()
            const timer = setInterval(() => {
              const found = frames.find(predicate)
              if (found) {
                clearInterval(timer)
                resolveFrame(found)
                return
              }
              if (Date.now() - startedAt > timeoutMs) {
                clearInterval(timer)
                rejectFrame(
                  new Error(`SSE frame not received; got ${JSON.stringify(frames.slice(-3))}`)
                )
              }
            }, 10)
            timer.unref?.()
          })
      }
      clients.push(client)
      resolve(client)
    })
    req.on('error', reject)
  })
}

function makeBroker(
  options: {
    bufferSize?: number
    dbReady?: () => boolean
    reader?: (
      sessionId: string,
      start: number,
      end: number,
      limit: number
    ) => Promise<Wcdb4Message[]>
  } = {}
): MessageEventBroker {
  return new MessageEventBroker({
    resolveConversationId: (sessionId) => {
      if (sessionId === SESSION_A) return CONVERSATION_A
      if (sessionId === SESSION_B) return CONVERSATION_B
      return undefined
    },
    resolveSessionId: (conversationId) =>
      conversationId === CONVERSATION_A
        ? SESSION_A
        : conversationId === CONVERSATION_B
          ? SESSION_B
          : undefined,
    isDatabaseReady: options.dbReady ?? (() => true),
    readMessages: options.reader,
    bufferSize: options.bufferSize ?? 20,
    bufferTtlMs: 10 * 60 * 1000
  })
}

async function startFixtureServer(broker: MessageEventBroker): Promise<HttpServerHandle> {
  const handle = await startHttpServer('127.0.0.1', 0, {
    tokenProvider: () => TOKEN,
    messageEventBroker: broker,
    messageEventsHeartbeatMs: 40
  })
  handles.push(handle)
  return handle
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

describe('GET /api/v1/events/messages', () => {
  it('没有 Bearer token 时返回 401，不建立 SSE 流', async () => {
    const handle = await startFixtureServer(makeBroker())
    await expect(openSse(handle, '', { token: null })).rejects.toThrow(/HTTP 401/)
  })

  it('连接先收到 status，再收到带 messageRef 的实时事件', async () => {
    const broker = makeBroker()
    const handle = await startFixtureServer(broker)
    const client = await openSse(handle)

    const status = await client.waitFor((frame) => frame.event === 'status')
    expect(status.data).toMatchObject({ database: 'ready', filter: 'all', backfill: 'enabled' })

    broker.publish(normalize(SESSION_A, '1', '实时消息'))
    const message = await client.waitFor((frame) => frame.event === 'message')
    expect(message.id).toBe('1')
    expect(message.data).toMatchObject({
      origin: 'live',
      conversationId: CONVERSATION_A,
      text: '实时消息',
      isSelf: false
    })
    expect(decodeMessageRef(String(message.data?.messageRef))).toEqual({
      conversationId: CONVERSATION_A,
      messageId: '1'
    })
  })

  it('同一条消息重复发布只推送一次（事件去重）', async () => {
    const broker = makeBroker()
    const handle = await startFixtureServer(broker)
    const client = await openSse(handle, `?conversation_id=${CONVERSATION_A}`)
    await client.waitFor((frame) => frame.event === 'status')

    const message = normalize(SESSION_A, '1')
    broker.publish(message)
    broker.publish(message)
    await client.waitFor((frame) => frame.event === 'message')
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(client.frames.filter((frame) => frame.event === 'message')).toHaveLength(1)
  })

  it('多个会话同时来消息：指定会话订阅只收到自己的，未过滤订阅全部收到', async () => {
    const broker = makeBroker()
    const handle = await startFixtureServer(broker)
    const filtered = await openSse(handle, `?conversation_id=${CONVERSATION_A}`)
    const all = await openSse(handle)
    await filtered.waitFor((frame) => frame.event === 'status')
    await all.waitFor((frame) => frame.event === 'status')

    broker.publish(normalize(SESSION_A, 'a1'))
    broker.publish(normalize(SESSION_B, 'b1'))
    broker.publish(normalize(SESSION_A, 'a2'))

    await all.waitFor(
      (frame) =>
        frame.event === 'message' &&
        typeof frame.data?.conversationId === 'string' &&
        frame.data.conversationId === CONVERSATION_B
    )
    await filtered.waitFor(
      (frame) =>
        frame.event === 'message' &&
        typeof frame.data?.conversationId === 'string' &&
        frame.data.conversationId === CONVERSATION_A
    )
    await new Promise((resolve) => setTimeout(resolve, 80))

    const filteredMessages = filtered.frames.filter((frame) => frame.event === 'message')
    const allMessages = all.frames.filter((frame) => frame.event === 'message')
    expect(filteredMessages).toHaveLength(2)
    expect(allMessages).toHaveLength(3)
    expect(filteredMessages.every((frame) => frame.data?.conversationId === CONVERSATION_A)).toBe(
      true
    )
  })

  it('SSE 重连：带上 Last-Event-ID 后补发断开期间的事件（origin=replay）', async () => {
    const broker = makeBroker()
    const handle = await startFixtureServer(broker)
    const first = await openSse(handle)
    await first.waitFor((frame) => frame.event === 'status')

    broker.publish(normalize(SESSION_A, '1'))
    const firstMessage = await first.waitFor((frame) => frame.event === 'message')
    const lastId = String(firstMessage.id)
    first.close()

    broker.publish(normalize(SESSION_A, '2'))

    const second = await openSse(handle, `?conversation_id=${CONVERSATION_A}`, {
      lastEventId: lastId
    })
    const replayed = await second.waitFor((frame) => frame.event === 'message')
    expect(replayed.data).toMatchObject({ origin: 'replay', text: 'hello' })
    expect(decodeMessageRef(String(replayed.data?.messageRef))).toEqual({
      conversationId: CONVERSATION_A,
      messageId: '2'
    })
  })

  it('缓冲覆盖不到时先发 gap，再从数据库有界回补（origin=db_backfill）', async () => {
    const reader = vi.fn(async (_sessionId: string, start: number, end: number) => {
      expect(end - start).toBeLessThanOrEqual(300)
      return [makeRow('9', '补回来的消息')]
    })
    const broker = makeBroker({ bufferSize: 1, reader })
    const handle = await startFixtureServer(broker)

    for (const id of ['1', '2', '3', '4']) broker.publish(normalize(SESSION_A, id))

    const client = await openSse(handle, `?conversation_id=${CONVERSATION_A}`, {
      lastEventId: '1'
    })
    const gap = await client.waitFor((frame) => frame.event === 'gap')
    expect(gap.data).toMatchObject({
      reason: 'buffer_overflow',
      requestedLastEventId: '1',
      backfill: 'scheduled'
    })
    const backfilled = await client.waitFor(
      (frame) => frame.event === 'message' && frame.data?.origin === 'db_backfill'
    )
    expect(backfilled.data?.text).toBe('补回来的消息')
    expect(client.frames.findIndex((f) => f.event === 'gap')).toBeLessThan(
      client.frames.findIndex((f) => f.event === 'message' && f.data?.origin === 'db_backfill')
    )
  })

  it('数据库不可用时 status 明确报告，恢复后心跳会补发状态变化', async () => {
    let ready = false
    const broker = makeBroker({ dbReady: () => ready })
    const handle = await startFixtureServer(broker)

    const client = await openSse(handle, `?conversation_id=${CONVERSATION_A}`)
    const offline = await client.waitFor(
      (frame) => frame.event === 'status' && frame.data?.database === 'unavailable'
    )
    expect(offline.data).toMatchObject({ database: 'unavailable' })

    ready = true
    const recovered = await client.waitFor(
      (frame) => frame.event === 'status' && frame.data?.database === 'ready',
      3_000
    )
    expect(recovered.data).toMatchObject({ database: 'ready' })
  })

  it('客户端断开后释放订阅，不会留下僵尸订阅者', async () => {
    const broker = makeBroker()
    const handle = await startFixtureServer(broker)
    const client = await openSse(handle)
    await client.waitFor((frame) => frame.event === 'status')
    expect(broker.status().subscribers).toBe(1)

    client.close()
    await vi.waitFor(() => expect(broker.status().subscribers).toBe(0), { timeout: 3_000 })
  })

  it('SSE 连接存活时 server.close() 仍能立即返回', async () => {
    const broker = makeBroker()
    const handle = await startFixtureServer(broker)
    const client = await openSse(handle)
    await client.waitFor((frame) => frame.event === 'status')

    const closed = await Promise.race([
      handle.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 1_500))
    ])
    expect(closed).toBe('closed')
    handles.splice(handles.indexOf(handle), 1)
  })
})

describe('GET /api/v1/agent-tasks', () => {
  const record = {
    id: 'task-1',
    provider: 'workbuddy',
    conversationId: CONVERSATION_A,
    triggerKey: `${SESSION_A}:100`,
    prompt: '写日报',
    status: 'submitted' as const,
    createdAt: 1,
    updatedAt: 2,
    externalMessageId: 'msg-1',
    replies: [{ messageId: 'm2', role: 'assistant' as const, text: '好了' }]
  }

  afterEach(() => setAgentTaskInspector(undefined))

  it('需要 Bearer；返回安全视图，不泄露 triggerKey 与 username', async () => {
    setAgentTaskInspector({
      list: () => [record],
      get: (id) => (id === record.id ? record : undefined)
    })
    const handle = await startFixtureServer(makeBroker())
    const url = `http://${handle.host}:${handle.port}/api/v1/agent-tasks`

    expect((await fetch(url)).status).toBe(401)

    const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ count: 1, tasks: [{ id: 'task-1', status: 'submitted' }] })
    expect(JSON.stringify(body)).not.toContain('triggerKey')
    expect(JSON.stringify(body)).not.toContain(SESSION_A)
  })

  it('单任务不存在时 404', async () => {
    setAgentTaskInspector({ list: () => [], get: () => undefined })
    const handle = await startFixtureServer(makeBroker())
    const response = await fetch(
      `http://${handle.host}:${handle.port}/api/v1/agent-tasks/missing`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    )
    expect(response.status).toBe(404)
  })
})
