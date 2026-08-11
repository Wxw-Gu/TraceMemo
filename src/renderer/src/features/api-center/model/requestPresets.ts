export const REPORT_REQUEST_PRESET = JSON.stringify(
  {
    report: {
      overview: '请填入群聊日报概览',
      topics: [],
      resources: [],
      importantMessages: [],
      quotes: [],
      qa: [],
      analytics: { topicHeat: [], activeTimeline: '', topSpeakers: [] },
      keywords: []
    },
    metadata: {
      groupName: '技术交流',
      reportDate: '2026-07-13',
      dateRange: '2026-07-13 全天',
      messageCount: 0,
      activeUsers: 0,
      timeSpan: '00:00-23:59',
      generatedAt: '2026-07-13 22:00',
      recordNote: '本日报由 TraceMemo 自动生成',
      footerNote: '',
      heroParticipants: [],
      avatars: {},
      talker: '技术交流',
      timeRange: '2026-07-13'
    }
  },
  null,
  2
)

export const AGENT_GROUP_REPORT_PRESET = JSON.stringify(
  { group: '技术交流', range: 'today' },
  null,
  2
)

export const AGENT_SEND_PRESET = JSON.stringify(
  { to: '', text: 'TraceMemo Agent Hub 发送测试' },
  null,
  2
)
