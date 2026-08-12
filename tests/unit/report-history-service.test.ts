import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { GroupDailyReport, GroupReportMetadata } from '../../src/shared/group-report'

const root = mkdtempSync(join(tmpdir(), 'tracememo-report-history-'))

vi.mock('electron', () => ({
  app: { getPath: () => root },
  nativeImage: {
    createFromPath: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 430, height: 1200 })
    })
  }
}))

const reportSnapshot = {
  overview: '已生成的结构化日报',
  topics: [],
  resources: [],
  importantMessages: [],
  quotes: [],
  qa: [],
  todos: [],
  unresolved: [],
  storylines: [],
  reversals: [],
  participantChains: [],
  analytics: {
    topicHeat: [],
    activeTimeline: '',
    topSpeakers: [],
    voiceLeaderboard: []
  },
  keywords: [],
  media: { gallery: [], visionGallery: [], voiceHighlights: [], funBadges: [] }
} satisfies GroupDailyReport

const reportMetadata = {
  groupName: '测试群',
  reportDate: '2026-08-12',
  dateRange: '今天',
  messageCount: 10,
  activeUsers: 3,
  timeSpan: '09:00–18:00',
  generatedAt: '2026-08-12T10:00:00.000Z',
  recordNote: '',
  footerNote: '',
  heroParticipants: [],
  avatars: {}
} satisfies GroupReportMetadata

describe('generated report template history', () => {
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('replaces the current report assets while preserving its structured snapshot and id', async () => {
    const originalHtml = join(root, 'original.html')
    const switchedHtml = join(root, 'switched.html')
    writeFileSync(originalHtml, '<h1>Mobile 01</h1>')
    writeFileSync(switchedHtml, '<h1>Mobile 03</h1>')
    const { saveGeneratedReport, updateGeneratedReportTemplate } =
      await import('../../src/main/report-history-service')

    const saved = await saveGeneratedReport({
      contactId: 'group-md5',
      contactName: '测试群',
      dateRange: '今天',
      messageCount: 10,
      generatedAt: '2026-08-12T10:00:00.000Z',
      generatedImage: `data:image/png;base64,${Buffer.from('mobile-01').toString('base64')}`,
      htmlPath: originalHtml,
      reportSnapshot,
      reportMetadata,
      templateId: 'mobile-feed'
    })
    expect(saved.success).toBe(true)
    expect(saved.record).toBeDefined()

    const updated = await updateGeneratedReportTemplate({
      reportId: saved.record!.id,
      templateId: 'mobile-dashboard',
      generatedImage: `data:image/png;base64,${Buffer.from('mobile-03').toString('base64')}`,
      htmlPath: switchedHtml
    })

    expect(updated.success).toBe(true)
    expect(updated.record).toMatchObject({
      id: saved.record!.id,
      templateId: 'mobile-dashboard',
      reportSnapshot,
      reportMetadata
    })
    expect(readFileSync(updated.record!.htmlPath!, 'utf8')).toContain('Mobile 03')
    expect(readFileSync(updated.record!.pngPath!).toString()).toBe('mobile-03')
    expect(JSON.parse(readFileSync(updated.record!.jsonPath!, 'utf8'))).toMatchObject({
      id: saved.record!.id,
      templateId: 'mobile-dashboard',
      reportSnapshot,
      reportMetadata
    })
  })

  it('keeps legacy records viewable but rejects a lossless template switch', async () => {
    const legacyHtml = join(root, 'legacy.html')
    writeFileSync(legacyHtml, '<h1>Legacy</h1>')
    const { saveGeneratedReport, updateGeneratedReportTemplate } =
      await import('../../src/main/report-history-service')
    const saved = await saveGeneratedReport({
      contactId: 'legacy-group',
      contactName: '旧报告',
      dateRange: '今天',
      messageCount: 5,
      generatedAt: '2026-08-12T11:00:00.000Z',
      generatedImage: `data:image/png;base64,${Buffer.from('legacy').toString('base64')}`,
      htmlPath: legacyHtml
    })

    const updated = await updateGeneratedReportTemplate({
      reportId: saved.record!.id,
      templateId: 'desktop-editorial',
      generatedImage: `data:image/png;base64,${Buffer.from('new').toString('base64')}`,
      htmlPath: legacyHtml
    })

    expect(updated).toEqual({
      success: false,
      error: '旧报告未保存结构化数据，无法无损切换模板'
    })
  })

  it('extracts and persists a render snapshot once for legacy template switching', async () => {
    const legacyHtml = join(root, 'legacy-with-html.html')
    writeFileSync(legacyHtml, '<h1>Legacy source</h1>')
    const { saveGeneratedReport, prepareGeneratedReportTemplateSwitch } =
      await import('../../src/main/report-history-service')
    const saved = await saveGeneratedReport({
      contactId: 'legacy-snapshot-group',
      contactName: '旧报告快照',
      dateRange: '今天',
      messageCount: 8,
      generatedAt: '2026-08-12T12:00:00.000Z',
      generatedImage: `data:image/png;base64,${Buffer.from('legacy-snapshot').toString('base64')}`,
      htmlPath: legacyHtml
    })
    const extractSnapshot = vi.fn(async () => ({
      groupName: '旧报告快照',
      reportDate: '2026-08-12',
      values: { REPORT_TITLE: '旧报告快照日报', TOPIC_CARDS: '<div>已有主题</div>' }
    }))

    const first = await prepareGeneratedReportTemplateSwitch(saved.record!.id, extractSnapshot)
    const second = await prepareGeneratedReportTemplateSwitch(saved.record!.id, extractSnapshot)

    expect(first).toEqual(second)
    expect(extractSnapshot).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(saved.record!.jsonPath!, 'utf8'))).toMatchObject({
      id: saved.record!.id,
      reportRenderSnapshot: first.snapshot
    })
  })

  it('persists the classic v1 template as a selectable history template', async () => {
    const classicHtml = join(root, 'classic.html')
    writeFileSync(classicHtml, '<h1>经典日报</h1>')
    const { saveGeneratedReport } = await import('../../src/main/report-history-service')
    const saved = await saveGeneratedReport({
      contactId: 'classic-group',
      contactName: '经典日报群',
      dateRange: '今天',
      messageCount: 6,
      generatedAt: '2026-08-12T13:00:00.000Z',
      generatedImage: `data:image/png;base64,${Buffer.from('classic').toString('base64')}`,
      htmlPath: classicHtml,
      reportSnapshot,
      reportMetadata,
      templateId: 'v1'
    })

    expect(saved.success).toBe(true)
    expect(saved.record?.templateId).toBe('v1')
    expect(JSON.parse(readFileSync(saved.record!.jsonPath!, 'utf8')).templateId).toBe('v1')
  })
})
