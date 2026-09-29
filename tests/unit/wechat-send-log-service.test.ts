import { mkdtempSync, readFileSync, rmSync } from 'fs-extra'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-send-log-default' } }))

import { WechatSendLogService } from '../../src/main/services/wechat-send-log-service'
import { MAX_SEND_PREVIEW_LENGTH } from '../../src/shared/wechat-send'

describe('WechatSendLogService', () => {
  const directories: string[] = []

  afterEach(() => {
    while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
  })

  function createService(maxEntries?: number): { service: WechatSendLogService; root: string } {
    const root = mkdtempSync(join(tmpdir(), 'tracememo-send-log-'))
    directories.push(root)
    return {
      service: new WechatSendLogService(
        maxEntries === undefined
          ? { getUserDataPath: () => root }
          : { getUserDataPath: () => root, maxEntries }
      ),
      root
    }
  }

  it('truncates the text preview but keeps a stable full-content hash', () => {
    const { service } = createService()
    const text = '通'.repeat(600)
    const entry = service.buildEntry({
      request_id: 'req-1',
      transport: 'ilink',
      to: 'user@im.wechat',
      type: 'text',
      msg: text,
      status: 'sent',
      timestamp: 1_700_000_000_000
    })

    expect(entry.msg_preview).toHaveLength(MAX_SEND_PREVIEW_LENGTH)
    expect(entry.msg_hash).toBe(service.hashMessage(text))
    expect(entry.msg_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    // hash 覆盖完整内容，而不是被截断的预览。
    expect(entry.msg_hash).not.toBe(service.hashMessage(entry.msg_preview!))
  })

  it('records only the file name for media payloads', () => {
    const { service } = createService()
    const entry = service.buildEntry({
      request_id: 'req-2',
      transport: 'ilink',
      to: 'user@im.wechat',
      type: 'image',
      msg: '/tmp/agent-hub-fixture/群聊总结.png',
      status: 'sent',
      timestamp: 1
    })

    expect(entry.msg_preview).toBe('群聊总结.png')
    expect(JSON.stringify(entry)).not.toContain('agent-hub-fixture')
  })

  it('keeps the newest entry first and replaces the same request_id', () => {
    const { service } = createService()
    const base = {
      transport: 'ilink' as const,
      to: 'user@im.wechat',
      type: 'text' as const,
      msg: 'hello',
      timestamp: 1
    }

    service.record(service.buildEntry({ ...base, request_id: 'a', status: 'sent' }))
    service.record(service.buildEntry({ ...base, request_id: 'b', status: 'failed' }))
    service.record(service.buildEntry({ ...base, request_id: 'a', status: 'failed' }))

    const entries = service.list()
    expect(entries.map((entry) => entry.request_id)).toEqual(['a', 'b'])
    expect(entries[0].status).toBe('failed')
  })

  it('caps the persisted file at maxEntries', () => {
    const { service } = createService(3)
    for (let index = 0; index < 6; index += 1) {
      service.record(
        service.buildEntry({
          request_id: `req-${index}`,
          transport: 'personal',
          to: 'wxid_demo',
          type: 'text',
          msg: `消息 ${index}`,
          status: 'sent',
          timestamp: index
        })
      )
    }
    expect(service.list().map((entry) => entry.request_id)).toEqual(['req-5', 'req-4', 'req-3'])
  })

  it('never persists context tokens or bot tokens', () => {
    const { service, root } = createService()
    const contextToken = 'ctx-token-SECRET-VALUE'
    service.record({
      ...service.buildEntry({
        request_id: 'req-secret',
        transport: 'ilink',
        to: 'user@im.wechat',
        type: 'text',
        msg: '日报已经生成，请查看。',
        status: 'sent',
        timestamp: 1
      }),
      // 即使被误传进来，条目结构本身也不应该携带该字段。
      ...({ context_token: contextToken } as Record<string, unknown>)
    })

    const raw = readFileSync(join(root, 'actions', 'wechat-send-log.json'), 'utf8')
    expect(raw).not.toContain(contextToken)
    expect(raw).not.toContain('context_token')
    expect(service.list()[0]).not.toHaveProperty('context_token')
  })
})
