import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiChat: vi.fn(),
  subscriptionChat: vi.fn(),
  runtime: vi.fn(),
  providers: vi.fn(),
  parseReport: vi.fn(),
  exportReport: vi.fn(),
  input: vi.fn()
}))

vi.mock('../../src/main/services/ai-provider-service', () => ({
  AIProviderService: class {
    chat = mocks.apiChat
    getRuntimeConfig = mocks.runtime
    list = mocks.providers
  }
}))
vi.mock('../../src/main/services/chatgpt-plan-service', () => ({
  requestChatGPTPlan: mocks.subscriptionChat
}))
vi.mock('../../src/main/services/chat-service', () => ({
  resolveMd5: () => ({ md5: 'test-group', m_nsUsrName: 'test@chatroom', type: 'group' }),
  getGroupSnapshot: () => undefined,
  listMessages: () => [{ type: '普通文本', content: 'synthetic test message' }]
}))
vi.mock('../../src/main/group-report-service', () => ({ exportGroupReport: mocks.exportReport }))
vi.mock('../../src/renderer/src/utils/group-report', () => ({
  buildGroupReportInput: mocks.input,
  getSummaryDateRange: () => ({ startTime: 1, endTime: 2 }),
  GROUP_REPORT_JSON_REPAIR_SYSTEM_PROMPT: 'repair',
  GROUP_REPORT_SYSTEM_PROMPT: 'summarize',
  isInternalName: () => false,
  parseGroupDailyReport: mocks.parseReport
}))

import { generateAgentGroupReport } from '../../src/main/services/agent-group-report-service'
import { normalizeScheduledReportConfig } from '../../src/shared/automation'

const subscriptionRequest = {
  group: 'test@chatroom',
  providerId: 'chatgpt-plan:test-profile',
  model: 'test-model',
  chatgptConsent: true
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.subscriptionChat.mockResolvedValue({ success: true, data: '{}' })
  mocks.apiChat.mockResolvedValue({ success: true, data: '{}' })
  mocks.runtime.mockReturnValue({ model: 'default-model', modelName: 'Default API' })
  mocks.providers.mockReturnValue({ providers: [
    { id: 'api-provider', defaultModel: 'api-model', models: [{ id: 'api-model', name: 'Selected API' }] }
  ] })
  mocks.parseReport.mockReturnValue({ title: 'Synthetic report' })
  mocks.input.mockResolvedValue({ prompt: 'synthetic input', metadata: { groupName: 'Synthetic group' } })
  mocks.exportReport.mockResolvedValue({ success: true, pngPath: '/fixture/report.png', htmlPath: '/fixture/report.html' })
})

describe('scheduled report provider routing', () => {
  it('routes subscription and JSON repair to the same selected account/model, without API fallback', async () => {
    mocks.parseReport.mockImplementationOnce(() => { throw new Error('invalid JSON') })
    const result = await generateAgentGroupReport(subscriptionRequest)
    expect(result).toMatchObject({ success: true, modelName: 'ChatGPT 订阅 · test-model' })
    expect(mocks.subscriptionChat).toHaveBeenCalledTimes(2)
    for (const call of mocks.subscriptionChat.mock.calls) {
      expect(call[0]).toBe(subscriptionRequest.providerId)
      expect(call[1]).toBe('test-model')
    }
    expect(mocks.subscriptionChat.mock.calls[1][2][0].content).toBe('repair')
    expect(mocks.apiChat).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
  })

  it('requires explicit saved consent before building or sending the subscription prompt', async () => {
    const result = await generateAgentGroupReport({ ...subscriptionRequest, chatgptConsent: false })
    expect(result).toMatchObject({ success: false, errorCode: 'CHATGPT_CONSENT_REQUIRED' })
    expect(mocks.input).not.toHaveBeenCalled()
    expect(mocks.subscriptionChat).not.toHaveBeenCalled()
    expect(mocks.apiChat).not.toHaveBeenCalled()
  })

  it('rejects a subscription with no selected model', async () => {
    const result = await generateAgentGroupReport({ ...subscriptionRequest, model: '' })
    expect(result).toMatchObject({ success: false, errorCode: 'AI_MODEL_REQUIRED' })
    expect(mocks.subscriptionChat).not.toHaveBeenCalled()
    expect(mocks.apiChat).not.toHaveBeenCalled()
  })

  it('returns disconnected subscription errors without trying paid API or exporting a report', async () => {
    mocks.subscriptionChat.mockResolvedValue({ success: false, error: '连接已变更，请重新选择模型。' })
    const result = await generateAgentGroupReport(subscriptionRequest)
    expect(result).toMatchObject({ success: false, errorStage: 'ai', error: '连接已变更，请重新选择模型。' })
    expect(mocks.apiChat).not.toHaveBeenCalled()
    expect(mocks.exportReport).not.toHaveBeenCalled()
  })

  it('passes explicit API provider/model and records its display name', async () => {
    const result = await generateAgentGroupReport({ group: 'test@chatroom', providerId: 'api-provider', model: 'api-model' })
    expect(result).toMatchObject({ success: true, modelName: 'Selected API' })
    expect(mocks.apiChat).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ providerId: 'api-provider', modelId: 'api-model' }))
    expect(mocks.subscriptionChat).not.toHaveBeenCalled()
  })

  it('a deleted API provider never silently falls back to the global default', async () => {
    const result = await generateAgentGroupReport({ group: 'test@chatroom', providerId: 'deleted-provider', model: 'api-model' })
    expect(result).toMatchObject({ success: false, errorCode: 'AI_MODEL_UNAVAILABLE' })
    expect(mocks.apiChat).not.toHaveBeenCalled()
  })

  it('keeps the legacy default API path for existing rules without model fields', async () => {
    const result = await generateAgentGroupReport({ group: 'test@chatroom' })
    expect(result).toMatchObject({ success: true, modelName: 'Default API' })
    expect(mocks.apiChat).toHaveBeenCalledTimes(1)
    expect(mocks.subscriptionChat).not.toHaveBeenCalled()
  })

  it('preserves new scheduled fields without changing legacy delivery defaults', () => {
    const normalized = normalizeScheduledReportConfig({
      deliveryMode: 'local_only',
      report: { providerId: ' chatgpt-plan:test-profile ', model: ' test-model ', chatgptConsent: true }
    })
    expect(normalized).toMatchObject({ deliveryMode: 'local_only', report: {
      providerId: 'chatgpt-plan:test-profile', model: 'test-model', chatgptConsent: true
    } })
    const legacy = normalizeScheduledReportConfig({})
    expect(legacy).not.toHaveProperty('deliveryMode')
    expect(legacy.report).not.toHaveProperty('chatgptConsent')
    expect(normalizeScheduledReportConfig({ report: { chatgptConsent: 'true' } }).report)
      .not.toHaveProperty('chatgptConsent')
  })
})
