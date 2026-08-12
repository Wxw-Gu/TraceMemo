import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getByHash } = vi.hoisted(() => ({ getByHash: vi.fn() }))

vi.mock('../../src/main/db/image-insights-store', () => ({
  imageInsightsStore: {
    getByHash,
    upsert: vi.fn(),
    listBySession: vi.fn()
  }
}))

import { imageInsightService } from '../../src/main/services/image-insight-service'

const query = {
  sessionId: 'group@chatroom',
  startTime: 0,
  endTime: Date.now(),
  limit: 3
}

const input = (id: string, responseCount: number, interactionCount: number): {
  messageId: string
  md5: string
  sessionId: string
  sender: string
  sentAt: number
  responseCount: number
  interactionCount: number
} => ({
  messageId: id,
  md5: id.repeat(32).slice(0, 32),
  sessionId: 'group@chatroom',
  sender: id,
  sentAt: Date.now(),
  responseCount,
  interactionCount
})

describe('ImageInsightService hot image selection', () => {
  beforeEach(() => {
    getByHash.mockReset()
    getByHash.mockReturnValue(null)
  })

  it('returns fewer than three images when only two pass the hot threshold', async () => {
    const result = await imageInsightService.listTopHotImages(query, [
      input('a', 3, 0),
      input('b', 1, 1),
      input('c', 1, 0),
      input('d', 0, 5),
      input('e', 0, 0)
    ])

    expect(result.map((item) => item.messageId)).toEqual(['a', 'b'])
  })

  it('keeps the three highest-scoring hot images when more are eligible', async () => {
    const result = await imageInsightService.listTopHotImages(query, [
      input('a', 2, 0),
      input('b', 5, 0),
      input('c', 1, 1),
      input('d', 3, 1)
    ])

    expect(result.map((item) => item.messageId)).toEqual(['b', 'd', 'a'])
    expect(result).toHaveLength(3)
  })

  it('returns no candidates when no image has meaningful follow-up activity', async () => {
    const result = await imageInsightService.listTopHotImages(query, [
      input('a', 1, 0),
      input('b', 0, 4),
      input('c', 0, 0)
    ])

    expect(result).toEqual([])
  })

  it('keeps a cached insight attached to an eligible candidate', async () => {
    const cached = { imageHash: 'a'.repeat(32), description: '缓存识别结果' }
    getByHash.mockImplementation((hash: string) => (hash === 'a'.repeat(32) ? cached : null))

    const result = await imageInsightService.listTopHotImages(query, [input('a', 2, 0)])

    expect(result[0]).toMatchObject({ messageId: 'a', insight: cached })
  })
})
