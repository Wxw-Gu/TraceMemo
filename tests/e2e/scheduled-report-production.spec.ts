import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  normalizeRuleDraft,
  type AutomationExecution,
  type AutomationRule
} from '../../src/shared/automation'
import type { GeneratedReportRecord } from '../../src/shared/report-history'

/**
 * Build with TRACEMEMO_SCHEDULED_E2E=1. Unlike the UI fixture, this launches real
 * scheduler/service/runner/generator/render/history code. Only WeChat rows and
 * the subscription network boundary are synthetic; no account or key is used.
 */
interface Snapshot {
  rules: AutomationRule[]
  executions: AutomationExecution[]
  subscriptionCalls: { providerId: string; model: string; hasSyntheticInput: boolean }[]
  sendCalls: number
  capabilityCalls: number
  reports: (GeneratedReportRecord & { decodedSize: { width: number; height: number } })[]
}
interface TestControl {
  tick(at: number): Promise<void>
  inspect(): Promise<Snapshot>
  setSubscriptionOffline(): void
}
const inspect = (app: ElectronApplication) =>
  app.evaluate(() =>
    (
      globalThis as unknown as { __scheduledReportTest: TestControl }
    ).__scheduledReportTest.inspect()
  )
const tick = (app: ElectronApplication, at: number) =>
  app.evaluate(
    (_, time) =>
      (globalThis as unknown as { __scheduledReportTest: TestControl }).__scheduledReportTest.tick(
        time
      ),
    at
  )

function assertArtifacts(record: Snapshot['reports'][number], userData: string): void {
  expect(record.source).toBe('scheduled')
  expect(record.modelName).toBe('ChatGPT 订阅 · synthetic-model')
  expect(record.messageCount).toBe(1)
  expect(record.htmlStatus).toBe('ready')
  expect(record.pngStatus).toBe('ready')
  expect(record.htmlPath!.startsWith(userData)).toBe(true)
  expect(record.pngPath!.startsWith(userData)).toBe(true)
  const html = readFileSync(record.htmlPath!, 'utf8')
  expect(html).toContain('蓝莓计划')
  expect(html).toContain('合成管道测试群')
  const png = readFileSync(record.pngPath!)
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(png.length).toBeGreaterThan(1000)
  expect(record.decodedSize.width).toBeGreaterThan(100)
  expect(record.decodedSize.height).toBeGreaterThan(400)
  const persisted = JSON.parse(readFileSync(record.jsonPath!, 'utf8'))
  expect(persisted.id).toBe(record.id)
  expect(persisted.reportSnapshot.overview).toContain('蓝莓计划已经完成')
  expect(persisted.reportMetadata.messageCount).toBe(1)
}

