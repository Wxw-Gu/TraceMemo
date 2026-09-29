import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiSearchPipelineRequest } from '../../src/shared/ai-search'
import type { KnowledgeSearchIpcRequest } from '../../src/shared/knowledge'

const invoke = vi.fn()
const on = vi.fn()
const removeListener = vi.fn()
const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener }
}))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: { fixture: true } }))

async function loadApi(): Promise<typeof window.api> {
  vi.resetModules()
  exposeInMainWorld.mockClear()
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  await import('../../src/preload/index')
  const exposed = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')
  if (!exposed) throw new Error('preload did not expose api')
  return exposed[1] as typeof window.api
}

describe('preload IPC contract', () => {
  beforeEach(() => {
    invoke.mockReset()
    on.mockReset()
    removeListener.mockReset()
  })

  it('forwards message and media parameters to the exact main channels', async () => {
    const api = await loadApi()
    invoke.mockResolvedValue({ success: true })

    await api.getMessages('fixture-user', 10, 20, { limit: 50 })
    expect(invoke).toHaveBeenLastCalledWith('db:getMessages', 'fixture-user', 10, 20, {
      limit: 50
    })

    const knowledgeSearch: KnowledgeSearchIpcRequest = {
      text: '测试 Knowledge Worker 检索',
      terms: ['Knowledge Worker'],
      conversationIds: ['fixture-user'],
      startTime: 10,
      limit: 20
    }
    await api.searchKnowledge(knowledgeSearch)
    expect(invoke).toHaveBeenLastCalledWith('knowledge:search', knowledgeSearch)
    const aiSearch: AiSearchPipelineRequest = {
      requestId: 'fixture-search',
      text: '最近谁聊过健身',
      scope: 'global',
      range: '7d'
    }
    await api.runAiSearch(aiSearch)
    expect(invoke).toHaveBeenLastCalledWith('ai-search:run', aiSearch)
    await api.cancelAiSearch(aiSearch.requestId)
    expect(invoke).toHaveBeenLastCalledWith('ai-search:cancel', aiSearch.requestId)
    await api.startKnowledgeIndex()
    expect(invoke).toHaveBeenLastCalledWith('knowledge:startIndex')
    await api.clearCache('knowledge')
    expect(invoke).toHaveBeenLastCalledWith('cache:clear', 'knowledge')
    await api.openKnowledgeDirectory()
    expect(invoke).toHaveBeenLastCalledWith('cache:openKnowledgeDirectory')
    await api.getAIVisionRuntimeConfig()
    expect(invoke).toHaveBeenLastCalledWith('ai:getVisionRuntimeConfig')

    await api.getGroupExitMonitorState()
    expect(invoke).toHaveBeenLastCalledWith('group-exit-monitor:getState')
    await api.setGroupExitMonitorEnabled(false)
    expect(invoke).toHaveBeenLastCalledWith('group-exit-monitor:setEnabled', false)
    await api.setGroupExitMonitorGroups(['room@chatroom'])
    expect(invoke).toHaveBeenLastCalledWith('group-exit-monitor:setGroups', ['room@chatroom'])
    await api.checkGroupExitMonitorNow()
    expect(invoke).toHaveBeenLastCalledWith('group-exit-monitor:checkNow')
    await api.clearGroupExitMonitorEvents()
    expect(invoke).toHaveBeenLastCalledWith('group-exit-monitor:clearEvents')
    await api.markGroupExitMonitorRead(123)
    expect(invoke).toHaveBeenLastCalledWith('group-exit-monitor:markRead', 123)
    await api.listWechatActionLogs()
    expect(invoke).toHaveBeenLastCalledWith('wechat-action-log:list')

    // 退群通知：保存走 singleton upsert，联系人候选由 main 侧过滤。
    const leaveDraft = {
      name: '退群通知',
      enabled: true,
      ruleType: 'leave_notification',
      trigger: 'message',
      scope: 'group',
      conditions: {},
      actions: [],
      cooldownSeconds: 0,
      replyDelaySeconds: 2,
      leaveNotification: { target: { type: 'file_transfer' }, template: '[退群监测]' }
    } as never
    await api.saveLeaveNotificationRule(leaveDraft)
    expect(invoke).toHaveBeenLastCalledWith('automation:saveLeaveNotificationRule', leaveDraft)
    await api.listSendableContacts()
    expect(invoke).toHaveBeenLastCalledWith('automation:listSendableContacts')

    await api.getImage('fixture-md5', 'fixture.dat', 'fixture-session', {
      force: true,
      priority: 0
    })
    expect(invoke).toHaveBeenLastCalledWith(
      'db:getImage',
      'fixture-md5',
      'fixture.dat',
      'fixture-session',
      { force: true, priority: 0 }
    )

    const voiceReference = {
      sessionId: 'filehelper',
      localId: 11,
      createTime: 1785553200,
      svrId: 'server-11'
    }
    // preload 把 options 一路透传（不传即显式 undefined），主进程签名是 (reference, options?)。
    await api.recognizeVoice(voiceReference)
    expect(invoke).toHaveBeenLastCalledWith('voice:recognize', voiceReference, undefined)
    await api.recognizeVoice(voiceReference, { force: true })
    expect(invoke).toHaveBeenLastCalledWith('voice:recognize', voiceReference, { force: true })
    await api.cancelVoiceRecognition(voiceReference)
    expect(invoke).toHaveBeenLastCalledWith('voice:cancelRecognition', voiceReference)
    await api.downloadVoiceModel()
    expect(invoke).toHaveBeenLastCalledWith('voice:downloadModel')
    await api.removeVoiceModel()
    expect(invoke).toHaveBeenLastCalledWith('voice:removeModel')
    await api.openVoiceModelDirectory()
    expect(invoke).toHaveBeenLastCalledWith('voice:openModelDirectory')

    await api.getPersonalWechatSenderStatus()
    expect(invoke).toHaveBeenLastCalledWith('wechat-personal:getStatus')
    await api.checkPersonalWechatVoiceEncodingEnvironment()
    expect(invoke).toHaveBeenLastCalledWith('wechat-personal:checkVoiceEnvironment')
    await api.installPersonalWechatPilk()
    expect(invoke).toHaveBeenLastCalledWith('wechat-personal:installPilk')
    await api.openPersonalWechatVoicePythonDownload()
    expect(invoke).toHaveBeenLastCalledWith('wechat-personal:openVoicePythonDownload')
    await api.openPersonalWechatVoiceFfmpegDownload()
    expect(invoke).toHaveBeenLastCalledWith('wechat-personal:openVoiceFfmpegDownload')
    await api.checkPersonalWechatSenderStatus('4567')
    expect(invoke).toHaveBeenLastCalledWith('wechat-personal:checkStatus', '4567')
    await api.rebindPersonalWechatSender()
    expect(invoke).toHaveBeenLastCalledWith('wechat-personal:rebind')
    const ttsRequest = {
      to: 'fixture@chatroom',
      isGroup: true,
      filePath: '/tmp/generated.mp3'
    }
    await api.sendGeneratedTtsVoice(ttsRequest)
    expect(invoke).toHaveBeenLastCalledWith('wechat-personal:sendGeneratedTtsVoice', ttsRequest)
    const reportImageRequest = {
      type: 'image' as const,
      to: 'fixture@chatroom',
      isGroup: true,
      filePath: '/tmp/report.png'
    }
    await api.sendPersonalWechatMessage(reportImageRequest)
    expect(invoke).toHaveBeenLastCalledWith('wechat-personal:send', reportImageRequest)
    await api.getPersonalWechatVoiceDiagnostic()
    expect(invoke).toHaveBeenLastCalledWith('wechat-personal:getVoiceDiagnostic')
  })

  /**
   * 定时日报退役后，专属能力全部改走 `automation:*`。
   *
   * 单独成一个用例（而不是塞进上面那条超长用例）有两个理由：
   * 1. 上面的用例在 `voice:recognize` 上会因 vitest 4 对**尾随 undefined** 的严格比较而失败，
   *    放在一起会让这几条断言永远跑不到；
   * 2. 「旧通道必须彻底消失」本身就是一条独立契约，值得有自己的名字。
   */
  it('routes scheduled-report capabilities through automation channels only', async () => {
    const api = await loadApi()
    invoke.mockResolvedValue({ success: true })

    await api.runScheduledReportRule('rule-1')
    expect(invoke).toHaveBeenLastCalledWith('automation:runScheduledReportRule', 'rule-1')

    await api.listScheduledReportLegacyExecutions('rule-1')
    expect(invoke).toHaveBeenLastCalledWith(
      'automation:listScheduledReportLegacyExecutions',
      'rule-1'
    )

    await api.getScheduledReportNotificationSettings()
    expect(invoke).toHaveBeenLastCalledWith('automation:getScheduledReportNotificationSettings')
    await api.getScheduledReportNotificationCapability()
    expect(invoke).toHaveBeenLastCalledWith('automation:getScheduledReportNotificationCapability')
    await api.setScheduledReportNotificationEnabled(true)
    expect(invoke).toHaveBeenLastCalledWith(
      'automation:setScheduledReportNotificationEnabled',
      true
    )
    await api.testScheduledReportErrorNotification('rule-1')
    expect(invoke).toHaveBeenLastCalledWith(
      'automation:testScheduledReportErrorNotification',
      'rule-1'
    )

    // 旧的 `scheduled-report:*` 通道必须**彻底不存在**：
    // 留一个"能用但没人维护"的入口，等于给双写 / 双读留后门。
    const channels = invoke.mock.calls.map((call) => String(call[0]))
    expect(channels.some((channel) => channel.startsWith('scheduled-report:'))).toBe(false)

    const legacyMethods = [
      'listScheduledReports',
      'listScheduledReportExecutions',
      'createScheduledReport',
      'updateScheduledReport',
      'deleteScheduledReport',
      'setScheduledReportEnabled',
      'runScheduledReportNow',
      'retryScheduledReportSend'
    ]
    for (const method of legacyMethods) {
      expect(api).not.toHaveProperty(method)
    }
  })

  it('preserves key API return values without exposing ipcRenderer', async () => {
    const api = await loadApi()
    invoke.mockResolvedValueOnce({ success: false, code: 'DATABASE_OPEN_FAILED' })
    await expect(api.testConnection('b'.repeat(64), 'fixture-root')).resolves.toEqual({
      success: false,
      code: 'DATABASE_OPEN_FAILED'
    })
    expect(invoke).toHaveBeenCalledWith('db:testConnection', 'b'.repeat(64), 'fixture-root')
    expect(api).not.toHaveProperty('ipcRenderer')
    expect(api).not.toHaveProperty('send')
  })

  it('exposes only the intentional API token IPC operations', async () => {
    const api = await loadApi()
    invoke.mockResolvedValue({ available: true, hasToken: true, maskedToken: '••••' })

    await api.apiTokenStatus()
    expect(invoke).toHaveBeenLastCalledWith('api:tokenStatus')
    await api.revealApiToken()
    expect(invoke).toHaveBeenLastCalledWith('api:revealToken')
    await api.copyApiToken()
    expect(invoke).toHaveBeenLastCalledWith('api:copyToken')
    await api.rotateApiToken()
    expect(invoke).toHaveBeenLastCalledWith('api:rotateToken')
    await api.copyLocalApiCurl({ endpointId: 'contact' })
    expect(invoke).toHaveBeenLastCalledWith('api:copyCurl', { endpointId: 'contact' })
  })

  it('unsubscribes the same listener registered for native database changes', async () => {
    const api = await loadApi()
    const callback = vi.fn()
    const unsubscribe = api.onWcdbChange(callback)
    expect(on).toHaveBeenCalledWith('wcdb-change', expect.any(Function))
    const listener = on.mock.calls.at(-1)?.[1]
    listener({}, { type: 'insert', json: '{"fixture":true}' })
    expect(callback).toHaveBeenCalledWith({ type: 'insert', json: '{"fixture":true}' })
    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('wcdb-change', listener)
  })

  it('unsubscribes the same listener registered for group exit state', async () => {
    const api = await loadApi()
    const callback = vi.fn()
    const unsubscribe = api.onGroupExitMonitorState(callback)
    expect(on).toHaveBeenCalledWith('group-exit-monitor:state', expect.any(Function))
    const listener = on.mock.calls.at(-1)?.[1]
    listener(
      {},
      {
        events: [],
        running: false,
        nativeMonitorActive: false,
        monitoredGroupCount: 0,
        lastReadAt: 0,
        unreadCount: 0
      }
    )
    expect(callback).toHaveBeenCalledOnce()
    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('group-exit-monitor:state', listener)
  })
})
