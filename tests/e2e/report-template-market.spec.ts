import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('REPORT-TEMPLATE-MARKET-E2E-01 reads, installs, restores, renders, and switches published templates', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'tracememo-template-market-user-'))
  const outputDir = mkdtempSync(join(tmpdir(), 'tracememo-template-market-output-'))
  const launch = (): ReturnType<typeof electron.launch> =>
    electron.launch({
      args: [resolve('out/main/reportTemplateTest.js')],
      env: {
        ...process.env,
        TRACEMEMO_TEMPLATE_TEST_USER_DATA: userData,
        TRACEMEMO_REPORT_OUTPUT_DIR: outputDir
      }
    })

  const report = {
    overview: '虚构远端模板日报概览',
    hero: {
      headline: '今日群聊重点',
      summary: '虚构的结构化日报内容',
      keyTakeaway: '保留结构化快照并切换版式',
      pendingNote: '',
      statusLine: ''
    },
    topics: [
      {
        title: '模板市场联调',
        timeRange: '09:00-10:00',
        heat: '高' as const,
        participants: ['小明'],
        summary: '验证安装、重启恢复和导出',
        keywords: ['模板', '日报'],
        messages: []
      }
    ],
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
      topicHeat: [{ topic: '模板市场联调', score: 1 }],
      activeTimeline: '09:00-10:00',
      topSpeakers: [{ name: '小明', count: 1 }],
      voiceLeaderboard: []
    },
    keywords: ['模板', '日报'],
    media: { gallery: [], voiceHighlights: [], funBadges: [] }
  }
  const metadata = {
    groupName: '虚构市场验收群',
    reportDate: '2026-09-07',
    dateRange: '今日',
    messageCount: 1,
    activeUsers: 1,
    timeSpan: '09:00-10:00',
    generatedAt: '2026-09-07 10:00',
    recordNote: 'fixture',
    footerNote: 'market fixture',
    heroParticipants: ['小明'],
    avatars: {}
  }

  let app: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    app = await launch()
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const catalogResult = await page.evaluate(() => window.api.listReportTemplateCatalog())
    expect(catalogResult.success, catalogResult.error).toBe(true)
    const catalog = catalogResult.catalog
    expect(catalog?.status).toBe('published')
    expect(catalog?.templates).toHaveLength(3)
    const sourceCommit = catalog?.source?.commit
    expect(sourceCommit).toMatch(/^[a-f0-9]{40}$/)
    const entries = catalog!.templates
    expect(new Set(entries.map((entry) => entry.id))).toEqual(
      new Set([
        'community.github.tracememo.quickread',
        'community.github.tracememo.paperdaily',
        'community.github.tracememo.teamboard'
      ])
    )
    for (const entry of entries) {
      expect(entry.interfaceVersion).toBe('1')
      expect(entry.status).toBe('published')
      expect(entry.download).toContain(`/Wxw-Gu/TraceMemo-Templates/${sourceCommit}/`)
      expect(entry.preview).toContain(`/Wxw-Gu/TraceMemo-Templates/${sourceCommit}/`)
    }

    const exportsById = new Map<
      string,
      { htmlPath: string; pngPath: string; imageDataUrl: string; version: string }
    >()
    for (const entry of entries) {
      const installed = await page.evaluate(
        async ({ id, version }) => window.api.installReportTemplateFromCatalog(id, version),
        { id: entry.id, version: entry.version }
      )
      expect(installed.success, installed.error).toBe(true)
      expect(installed.catalogEntry?.sha256).toBe(entry.sha256)
      expect(installed.template?.id).toBe(entry.id)
      expect(installed.template?.version).toBe(entry.version)

      const exported = await page.evaluate(
        async ({ id, version, reportValue, metadataValue }) =>
          window.api.exportGroupReport({
            templateRef: { id, version },
            report: reportValue,
            metadata: metadataValue
          }),
        { id: entry.id, version: entry.version, reportValue: report, metadataValue: metadata }
      )
      expect(exported.success, exported.error).toBe(true)
      expect(exported.htmlPath).toBeTruthy()
      expect(exported.pngPath).toBeTruthy()
      expect(readFileSync(exported.htmlPath!, 'utf8')).toContain('虚构的结构化日报内容')
      const png = readFileSync(exported.pngPath!)
      expect(png.length).toBeGreaterThan(1000)
      expect(png.readUInt32BE(16)).toBe(entry.platform === 'desktop' ? 1440 : 430)
      expect(png.readUInt32BE(20)).toBeGreaterThan(100)
      exportsById.set(entry.id, {
        htmlPath: exported.htmlPath!,
        pngPath: exported.pngPath!,
        imageDataUrl: exported.imageDataUrl!,
        version: entry.version
      })
    }

    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const restored = await page.evaluate(() => window.api.listReportTemplates())
    for (const entry of entries) {
      expect(
        restored.some((template) => template.id === entry.id && template.version === entry.version)
      ).toBe(true)
    }

    const quickread = entries.find((entry) => entry.id.endsWith('.quickread'))!
    const paperdaily = entries.find((entry) => entry.id.endsWith('.paperdaily'))!
    const firstExport = exportsById.get(quickread.id)!
    const saved = await page.evaluate(
      async ({ firstExportValue, reportValue, metadataValue, templateId }) =>
        window.api.saveGeneratedReport({
          contactId: 'fixture-market-group',
          contactName: metadataValue.groupName,
          source: 'manual',
          dateRange: metadataValue.dateRange,
          messageCount: metadataValue.messageCount,
          generatedAt: '2026-09-07T10:00:00.000Z',
          reportDate: metadataValue.reportDate,
          generatedImage: firstExportValue.imageDataUrl,
          htmlPath: firstExportValue.htmlPath,
          pngPath: firstExportValue.pngPath,
          reportSnapshot: reportValue,
          reportMetadata: metadataValue,
          templateId
        }),
      {
        firstExportValue: firstExport,
        reportValue: report,
        metadataValue: metadata,
        templateId: `external:${quickread.id}@${quickread.version}`
      }
    )
    expect(saved.success, saved.error).toBe(true)
    const reportId = saved.record!.id

    const switchedExport = await page.evaluate(
      async ({ id, version, reportValue, metadataValue }) =>
        window.api.exportGroupReport({
          templateRef: { id, version },
          report: reportValue,
          metadata: metadataValue
        }),
      { id: paperdaily.id, version: paperdaily.version, reportValue: report, metadataValue: metadata }
    )
    expect(switchedExport.success, switchedExport.error).toBe(true)
    const switched = await page.evaluate(
      async ({ reportIdValue, id, version, exported }) =>
        window.api.updateGeneratedReportTemplate({
          reportId: reportIdValue,
          templateId: `external:${id}@${version}`,
          templateRef: { id, version },
          generatedImage: exported.imageDataUrl,
          htmlPath: exported.htmlPath,
          pngPath: exported.pngPath
        }),
      {
        reportIdValue: reportId,
        id: paperdaily.id,
        version: paperdaily.version,
        exported: {
          imageDataUrl: switchedExport.imageDataUrl!,
          htmlPath: switchedExport.htmlPath!,
          pngPath: switchedExport.pngPath!
        }
      }
    )
    expect(switched.success, switched.error).toBe(true)
    expect(switched.record?.id).toBe(reportId)
    expect(switched.record?.templateId).toBe(`external:${paperdaily.id}@${paperdaily.version}`)
    expect(switched.record?.reportSnapshot).toEqual(report)
    expect(readFileSync(switched.record!.htmlPath!, 'utf8')).toContain('虚构的结构化日报内容')

    const history = await page.evaluate(() => window.api.listGeneratedReports())
    expect(history.success).toBe(true)
    expect(history.reports?.find((record) => record.id === reportId)?.templateId).toBe(
      `external:${paperdaily.id}@${paperdaily.version}`
    )

    const removed = await page.evaluate(
      async ({ id, version }) => window.api.uninstallReportTemplate(id, version),
      { id: paperdaily.id, version: paperdaily.version }
    )
    expect(removed.success, removed.error).toBe(true)
    const afterUninstall = await page.evaluate(
      async ({ id, version, reportValue, metadataValue }) =>
        window.api.exportGroupReport({
          templateRef: { id, version },
          report: reportValue,
          metadata: metadataValue
        }),
      { id: paperdaily.id, version: paperdaily.version, reportValue: report, metadataValue: metadata }
    )
    expect(afterUninstall.success).toBe(false)
    expect(afterUninstall.error).toContain('模板不存在')

    const legacyHtml = join(outputDir, 'legacy-without-structured-data.html')
    writeFileSync(legacyHtml, '<!doctype html><html><body><h1>旧日报</h1></body></html>')
    const legacy = await page.evaluate(
      async ({ htmlPath, pngPath, imageDataUrl }) =>
        window.api.saveGeneratedReport({
          contactId: 'fixture-legacy-group',
          contactName: '虚构旧日报',
          dateRange: '今日',
          messageCount: 1,
          generatedAt: '2026-09-07T11:00:00.000Z',
          htmlPath,
          pngPath,
          generatedImage: imageDataUrl
        }),
      { htmlPath: legacyHtml, pngPath: firstExport.pngPath, imageDataUrl: firstExport.imageDataUrl }
    )
    expect(legacy.success).toBe(true)
    const legacySwitch = await page.evaluate(
      async ({ reportIdValue, id, version, imageDataUrl, htmlPath }) =>
        window.api.updateGeneratedReportTemplate({
          reportId: reportIdValue,
          templateId: `external:${id}@${version}`,
          templateRef: { id, version },
          generatedImage: imageDataUrl,
          htmlPath,
          pngPath: htmlPath
        }),
      {
        reportIdValue: legacy.record!.id,
        id: quickread.id,
        version: quickread.version,
        imageDataUrl: firstExport.imageDataUrl,
        htmlPath: legacyHtml
      }
    )
    expect(legacySwitch.success).toBe(false)
    expect(legacySwitch.error).toContain('旧报告未保存结构化数据')
  } finally {
    if (app) await app.close()
    rmSync(outputDir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  }
})
