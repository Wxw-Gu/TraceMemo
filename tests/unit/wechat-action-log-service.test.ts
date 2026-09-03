import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/services/chat-service', () => ({ listContacts: vi.fn(() => []) }))
vi.mock('../../src/main/services/wechat-action-gateway', () => ({
  wechatActionGateway: { listAuditRecords: vi.fn(() => []) }
}))

import { WechatActionLogService } from '../../src/main/services/wechat-action-log-service'
import type { WechatActionAuditRecord } from '../../src/shared/wechat-action'

const records: WechatActionAuditRecord[] = [
  {
    actionId: 'older',
    origin: 'member_monitor',
    purpose: 'member_left_notification',
    triggerType: 'automation',
    recipientType: 'group',
    recipientId: 'room@chatroom',
    contentType: 'text',
    contentPreview: 'Shinven 已退出群聊',
    createdAt: '2026-09-03T07:00:00.000Z',
    startedAt: '2026-09-03T07:00:00.000Z',
    finishedAt: '2026-09-03T07:00:01.000Z',
    decision: 'allow',
    sendStatus: 'sent'
  },
  {
    actionId: 'newer',
    origin: 'scheduled_report',
    purpose: 'scheduled_report',
    triggerType: 'automation',
    recipientType: 'group',
    recipientId: 'other@chatroom',
    recipientName: '审计内名称',
    contentType: 'image',
    contentPreview: 'report.png',
    createdAt: '2026-09-03T08:00:00.000Z',
    startedAt: '2026-09-03T08:00:00.000Z',
    finishedAt: '2026-09-03T08:00:02.000Z',
    decision: 'allow',
    decisionReason: '发送失败',
    sendStatus: 'failed',
    errorCode: 'SEND_FAILED'
  }
]

describe('WechatActionLogService', () => {
  it('reuses audit records, resolves current contact names, and returns newest first', () => {
    const service = new WechatActionLogService({
      listAuditRecords: () => records,
      listContacts: () => [
        {
          m_nsUsrName: 'room@chatroom',
          m_nsNickName: '测试群',
          md5: 'room',
          type: 'group'
        }
      ]
    })

    expect(service.list()).toEqual([
      expect.objectContaining({
        id: 'newer',
        category: 'wechat_send',
        source: 'scheduled_report',
        recipientName: '审计内名称',
        status: 'failed'
      }),
      expect.objectContaining({
        id: 'older',
        recipientName: '测试群',
        contentPreview: 'Shinven 已退出群聊',
        status: 'sent'
      })
    ])
  })

  it('still lists audit history when contacts are unavailable', () => {
    const service = new WechatActionLogService({
      listAuditRecords: () => records.slice(0, 1),
      listContacts: () => {
        throw new Error('database unavailable')
      }
    })

    expect(service.list()[0]).toMatchObject({ id: 'older', recipientId: 'room@chatroom' })
  })
})
