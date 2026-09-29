import { mkdtempSync, readFileSync, rmSync } from 'fs-extra'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-send-gateway-default' } }))
vi.mock('../../src/main/services/personal-wechat-send-service', () => ({
  personalWechatSendService: { send: vi.fn() }
}))

import { WechatSendGateway } from '../../src/main/services/wechat-send-gateway'
import { WechatSendLogService } from '../../src/main/services/wechat-send-log-service'
import { ILinkError } from '../../src/main/services/wechat-ilink/errors'
import type { PersonalWechatSendResult } from '../../src/shared/personal-wechat'
import {
  buildSendPreview,
  MAX_SEND_PREVIEW_LENGTH,
  normalizeWechatSendRequest,
  resolveSendTransport
} from '../../src/shared/wechat-send'

const okResult: PersonalWechatSendResult = { success: true, status: {} as never }

describe('统一发送模型', () => {
  it('规范化合法请求并保留 context_token', () => {
    const request = normalizeWechatSendRequest({
      request_id: 'req-1',
      account_id: 'bot-1',
      to: 'user@im.wechat',
      type: 'text',
      msg: '  Hello  ',
      context_token: 'ctx-1'
    })

    expect(request).toEqual({
      request_id: 'req-1',
      account_id: 'bot-1',
      to: 'user@im.wechat',
      type: 'text',
      msg: 'Hello',
      context_token: 'ctx-1'
    })
  })

  it('拒绝缺少接收者、类型或内容的请求', () => {
    const createRequestId = (): string => 'generated'
    expect(normalizeWechatSendRequest(null, { createRequestId })).toBeNull()
    expect(normalizeWechatSendRequest({ type: 'text', msg: 'hi' }, { createRequestId })).toBeNull()
    expect(
      normalizeWechatSendRequest({ to: 'user', type: 'video', msg: 'x' }, { createRequestId })
    ).toBeNull()
    expect(
      normalizeWechatSendRequest({ to: 'user', type: 'text', msg: '   ' }, { createRequestId })
    ).toBeNull()
    // voice 在统一模型里是合法类型，但业务上由个人微信通道承载。
    expect(
      normalizeWechatSendRequest(
        { to: 'user', type: 'voice', msg: '/tmp/a.silk' },
        {
          createRequestId
        }
      )
    ).toMatchObject({ type: 'voice' })
  })

  it('按 context_token 推断传输通道', () => {
    expect(resolveSendTransport({ context_token: 'ctx' })).toBe('ilink')
    expect(resolveSendTransport({})).toBe('personal')
    expect(resolveSendTransport({ transport: 'ilink' })).toBe('ilink')
    expect(resolveSendTransport({ transport: 'personal', context_token: 'ctx' })).toBe('personal')
  })

  it('截断预览但不动原文', () => {
    const text = 'x'.repeat(MAX_SEND_PREVIEW_LENGTH + 50)
    expect(buildSendPreview(text, 'text')).toHaveLength(MAX_SEND_PREVIEW_LENGTH)
    expect(text).toHaveLength(MAX_SEND_PREVIEW_LENGTH + 50)
  })
})

