import { describe, expect, it } from 'vitest'
import { parseGroupDailyReport } from '../../src/renderer/src/utils/group-report'
import type { GroupReportMetadata } from '../../src/shared/group-report'

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
