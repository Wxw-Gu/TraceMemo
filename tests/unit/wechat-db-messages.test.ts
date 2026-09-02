import { describe, expect, it, vi } from 'vitest'
import { WechatDb, type WechatMessage } from '../../src/main/wechat-db'

describe('WechatDb normalized messages', () => {
  it('keeps normalized identity fields when raw table columns conflict', async () => {
    const normalized = {
      mesLocalID: '1',
      serverId: 'server-1',
      mesDes: 0,
      messageType: '1',
      msgCreateTime: '1731327263',
      msgContent: 'fixture',
      sender: 'wxid_self',
      senderNickname: 'Nanin',
      raw: {
        mesDes: 1,
        sender: '',
        senderNickname: ''
      }
    }
    const client = { getMessagesAsync: vi.fn(async () => [normalized]) }
    const db = Object.assign(Object.create(WechatDb.prototype), {
      wcdb4Client: client,
      chatMd5ToUsername: new Map([['fixture-md5', 'fixture-user']]),
      ensureChatTableMapping: vi.fn()
    }) as WechatDb

    const start = Math.floor(new Date(2024, 10, 11).getTime() / 1000)
    const end = Math.floor(new Date(2024, 11, 1).getTime() / 1000)
    const messages = await db.getUserMessagesForExport('fixture-md5', start, end)

    expect(messages[0]).toMatchObject({
      mesDes: 0,
      sender: 'wxid_self',
      senderNickname: 'Nanin'
    })
  })

  it('passes time bounds, then filters, deduplicates and sorts in application code', async () => {
    const row = (id: string, createTime: number): WechatMessage => ({
      mesLocalID: id,
      serverId: `server-${id}`,
      mesDes: 0,
      messageType: '1',
      msgCreateTime: String(createTime),
      msgContent: id,
      raw: {}
    })
    const start = Math.floor(new Date(2025, 0, 1).getTime() / 1000)
    const end = Math.floor(new Date(2025, 0, 4).getTime() / 1000)
    const shardBoundaryMessage = row('jan-2-boundary', start + 32 * 60 * 60)
    const rows = [
      row('before-range', start - 1),
      row('newest', start + 48 * 60 * 60),
      shardBoundaryMessage,
      { ...shardBoundaryMessage },
      row('after-range', end + 1)
    ]
    const getMessagesAsync = vi.fn(
      async (_username: string, startTime?: number, endTime?: number) =>
        rows.filter((message) => {
          const createTime = Number(message.msgCreateTime)
          return (!startTime || createTime >= startTime) && (!endTime || createTime <= endTime)
        })
    )
    const db = Object.assign(Object.create(WechatDb.prototype), {
      wcdb4Client: { getMessagesAsync },
      chatMd5ToUsername: new Map([['fixture-md5', 'fixture-user']]),
      ensureChatTableMapping: vi.fn()
    }) as WechatDb

    const messages = await db.getUserMessagesForExport('fixture-md5', start, end)

    expect(getMessagesAsync).toHaveBeenCalledOnce()
    expect(getMessagesAsync).toHaveBeenCalledWith('fixture-user', start, end)
    expect(messages.map((message) => message.mesLocalID)).toEqual(['jan-2-boundary', 'newest'])
  })
})
