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
    await api.recognizeVoice(voiceReference)
    expect(invoke).toHaveBeenLastCalledWith('voice:recognize', voiceReference)
    await api.cancelVoiceRecognition(voiceReference)
    expect(invoke).toHaveBeenLastCalledWith('voice:cancelRecognition', voiceReference)
    await api.downloadVoiceModel()
    expect(invoke).toHaveBeenLastCalledWith('voice:downloadModel')
    await api.removeVoiceModel()
    expect(invoke).toHaveBeenLastCalledWith('voice:removeModel')
    await api.openVoiceModelDirectory()
    expect(invoke).toHaveBeenLastCalledWith('voice:openModelDirectory')
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
})
