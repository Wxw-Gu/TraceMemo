import { describe, expect, it } from 'vitest'
import {
  buildGroupReportInput,
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

describe('group report parsing', () => {
  it('keeps only distinct real participants in the hero avatar list', () => {
    expect(
      selectHeroParticipantNames(['示例昵称', '测试群昵称', '示例昵称', '', '  '])
    ).toEqual(['示例昵称', '测试群昵称'])
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
})
