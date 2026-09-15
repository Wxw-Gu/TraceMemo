import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WechatDb, WechatMessage } from '../../src/main/wechat-db'

vi.mock('../../src/main/services/recall-archive-service', () => ({
  recordRecallArchiveMessages: vi.fn(),
  mergeRecallArchiveMessages: (_md5: string, messages: unknown[]) => messages
}))

import {
  getImageMessageReference,
  listMessages,
  listMessagesAsync,
  setChatDb,
  type FormattedMessage
} from '../../src/main/services/chat-service'

const IMAGE_A = 'a'.repeat(32)
const IMAGE_B = 'b'.repeat(32)

/** Create a synthetic image row with an intentionally reusable local message ID. */
function image(md5: string, overrides: Partial<WechatMessage> = {}): WechatMessage {
  return {
    mesLocalID: '56',
    mesDes: 1,
    messageType: '3',
    msgCreateTime: '1756000000',
    msgContent: `<msg><img md5="${md5}" /></msg>`,
    serverId: '9007199254740993123',
    ...overrides
  }
}

/** Attach an in-memory fixture database without reading a real account. */
function connect(messages: Record<string, WechatMessage[]>): void {
  const client = { getUsernameByMd5: (md5: string) => `wxid_${md5}` }
  setChatDb({
    close: vi.fn(),
    getWcdb4Client: () => client,
    getUserMessages: (md5: string) => messages[md5] || [],
    getUserMessagesAsync: async (md5: string) => messages[md5] || []
  } as unknown as WechatDb)
}

/** Extract the opaque handle after checking the formatted image metadata. */
function mediaId(message: FormattedMessage): string {
  expect(message.media).toMatchObject({ type: 'image', available: true })
  return decodeURIComponent(message.media!.url.slice('/api/v1/media/'.length))
}

describe('chat service image media handles', () => {
  afterEach(() => setChatDb(null))

  it('keeps colliding local ids readable across conversations and repeated reads', async () => {
    connect({ first: [image(IMAGE_A)], second: [image(IMAGE_B)] })
    const first = listMessages('first')[0]
    const firstId = mediaId(first)
    expect(first.id).toBe('56')
    expect(firstId).toMatch(/^image:[a-f0-9]{64}$/)
    expect(firstId).not.toContain('wxid_first')
    expect(getImageMessageReference('56')?.imageMd5).toBe(IMAGE_A)

    const second = (await listMessagesAsync('second'))[0]
    const secondId = mediaId(second)
    expect(second.id).toBe(first.id)
    expect(secondId).not.toBe(firstId)
    expect(getImageMessageReference(firstId)).toMatchObject({
      sessionId: 'wxid_first',
      imageMd5: IMAGE_A
    })
    expect(getImageMessageReference(secondId)).toMatchObject({
      sessionId: 'wxid_second',
      imageMd5: IMAGE_B
    })
    expect(getImageMessageReference('56')).toBeNull()

    expect(mediaId(listMessages('first')[0])).toBe(firstId)
    expect(mediaId((await listMessagesAsync('second'))[0])).toBe(secondId)
    expect(getImageMessageReference(firstId)?.imageMd5).toBe(IMAGE_A)
    expect(getImageMessageReference(secondId)?.imageMd5).toBe(IMAGE_B)
    expect(getImageMessageReference('56')).toBeNull()
  })

  it('distinguishes images with the same local id within one conversation', () => {
    connect({ first: [image(IMAGE_A), image(IMAGE_B, { serverId: '9007199254740993124' })] })
    const [first, second] = listMessages('first').map(mediaId)
    expect(first).not.toBe(second)
    expect(getImageMessageReference(first)?.imageMd5).toBe(IMAGE_A)
    expect(getImageMessageReference(second)?.imageMd5).toBe(IMAGE_B)
    expect(getImageMessageReference('56')).toBeNull()
  })

  it('does not reuse media handles after reconnecting or switching accounts', () => {
    const messages = { first: [image(IMAGE_A)] }
    connect(messages)
    const previousId = mediaId(listMessages('first')[0])
    setChatDb(null)
    expect(getImageMessageReference(previousId)).toBeNull()
    connect(messages)
    const currentId = mediaId(listMessages('first')[0])
    expect(currentId).not.toBe(previousId)
    expect(getImageMessageReference(previousId)).toBeNull()
    expect(getImageMessageReference(currentId)?.imageMd5).toBe(IMAGE_A)
  })

  it('normalizes native server ids without losing integer precision', () => {
    const message = image(IMAGE_A, { serverId: 9007199254740993123n })
    connect({ first: [message] })
    const first = listMessages('first')[0]
    const firstId = mediaId(first)
    expect(first.serverId).toBe('9007199254740993123')
    expect(JSON.parse(JSON.stringify(first)).serverId).toBe('9007199254740993123')
    message.serverId = '9007199254740993123'
    const reread = listMessages('first')[0]
    expect(reread.serverId).toBe('9007199254740993123')
    expect(mediaId(reread)).toBe(firstId)
  })

  it.each([9007199254740992, null, undefined, false])(
    'omits unsupported server ID values (%s)',
    (serverId) => {
      connect({ first: [image(IMAGE_A, { serverId })] })
      const message = listMessages('first')[0]
      expect(message.serverId).toBeUndefined()
      expect(JSON.parse(JSON.stringify(message))).not.toHaveProperty('serverId')
    }
  )

  it('scopes recovered images and supports images identified only by dat name', () => {
    connect({
      first: [image(IMAGE_A, { _wxe_recovered: true })],
      second: [image(IMAGE_B, { _wxe_recovered: true })],
      third: [image('', { msgContent: JSON.stringify({ imageDatName: IMAGE_A }) })]
    })
    const first = listMessages('first')[0]
    const second = listMessages('second')[0]
    expect(first.id).toBe('recovered:56')
    expect(mediaId(second)).not.toBe(mediaId(first))
    expect(getImageMessageReference(mediaId(first))?.imageMd5).toBe(IMAGE_A)
    expect(getImageMessageReference(mediaId(second))?.imageMd5).toBe(IMAGE_B)
    expect(getImageMessageReference('recovered:56')).toBeNull()
    const third = listMessages('third')[0]
    expect(getImageMessageReference(mediaId(third))?.imageDatName).toBe(IMAGE_A)
  })

  it('does not add media handles to text messages', () => {
    connect({ first: [image(IMAGE_A, { messageType: '1', msgContent: 'text' })] })
    const message = listMessages('first')[0]
    expect(message.id).toBe('56')
    expect(message.media).toBeUndefined()
    expect(getImageMessageReference('56')).toBeNull()
  })
})
