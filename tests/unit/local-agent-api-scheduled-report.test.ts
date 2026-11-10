import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-api-unit-default' } }))

import { validateAutomationDraftShape } from '../../src/shared/agent-api/automation-validation'
import { AutomationRuleStore } from '../../src/main/services/automation-rule-store'
import { LocalAgentApiService } from '../../src/main/services/local-agent-api-service'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'
import type { AutomationRule, AutomationRuleDraft } from '../../src/shared/automation'

const draft = () => ({
  name: 'Synthetic scheduled report',
  ruleType: 'scheduled_report',
  scheduledReport: {
    deliveryMode: 'local_only',
    schedule: { time: '09:00' },
    report: {
      sourceConversationId: 'test@chatroom', range: 'yesterday', messageTypes: ['text'],
      templateId: 'v1', memberNameMode: 'groupNickname', timeoutSeconds: 300,
      providerId: 'chatgpt-plan:test', model: 'test-model', chatgptConsent: true
    }
  }
})

let root: string
let store: AutomationRuleStore
let service: LocalAgentApiService
let capability: Mock<() => Promise<PersonalWechatSendCapability>>
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracememo-local-api-scheduled-'))
  store = new AutomationRuleStore({ userDataPath: () => root })
  capability = vi.fn<() => Promise<PersonalWechatSendCapability>>().mockRejectedValue(new Error('No native send component'))
  service = new LocalAgentApiService({
    automationRuleStore: store,
    automationExecutionLogService: { list: () => [] },
    listContacts: async () => [{ md5: 'test-md5', m_nsUsrName: 'test@chatroom', m_nsNickName: 'Synthetic group', type: 'group' }],
    isDatabaseReady: () => true,
    getVersion: () => 'test',
    getPersonalWechatCapability: capability,
    getAgentHubStatus: () => ({ connector: 'offline' }),
    getGroupExitMonitorState: () => ({ enabled: false, running: false })
  })
})
afterEach(() => fs.removeSync(root))

describe('local Agent API scheduled reports', () => {
  it('creates, updates and enables a subscription local report without sending dependencies', async () => {
    const validation = await service.validateAutomation(draft())
    expect(validation).toMatchObject({ valid: true, effects: { sendsWechatMessage: false, savesLocalReport: true } })
    expect(validation.effects).not.toHaveProperty('target')
    const created = await service.createAutomation(draft()) as AutomationRule
    expect(created.enabled).toBe(false)
    expect(created.scheduledReport).toMatchObject({ deliveryMode: 'local_only', report: { providerId: 'chatgpt-plan:test', model: 'test-model', chatgptConsent: true } })
    const updated = await service.updateAutomation(created.id, { scheduledReport: { schedule: { time: '10:00' } } }) as AutomationRule
    expect(updated.scheduledReport?.report.chatgptConsent).toBe(true)
    const enabled = await service.setAutomationEnabled(created.id, true) as AutomationRule
    expect(enabled.enabled).toBe(true)
    expect(capability).not.toHaveBeenCalled()
  })

  it('ignores stale send targets and their review marker for local-only rules', async () => {
    const input = draft()
    const validation = await service.validateAutomation({
      ...input,
      scheduledReport: { ...input.scheduledReport, target: { type: 'contact', contactId: 'deleted-person' }, targetNeedsReview: true }
    })
    expect(validation.valid).toBe(true)
    const created = await service.createAutomation({
      ...input,
      scheduledReport: { ...input.scheduledReport, target: { type: 'contact', contactId: 'deleted-person' }, targetNeedsReview: true }
    }) as AutomationRule & { requiresReview: boolean }
    expect(created.requiresReview).toBe(false)
    expect((await service.setAutomationEnabled(created.id, true) as AutomationRule).enabled).toBe(true)
  })

  it('validates new field types and rejects missing subscription consent/model', () => {
    for (const patch of [
      { chatgptConsent: false }, { chatgptConsent: 'true' }, { model: '' }, { model: 3 }, { providerId: 7 }
    ]) {
      const input = draft()
      const result = validateAutomationDraftShape({ ...input, scheduledReport: { ...input.scheduledReport, report: { ...input.scheduledReport.report, ...patch } } })
      expect(result.valid).toBe(false)
    }
    const input = draft()
    expect(validateAutomationDraftShape({ ...input, scheduledReport: { ...input.scheduledReport, deliveryMode: 'unknown' } }).valid).toBe(false)
  })

  it('revalidates consent when enabling a rule created through another interface', async () => {
    const input = draft()
    const valid = validateAutomationDraftShape(input).normalized as AutomationRuleDraft
    valid.scheduledReport!.report.chatgptConsent = false
    const stored = store.createRule(valid)
    await expect(service.setAutomationEnabled(stored.id, true)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(store.getRule(stored.id)?.enabled).toBe(false)
  })

  it('requires renewed consent for changed model/input, but accepts explicit consent in the same patch', async () => {
    const created = await service.createAutomation(draft()) as AutomationRule
    await expect(service.updateAutomation(created.id, { scheduledReport: { report: { model: 'new-model' } } }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const updated = await service.updateAutomation(created.id, { scheduledReport: { report: { model: 'new-model', chatgptConsent: true } } }) as AutomationRule
    expect(updated.scheduledReport?.report.model).toBe('new-model')
    expect(updated.scheduledReport?.report.chatgptConsent).toBe(true)
  })

  it('retains required and resolvable send targets for legacy/wechat mode', async () => {
    const input = draft()
    const validWechat = await service.validateAutomation({ ...input, scheduledReport: { ...input.scheduledReport, deliveryMode: 'wechat', target: { type: 'self' } } })
    expect(validWechat).toMatchObject({ valid: true, effects: { sendsWechatMessage: true, savesLocalReport: true } })
    const missingTarget = await service.validateAutomation({ ...input, scheduledReport: { ...input.scheduledReport, deliveryMode: 'wechat' } })
    expect(missingTarget.valid).toBe(false)
    const staleTarget = await service.validateAutomation({ ...input, scheduledReport: { ...input.scheduledReport, deliveryMode: 'wechat', target: { type: 'contact', contactId: 'missing' } } })
    expect(staleTarget.valid).toBe(false)
    expect(staleTarget.issues).toContainEqual(expect.objectContaining({ path: 'scheduledReport.target.contactId' }))
  })
})
