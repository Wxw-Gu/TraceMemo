import { describe, expect, it } from 'vitest'
import { parseGroupDailyReport } from '../../src/renderer/src/utils/group-report'
import { summaryContent } from '../../src/renderer/src/utils/group-report-facts'
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