test('production subscription report renders, persists, schedules once across restart and never sends WeChat', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const entry = resolve('out/main/scheduledReportTest.js')
  expect(existsSync(entry), 'Build first: TRACEMEMO_SCHEDULED_E2E=1 electron-vite build').toBe(true)
  const userData = mkdtempSync(join(tmpdir(), 'tracememo-scheduled-production-user-'))
  const outputDir = mkdtempSync(join(tmpdir(), 'tracememo-scheduled-production-output-'))
  const launch = () =>
    electron.launch({
      args: [entry],
      env: {
        ...process.env,
        TRACEMEMO_SCHEDULED_TEST_USER_DATA: userData,
        TRACEMEMO_REPORT_OUTPUT_DIR: outputDir
      }
    })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const draft = normalizeRuleDraft({
      name: 'Synthetic subscription daily report',
      enabled: true,
      ruleType: 'scheduled_report',
      scheduledReport: {
        deliveryMode: 'local_only',
        schedule: { time: '09:00' },
        report: {
          sourceConversationId: 'synthetic@chatroom',
          range: 'yesterday',
          messageTypes: ['text'],
          templateId: 'v1',
          memberNameMode: 'groupNickname',
          timeoutSeconds: 300,
          providerId: 'chatgpt-plan:synthetic',
          model: 'synthetic-model',
          chatgptConsent: true
        },
        // A deliberately stale sending target must not interfere with local generation.
        target: { type: 'contact', contactId: 'missing-target' },
        targetNeedsReview: true
      }
    })
    const rule = await page.evaluate((value) => window.api.createAutomationRule(value), draft)
    const manual = await page.evaluate((id) => window.api.runScheduledReportRule(id), rule.id)
    expect(manual.success, manual.error).toBe(true)
    let snapshot = await inspect(app)
    expect(snapshot.reports).toHaveLength(1)
    assertArtifacts(snapshot.reports[0], userData)
    expect(snapshot.executions[0]).toMatchObject({ trigger: 'manual', status: 'success' })
    expect(snapshot.rules[0].scheduledReport?.lastScheduledSlot).toBeUndefined()
    expect(snapshot.subscriptionCalls).toEqual([
      { providerId: 'chatgpt-plan:synthetic', model: 'synthetic-model', hasSyntheticInput: true }
    ])

    const dueAt = new Date(2026, 7, 27, 9, 1).getTime()
    await tick(app, dueAt)
    await tick(app, dueAt)
    snapshot = await inspect(app)
    expect(snapshot.reports).toHaveLength(2)
    expect(
      snapshot.executions.filter((execution) => execution.trigger === 'schedule')
    ).toHaveLength(1)
    expect(snapshot.subscriptionCalls).toHaveLength(2)
    for (const report of snapshot.reports) assertArtifacts(report, userData)
    expect(new Set(snapshot.reports.map((report) => report.pngPath)).size).toBe(2)
    expect(snapshot.rules[0].scheduledReport?.lastScheduledSlot).toBe(
      new Date(2026, 7, 27, 9, 0).toISOString()
    )
    expect(snapshot.sendCalls).toBe(0)
    expect(snapshot.capabilityCalls).toBe(0)
    for (const execution of snapshot.executions) {
      expect(execution.status).toBe('success')
      expect(execution.steps.find((step) => step.key === 'report_generated')?.status).toBe(
        'success'
      )
      expect(execution.steps.find((step) => step.key === 'report_sent')?.status).toBe('skipped')
    }
    await testInfo.attach('real-local-report.png', {
      path: snapshot.reports[0].pngPath!,
      contentType: 'image/png'
    })
    const reportIds = snapshot.reports.map((report) => report.id).sort()

    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await tick(app, dueAt)
    snapshot = await inspect(app)
    expect(snapshot.rules).toHaveLength(1)
    expect(snapshot.rules[0].id).toBe(rule.id)
    expect(snapshot.rules[0].scheduledReport?.report).toMatchObject({
      providerId: 'chatgpt-plan:synthetic',
      model: 'synthetic-model',
      chatgptConsent: true
    })
    expect(snapshot.reports.map((report) => report.id).sort()).toEqual(reportIds)
    expect(snapshot.executions).toHaveLength(2)
    expect(snapshot.subscriptionCalls).toHaveLength(0)

    // A disconnected subscription must fail rather than return an old image or fall back.
    await app.evaluate(() =>
      (
        globalThis as unknown as { __scheduledReportTest: TestControl }
      ).__scheduledReportTest.setSubscriptionOffline()
    )
    const failed = await page.evaluate((id) => window.api.runScheduledReportRule(id), rule.id)
    expect(failed.success).toBe(false)
    expect(failed.error).toBe('Synthetic subscription disconnected')
    snapshot = await inspect(app)
    expect(snapshot.reports).toHaveLength(2)
    expect(snapshot.executions.filter((execution) => execution.status === 'failed')).toHaveLength(1)
    expect(snapshot.sendCalls).toBe(0)
    expect(snapshot.capabilityCalls).toBe(0)
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userData, { recursive: true, force: true })
    rmSync(outputDir, { recursive: true, force: true })
  }
})
