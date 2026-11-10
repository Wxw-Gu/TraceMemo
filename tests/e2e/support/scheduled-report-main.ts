/**
 * Real Electron scheduled-report pipeline, with synthetic WeChat rows and an offline
 * subscription transport. This entry is built only with TRACEMEMO_SCHEDULED_E2E=1;
 * none of these test controls are registered by the application entry.
 */
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import path from 'node:path'
import type { Contact, Message } from '../../../src/shared/types'
import type { AutomationRuleDraft } from '../../../src/shared/automation'
import type { Wcdb4Client } from '../../../src/main/wcdb4-client'

const userData = process.env.TRACEMEMO_SCHEDULED_TEST_USER_DATA
const outputDir = process.env.TRACEMEMO_REPORT_OUTPUT_DIR
if (!userData || !outputDir) throw new Error('Explicit isolated test directories are required')
app.setPath('userData', userData)
app.setPath('logs', path.join(userData, 'logs'))
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-background-networking')

// Local calendar values intentionally exercise the production "yesterday" range.
let clock = new Date(2026, 7, 27, 8, 30).getTime()
const contact: Contact = {
  m_nsUsrName: 'synthetic@chatroom',
  m_nsNickName: '合成管道测试群',
  md5: 'synthetic-md5',
  type: 'group'
}
const syntheticText = '合成验收标记：蓝莓计划已经完成，请明天核对交付。'
const messageTime = new Date(2026, 7, 26, 10, 15).getTime() / 1000
const messages: Message[] = [
  {
    id: 'synthetic-message-1',
    type: '普通文本',
    from: 'user',
    content: syntheticText,
    contentData: { type: 'text', content: syntheticText },
    datetime: '2026-08-26 10:15:00',
    createTime: messageTime,
    senderId: 'synthetic-member',
    name: '合成成员',
    isSender: false
  }
]
const reportJson = JSON.stringify({
  overview: syntheticText,
  hero: {
    headline: '蓝莓计划验收',
    summary: syntheticText,
    keyTakeaway: '合成计划完成',
    pendingNote: '',
    statusLine: '1 项合成结论'
  },
  topics: [
    {
      title: '蓝莓计划',
      timeRange: '10:15',
      heat: '中',
      participants: ['合成成员'],
      summary: syntheticText,
      conclusions: [{ text: '合成计划完成', sourceMessageIds: ['synthetic-message-1'] }],
      keywords: ['蓝莓'],
      sourceMessageIds: ['synthetic-message-1']
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
  keywords: ['蓝莓']
})
const subscriptionCalls: { providerId: string; model: string; hasSyntheticInput: boolean }[] = []
let sendCalls = 0
let capabilityCalls = 0
let subscriptionOffline = false

app.whenReady().then(async () => {
  // All services that resolve app.getPath at module load are imported after isolation.
  const { generateAgentGroupReport } =
    await import('../../../src/main/services/agent-group-report-service')
  const { AutomationRuleStore } = await import('../../../src/main/services/automation-rule-store')
  const { AutomationExecutionLogService } =
    await import('../../../src/main/services/automation-execution-log-service')
  const { AutomationActionRunner } =
    await import('../../../src/main/services/automation-action-runner')
  const { AutomationService } = await import('../../../src/main/services/automation-service')
  const { ScheduledReportService } =
    await import('../../../src/main/services/scheduled-report-service')
  const { listGeneratedReports } = await import('../../../src/main/report-history-service')
  const { reportTemplateService } = await import('../../../src/main/report-template-service')
  await reportTemplateService.recover()

  const store = new AutomationRuleStore({ userDataPath: () => userData, now: () => clock })
  const log = new AutomationExecutionLogService({ userDataPath: () => userData })
  const runner = new AutomationActionRunner({
    now: () => clock,
    generateReport: (request) =>
      generateAgentGroupReport(request, {
        now: () => clock,
        resolveContact: (query) =>
          query === contact.m_nsUsrName || query === contact.md5 ? contact : null,
        readMessages: (id, start, end) =>
          id === contact.md5
            ? messages.filter(
                (message) => message.createTime! >= start && message.createTime! <= end
              )
            : [],
        readGroupSnapshot: () => null,
        requestSubscription: async (providerId, model, input) => {
          subscriptionCalls.push({
            providerId,
            model,
            hasSyntheticInput: input.some((part) => part.content.includes(syntheticText))
          })
          if (providerId !== 'chatgpt-plan:synthetic' || model !== 'synthetic-model')
            throw new Error('Unexpected subscription selection')
          return subscriptionOffline
            ? { success: false, error: 'Synthetic subscription disconnected' }
            : { success: true, data: reportJson }
        }
      }),
    // Do not inject saveGeneratedReport: the production history store must copy real artifacts.
    resolveReportContact: () => contact,
    getContactAvatars: async () => ({}),
    executeAction: async () => {
      sendCalls++
      throw new Error('A local report attempted WeChat delivery')
    }
  })
  const service = new AutomationService({} as Wcdb4Client, {
    ruleStore: store,
    executionLog: log,
    runner,
    now: () => clock,
    getCapability: async () => {
      capabilityCalls++
      throw new Error('No native WeChat component in fixture')
    }
  })
  const scheduler = new ScheduledReportService({
    storageDir: path.join(userData, 'scheduled-reports'),
    listRules: () => store.listRules(),
    listExecutions: (query) => log.list(query),
    executeRule: (id, options) => service.executeScheduledRule(id, options),
    isDatabaseReady: () => true,
    now: () => new Date(clock),
    sendNotification: async () => {
      sendCalls++
      throw new Error('Unexpected external notification')
    }
  })
  ipcMain.handle('automation:listRules', () => store.listRules())
  ipcMain.handle('automation:createRule', (_, draft: AutomationRuleDraft) =>
    store.createRule(draft)
  )
  ipcMain.handle('automation:runScheduledReportRule', async (_, id: string) => {
    const outcome = await service.executeScheduledRule(id, { trigger: 'manual' })
    return {
      success: outcome.executed && outcome.status === 'success',
      data: outcome,
      error: outcome.errorSummary
    }
  })
  ipcMain.handle('automation:listExecutions', (_, query) => log.list(query))
  ipcMain.handle('report:listGenerated', () => listGeneratedReports())

  const control = {
    async tick(at: number) {
      clock = at
      await scheduler.tick(new Date(clock))
      await scheduler.settle()
    },
    setSubscriptionOffline() {
      subscriptionOffline = true
    },
    async inspect() {
      const history = await listGeneratedReports()
      return {
        rules: store.listRules().filter((rule) => rule.ruleType === 'scheduled_report'),
        executions: log.list(),
        subscriptionCalls,
        sendCalls,
        capabilityCalls,
        reports:
          history.reports?.map(({ generatedImage: _image, ...record }) => ({
            ...record,
            decodedSize: nativeImage.createFromPath(record.pngPath || '').getSize()
          })) || []
      }
    }
  }
  Object.assign(globalThis, { __scheduledReportTest: control })
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  await window.loadURL(
    'data:text/html,<html><body>Synthetic scheduled report integration harness</body></html>'
  )
})
app.on('window-all-closed', () => app.quit())
