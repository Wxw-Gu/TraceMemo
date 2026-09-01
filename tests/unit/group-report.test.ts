import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildGroupReportInput,
  getSummaryDateRangeAt,
  parseGroupDailyReport
} from '../../src/renderer/src/utils/group-report'
import { summaryContent } from '../../src/renderer/src/utils/group-report-facts'
import { summarySender } from '../../src/renderer/src/utils/group-report-facts'
import { selectHeroParticipantNames } from '../../src/shared/group-report'
import type { GroupReportMetadata } from '../../src/shared/group-report'
import type { Message } from '../../src/shared/types'

const metadata: GroupReportMetadata = {
  groupName: '测试群',
  reportDate: '2026-08-06',
  dateRange: '今日',
  messageCount: 3,
  activeUsers: 2,
  timeSpan: '1 h',
  generatedAt: '2026/8/6 12:00:00',
  recordNote: 'fixture',
  footerNote: '',
  heroParticipants: [],
  reportMode: 'full'
}

const media = {
  gallery: [],
  voiceHighlights: [],
  funBadges: []
}

const previousWindow = (globalThis as { window?: unknown }).window

afterEach(() => {
  if (previousWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window')
  } else {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

describe('group report parsing', () => {
  it('keeps only distinct real participants in the hero avatar list', () => {
    expect(
      selectHeroParticipantNames(['濑岛田井卫', '测试群昵称', '濑岛田井卫', '', '  '])
    ).toEqual(['濑岛田井卫', '测试群昵称'])
  })

  it('includes a cached voice transcript in the report input content', () => {
    const message: Message = {
      id: 'voice-1',
      from: 'member',
      type: '语音',
      datetime: '2026-08-06 10:00:00',
      content: '[语音]',
      isSender: false,
      contentData: { type: 'voice', duration: 3 },
      voiceTranscript: '今晚八点确认发布。'
    }

    expect(summaryContent(message)).toContain('今晚八点确认发布。')
  })

  it('includes a voice transcript when legacy cached messages have no contentData', () => {
    const message: Message = {
      id: 'voice-legacy',
      from: 'member',
      type: '语音',
      datetime: '2026-08-11 10:00:00',
      content: '[语音消息]',
      isSender: false,
      voiceTranscript: '能不能听见这个语音？'
    }

    expect(summaryContent(message)).toBe('[语音] 能不能听见这个语音？')
  })

  it('passes legacy voice transcripts into the daily-report model prompt', async () => {
    const message: Message = {
      id: 'voice-prompt',
      from: 'member',
      type: '语音',
      datetime: '2026-08-11 10:00:00',
      content: '[语音消息]',
      isSender: false,
      name: '测试成员',
      voiceTranscript: '试一下好不好使？'
    }

    const input = await buildGroupReportInput([message], null, true, 'full')

    expect(input.prompt).toContain('[语音] 试一下好不好使？')
  })

  it('labels system notices separately and excludes them from active members', async () => {
    const systemMessage: Message = {
      id: 'system-1',
      from: 'system',
      type: '系统消息',
      datetime: '2026-08-11 09:59:00',
      content: '由于账号安全原因，无法加入当前群聊。',
      isSender: false,
      contentData: {
        type: 'system',
        content: '由于账号安全原因，无法加入当前群聊。'
      }
    }
    const memberMessage: Message = {
      id: 'member-1',
      from: 'member',
      type: '普通文本',
      datetime: '2026-08-11 10:00:00',
      content: '收到',
      name: '测试成员',
      isSender: false
    }

    expect(summarySender(systemMessage, null, true)).toBe('微信系统消息')
    const input = await buildGroupReportInput([systemMessage, memberMessage], null, true, 'full')

    expect(input.metadata.activeUsers).toBe(1)
    expect(input.topSpeakers).toEqual([{ name: '测试成员', count: 1 }])
    expect(input.prompt).toContain('微信系统消息：由于账号安全原因，无法加入当前群聊。')
  })

  it('injects successful image insights into the model prompt and reports partial failures', async () => {
    const messages: Message[] = [
      {
        id: 'image-1',
        from: 'member',
        type: '图片',
        datetime: '2026-08-12 10:00:00',
        content: '[图片]',
        name: '成员一',
        isSender: false,
        sessionId: 'group@chatroom',
        contentData: { type: 'image', md5: 'a'.repeat(32), datName: 'one.dat' }
      },
      {
        id: 'image-2',
        from: 'member',
        type: '图片',
        datetime: '2026-08-12 10:01:00',
        content: '[图片]',
        name: '成员二',
        isSender: false,
        sessionId: 'group@chatroom',
        contentData: { type: 'image', md5: 'b'.repeat(32), datName: 'two.dat' }
      }
    ]
    const progress = vi.fn()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          imageListCandidates: vi.fn(async () => ({
            success: true,
            candidates: [
              {
                messageId: 'image-1',
                imageHash: 'a'.repeat(32),
                md5: 'a'.repeat(32),
                datName: 'one.dat',
                sessionId: 'group@chatroom',
                sender: '成员一',
                sentAt: new Date('2026-08-12 10:00:00').getTime(),
                heatScore: 10
              },
              {
                messageId: 'image-2',
                imageHash: 'b'.repeat(32),
                md5: 'b'.repeat(32),
                datName: 'two.dat',
                sessionId: 'group@chatroom',
                sender: '成员二',
                sentAt: new Date('2026-08-12 10:01:00').getTime(),
                heatScore: 9
              }
            ]
          })),
          getImage: vi.fn(async () => ({
            success: true,
            data: 'data:image/png;base64,fixture'
          })),
          imageAnalyze: vi
            .fn()
            .mockResolvedValueOnce({
              success: true,
              insight: {
                id: 'insight-1',
                messageId: 'image-1',
                imageHash: 'a'.repeat(32),
                description: '一张表格型网页截图，包含多列数据。',
                ocrText: '项目 状态 负责人',
                tags: ['表格', '管理界面'],
                category: 'screenshot',
                importance: 'medium',
                provider: 'vision-provider',
                model: 'vision-model',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                sender: '成员一',
                sentAt: new Date('2026-08-12 10:00:00').getTime(),
                sessionId: 'group@chatroom'
              }
            })
            .mockResolvedValueOnce({ success: false, error: 'fetch failed' })
        }
      }
    })

    const input = await buildGroupReportInput(messages, null, true, 'full', {
      onProgress: progress,
      visionModel: {
        providerId: 'selected-vision-provider',
        providerName: '视觉服务',
        model: 'selected-vision-model',
        modelName: '视觉模型',
        configured: true,
        status: 'connected'
      }
    })

    expect(window.api.imageAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'selected-vision-provider',
        modelId: 'selected-vision-model'
      })
    )

    expect(input.prompt).toContain('AI 图片识别摘要：')
    expect(input.prompt).toContain('一张表格型网页截图，包含多列数据。')
    expect(input.prompt).toContain('OCR: 项目 状态 负责人')
    expect(input.imageInsightSummary).toMatchObject({ total: 2, succeeded: 1, failed: 1 })
    expect(input.imageInsightSummary.failures[0]).toMatchObject({
      messageId: 'image-2',
      error: 'fetch failed'
    })
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'recognizingImages', completed: 2, total: 2 })
    )
  })

  it('falls back to topic keywords when the model omits top-level keywords', () => {
    const report = parseGroupDailyReport(
      JSON.stringify({
        topics: [
          {
            title: '健身安排',
            summary: '讨论训练时间和肌酸。',
            keywords: ['肌酸', '训练']
          }
        ]
      }),
      [],
      '',
      [],
      metadata,
      media
    )

    expect(report.keywords).toEqual(['肌酸', '训练', '健身安排'])
  })

  it('does not render the legacy gallery even when old report data contains it', () => {
    const report = parseGroupDailyReport(
      JSON.stringify({
        topics: [{ title: '图片话题', summary: '围绕图片展开讨论。', keywords: ['图片'] }]
      }),
      [],
      '',
      [],
      metadata,
      {
        gallery: [
          {
            sender: '成员一',
            time: '10:00',
            imageUrl: 'data:image/png;base64,fixture',
            note: '旧相册数据'
          }
        ],
        voiceHighlights: [],
        funBadges: []
      }
    )

    expect(report.media.gallery).toEqual([])
    expect(report.sectionMeta?.gallery).toMatchObject({ enabled: false, displayedCount: 0 })
  })

  it('allows a text report with zero AI images when no image reaches the hot threshold', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          imageListCandidates: vi.fn(async () => ({ success: true, candidates: [] })),
          getImage: vi.fn(),
          imageAnalyze: vi.fn()
        }
      }
    })

    const input = await buildGroupReportInput(
      [
        {
          id: 'cold-image',
          from: 'member',
          type: '图片',
          datetime: '2026-08-12 10:00:00',
          content: '[图片]',
          name: '成员一',
          isSender: false,
          sessionId: 'group@chatroom',
          contentData: { type: 'image', md5: 'c'.repeat(32), datName: 'cold.dat' }
        }
      ],
      null,
      true,
      'full'
    )

    expect(input.imageInsightSummary).toMatchObject({ total: 0, succeeded: 0, failed: 0 })
    expect(input.media.gallery).toEqual([])
  })
})
describe('summary date ranges', () => {
  it('uses local calendar days for today, yesterday, and seven-day ranges', () => {
    const now = new Date(2026, 0, 1, 12, 34, 56)
    const today = new Date(2026, 0, 1)
    const yesterday = new Date(2025, 11, 31)
    const sevenDaysAgo = new Date(2025, 11, 26)

    expect(getSummaryDateRangeAt('today', now)).toEqual({
      startTime: today.getTime() / 1000,
      endTime: now.getTime() / 1000
    })
    expect(getSummaryDateRangeAt('yesterday', now)).toEqual({
      startTime: yesterday.getTime() / 1000,
      endTime: today.getTime() / 1000 - 1
    })
    expect(getSummaryDateRangeAt('7days', now)).toEqual({
      startTime: sevenDaysAgo.getTime() / 1000,
      endTime: now.getTime() / 1000
    })
  })
})