describe('WechatSendGateway', () => {
  const directories: string[] = []

  afterEach(() => {
    while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
  })

  function createGateway(
    options: {
      sendPersonal?: (request: never) => Promise<PersonalWechatSendResult>
      sendIlink?: (request: never) => Promise<void>
    } = {}
  ): { gateway: WechatSendGateway; root: string; log: WechatSendLogService } {
    const root = mkdtempSync(join(tmpdir(), 'tracememo-send-gateway-'))
    directories.push(root)
    const log = new WechatSendLogService({ getUserDataPath: () => root })
    let sequence = 0
    const gateway = new WechatSendGateway({
      now: () => 1_700_000_000_000,
      createRequestId: () => `generated-${(sequence += 1)}`,
      log,
      sendPersonal: (options.sendPersonal as never) ?? (async () => okResult),
      ...(options.sendIlink ? { sendIlink: options.sendIlink as never } : {})
    })
    return { gateway, root, log }
  }

  it('成功发送 iLink 文本时写入一致的 Send Log', async () => {
    const received: unknown[] = []
    const { gateway, log } = createGateway({
      sendIlink: async (request: never) => {
        received.push(request)
      }
    })

    const result = await gateway.send({
      request_id: 'req-ilink',
      account_id: 'bot-1',
      to: 'user@im.wechat',
      type: 'text',
      msg: '你好',
      context_token: 'ctx-secret'
    })

    expect(result).toMatchObject({
      request_id: 'req-ilink',
      success: true,
      status: 'sent',
      transport: 'ilink'
    })
    expect(received).toEqual([
      {
        request_id: 'req-ilink',
        account_id: 'bot-1',
        to: 'user@im.wechat',
        type: 'text',
        msg: '你好',
        context_token: 'ctx-secret'
      }
    ])

    const [entry] = log.list()
    expect(entry.request_id).toBe('req-ilink')
    expect(entry.transport).toBe('ilink')
    expect(entry.status).toBe('sent')
    expect(entry.msg_preview).toBe('你好')
    expect(entry.duration_ms).toBe(0)
  })

  it('iLink 发送失败时同样留下 Send Log 并给出错误码', async () => {
    const { gateway, log } = createGateway({
      sendIlink: async () => {
        throw new ILinkError({ kind: 'stale_token', message: '登录凭证已失效', ret: -14 })
      }
    })

    const result = await gateway.send({
      request_id: 'req-stale',
      to: 'user@im.wechat',
      type: 'text',
      msg: '测试',
      transport: 'ilink'
    })

    expect(result).toMatchObject({ success: false, status: 'failed', error_code: 'STALE_TOKEN' })
    expect(log.list()[0]).toMatchObject({ request_id: 'req-stale', status: 'failed' })
    expect(log.list()[0].error_code).toBe('STALE_TOKEN')
  })

  it('iLink 通道未初始化时不抛异常，而是记录 TRANSPORT_UNAVAILABLE', async () => {
    const { gateway, log } = createGateway()
    const result = await gateway.send({
      request_id: 'req-no-transport',
      to: 'user@im.wechat',
      type: 'text',
      msg: '测试',
      transport: 'ilink'
    })

    expect(result).toMatchObject({ success: false, error_code: 'TRANSPORT_UNAVAILABLE' })
    expect(log.list()[0].error_code).toBe('TRANSPORT_UNAVAILABLE')
  })

  it('不合法请求也会留下 INVALID_REQUEST 记录，而不是静默丢弃', async () => {
    const { gateway, log } = createGateway()
    const result = await gateway.send({ to: '', type: 'text', msg: '' })

    expect(result.success).toBe(false)
    expect(result.error_code).toBe('INVALID_REQUEST')
    expect(log.list()).toHaveLength(1)
    expect(log.list()[0].request_id).toBe('generated-1')
  })

  it('个人微信通道按 {to,isGroup,type,msg} 心智模型转发并记账', async () => {
    const received: unknown[] = []
    const { gateway, log } = createGateway({
      sendPersonal: async (request: never) => {
        received.push(request)
        return okResult
      }
    })

    const result = await gateway.send({
      request_id: 'req-personal',
      to: 'room@chatroom',
      type: 'text',
      msg: '群成员已退群',
      transport: 'personal',
      is_group: true
    })

    expect(result).toMatchObject({ success: true, transport: 'personal' })
    expect(received).toEqual([
      { to: 'room@chatroom', isGroup: true, type: 'text', text: '群成员已退群' }
    ])
    expect(log.list()[0]).toMatchObject({ transport: 'personal', status: 'sent' })
  })

  it('个人微信通道不支持文件类型时明确报错', async () => {
    const { gateway, log } = createGateway()
    const result = await gateway.send({
      request_id: 'req-file',
      to: 'wxid_demo',
      type: 'file',
      msg: '/tmp/report.pdf',
      transport: 'personal'
    })

    expect(result).toMatchObject({ success: false, error_code: 'UNSUPPORTED_TYPE' })
    expect(log.list()[0].error_code).toBe('UNSUPPORTED_TYPE')
  })

  it('sendPersonal 保留既有返回契约，并把同一次发送记入 Send Log', async () => {
    const received: unknown[] = []
    const { gateway, log } = createGateway({
      sendPersonal: async (request: never) => {
        received.push(request)
        return okResult
      }
    })

    const request = {
      to: 'room@chatroom',
      isGroup: true,
      type: 'text',
      text: '日报已发送'
    } as const
    const result = await gateway.sendPersonal(request)

    expect(result).toBe(okResult)
    expect(received[0]).toEqual(request)
    expect(log.list()).toHaveLength(1)
    expect(log.list()[0]).toMatchObject({ transport: 'personal', status: 'sent', type: 'text' })
  })

  it('Send Log 落盘内容不包含 context_token 与 bot_token', async () => {
    const { gateway, root } = createGateway({ sendIlink: async () => undefined })
    await gateway.send({
      request_id: 'req-secret',
      to: 'user@im.wechat',
      type: 'text',
      msg: '回复内容',
      context_token: 'ctx-SECRET-TOKEN',
      transport: 'ilink'
    })

    const raw = readFileSync(join(root, 'actions', 'wechat-send-log.json'), 'utf8')
    expect(raw).not.toContain('ctx-SECRET-TOKEN')
    expect(raw).not.toContain('SECRET')
  })
})
