import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tracememo-readonly-test' }
}))

import { READ_ONLY_ENV, isReadOnlyMode } from '../../src/main/services/read-only-mode'
import { WechatActionGateway } from '../../src/main/services/wechat-action-gateway'
import { reconcileMsgInsertRules } from '../../src/main/services/msg-insert-switch-service'
import { AutomationService } from '../../src/main/services/automation-service'
import { personalWechatSendService } from '../../src/main/services/personal-wechat-send-service'
import { wechatLocalExitNoticeService } from '../../src/main/services/wechat-local-exit-notice-service'

/**
 * 只读闸门的有效性：不是「复制了 profile」，而是真实写入入口被短路。
 */

const original = process.env[READ_ONLY_ENV]

beforeEach(() => {
  delete process.env[READ_ONLY_ENV]
})

afterEach(() => {
  if (original === undefined) delete process.env[READ_ONLY_ENV]
  else process.env[READ_ONLY_ENV] = original
})

describe('isReadOnlyMode', () => {
  it('默认关闭，只有显式真值才开启', () => {
    expect(isReadOnlyMode()).toBe(false)
    for (const value of ['1', 'true', 'YES', 'on']) {
      process.env[READ_ONLY_ENV] = value
      expect(isReadOnlyMode()).toBe(true)
    }
    for (const value of ['0', 'false', '', 'off']) {
      process.env[READ_ONLY_ENV] = value
      expect(isReadOnlyMode()).toBe(false)
    }
  })
})

describe('只读模式下的写入入口', () => {
  it('发送网关直接 blocked，不调用底层 send', async () => {
    process.env[READ_ONLY_ENV] = '1'
    const send = vi.fn()
    const gateway = new WechatActionGateway({
      getCapability: vi.fn() as never,
      send: send as never,
      getUserDataPath: () => path.join(os.tmpdir(), 'tracememo-readonly-test'),
      now: () => new Date('2026-11-20T00:00:00.000Z'),
      wait: async () => undefined
    })

    const result = await gateway.execute({
      origin: 'http_api',
      purpose: 'manual_text',
      triggerType: 'user',
      recipient: { type: 'contact', id: 'filehelper' },
      content: { type: 'text', text: '必须被拦住' }
    })

    expect(result.status).toBe('blocked')
    expect(result.errorCode).toBe('READ_ONLY_MODE')
    expect(send).not.toHaveBeenCalled()
  })

  it('MsgInsert reconciliation 不 spawn helper，直接返回 READ_ONLY_MODE', async () => {
    process.env[READ_ONLY_ENV] = '1'
    const result = await reconcileMsgInsertRules({
      client: {} as never,
      monitoredRoomIds: [],
      myWxid: 'wxid_fixture',
      databaseKey: 'key_fixture'
    })
    expect(result).toEqual({
      done: false,
      rooms: 0,
      written: 0,
      errorCode: 'READ_ONLY_MODE'
    })
  })

  it('Automation 不读规则、不执行定时任务', async () => {
    process.env[READ_ONLY_ENV] = '1'
    const listRules = vi.fn(() => [])
    const ruleStore = { listRules, getRule: vi.fn() } as never
    const service = new AutomationService({} as never, {
      ruleStore,
      executionLog: { record: vi.fn() } as never,
      runner: {} as never,
      isListening: () => true
    })

    await service.handleMessage({
      sessionId: 'fixture@chatroom',
      localId: '1',
      createTime: 1_800_000_000,
      messageType: 1,
      isSelf: false,
      content: '@机器人 日报',
      isGroup: true,
      mentionTargets: []
    })
    expect(listRules).not.toHaveBeenCalled()

    await expect(
      service.executeScheduledRule('rule-1', { trigger: 'schedule' })
    ).resolves.toEqual({ executed: false, reason: 'read_only' })
  })

  it('个人发送服务直连入口（语音 IPC 旁路）同样 blocked', async () => {
    process.env[READ_ONLY_ENV] = '1'
    const statusSpy = vi
      .spyOn(personalWechatSendService, 'getStatus')
      .mockResolvedValue({ state: 'ready' } as never)

    const result = await personalWechatSendService.send({
      to: 'filehelper',
      isGroup: false,
      type: 'text',
      text: '必须被拦住'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('只读测试模式')
    statusSpy.mockRestore()
  })

  it('退群本地提示不写微信库', async () => {
    process.env[READ_ONLY_ENV] = '1'
    const result = await wechatLocalExitNoticeService.handleExitEvent({
      eventId: 'fixture-event',
      conversationId: 'fixture@chatroom',
      memberWxid: 'wxid_fixture',
      memberName: '测试成员',
      occurredAt: 1_800_000_000
    } as never)

    expect(result).toMatchObject({ outcome: 'disabled', code: 'READ_ONLY_MODE' })
  })
})
