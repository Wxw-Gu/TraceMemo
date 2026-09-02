import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useKnowledgeStatus } from '../../src/renderer/src/components/search/hooks/useKnowledgeStatus'
import type { KnowledgeRuntimeState, KnowledgeRuntimeStatus } from '../../src/shared/knowledge'

const api = {
  getKnowledgeStatus: vi.fn(),
  onKnowledgeStatus: vi.fn(),
  startKnowledgeIndex: vi.fn()
}

const makeStatus = (
  state: KnowledgeRuntimeState,
  overrides: Partial<KnowledgeRuntimeStatus> = {}
): KnowledgeRuntimeStatus => ({
  accountId: 'knowledge-account',
  state,
  indexedMessageCount: 20,
  indexedChunkCount: 4,
  sourceMessageCount: 20,
  processedMessages: 20,
  totalMessages: 20,
  estimatedRemainingMs: null,
  databaseBytes: 128,
  walBytes: 64,
  shmBytes: 32,
  ...overrides
})

let knowledgeListener: ((status: KnowledgeRuntimeStatus) => void) | undefined
let unsubscribe: ReturnType<typeof vi.fn>
const onNotice = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  knowledgeListener = undefined
  unsubscribe = vi.fn()
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  api.getKnowledgeStatus.mockResolvedValue(makeStatus('ready'))
  api.onKnowledgeStatus.mockImplementation((listener) => {
    knowledgeListener = listener
    return unsubscribe
  })
  api.startKnowledgeIndex.mockResolvedValue(makeStatus('syncing'))
})

describe('useKnowledgeStatus', () => {
  it.each<KnowledgeRuntimeState>(['unavailable', 'building', 'syncing', 'ready', 'error'])(
    'loads the initial %s runtime state',
    async (state) => {
      api.getKnowledgeStatus.mockResolvedValue(makeStatus(state))

      const { result } = renderHook(() => useKnowledgeStatus({ dbReady: true, onNotice }))

      await waitFor(() => expect(result.current.knowledgeStatus?.state).toBe(state))
      expect(result.current.knowledgeSyncing).toBe(state === 'building' || state === 'syncing')
      expect(result.current.knowledgeSyncingRef.current).toBe(result.current.knowledgeSyncing)
    }
  )

  it('keeps the renderer usable when the initial Knowledge Worker request fails', async () => {
    api.getKnowledgeStatus.mockRejectedValue(new Error('Knowledge Worker unavailable'))

    const { result } = renderHook(() => useKnowledgeStatus({ dbReady: true, onNotice }))

    await waitFor(() => expect(api.getKnowledgeStatus).toHaveBeenCalledOnce())
    expect(result.current.knowledgeStatus).toBeNull()
    expect(api.onKnowledgeStatus).toHaveBeenCalledOnce()
  })

  it('applies Worker status events and releases the subscription on unmount', async () => {
    const { result, unmount } = renderHook(() => useKnowledgeStatus({ dbReady: true, onNotice }))
    await waitFor(() => expect(result.current.knowledgeStatus?.state).toBe('ready'))

    act(() => knowledgeListener?.(makeStatus('building', { processedMessages: 3 })))
    expect(result.current.knowledgeStatus).toMatchObject({
      state: 'building',
      processedMessages: 3
    })
    expect(result.current.knowledgeSyncing).toBe(true)

    act(() => knowledgeListener?.(makeStatus('error', { lastError: 'Worker crashed' })))
    expect(result.current.knowledgeStatus).toMatchObject({
      state: 'error',
      lastError: 'Worker crashed'
    })

    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not start Index when the database is not ready', async () => {
    const { result } = renderHook(() => useKnowledgeStatus({ dbReady: false, onNotice }))

    await act(() => result.current.startKnowledgeSync())

    expect(api.startKnowledgeIndex).not.toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalledWith('请先连接微信数据后再建立本地知识库')
  })

  it('starts Index, exposes the pending state and applies the returned Worker status', async () => {
    let resolveStart: ((status: KnowledgeRuntimeStatus) => void) | undefined
    api.startKnowledgeIndex.mockReturnValue(
      new Promise<KnowledgeRuntimeStatus>((resolve) => {
        resolveStart = resolve
      })
    )
    const { result } = renderHook(() => useKnowledgeStatus({ dbReady: true, onNotice }))
    await waitFor(() => expect(result.current.knowledgeStatus?.state).toBe('ready'))

    let pending: Promise<void>
    act(() => {
      pending = result.current.startKnowledgeSync()
    })
    expect(result.current.syncStarting).toBe(true)
    expect(result.current.knowledgeSyncing).toBe(true)

    await act(async () => {
      resolveStart?.(makeStatus('syncing'))
      await pending
    })
    expect(result.current.syncStarting).toBe(false)
    expect(result.current.knowledgeStatus?.state).toBe('syncing')
    expect(onNotice).toHaveBeenCalledWith('已开始同步最新聊天记录')
  })

  it('reports an Index start failure and clears the pending state', async () => {
    api.startKnowledgeIndex.mockRejectedValue(new Error('Worker 启动失败'))
    const { result } = renderHook(() => useKnowledgeStatus({ dbReady: true, onNotice }))

    await act(() => result.current.startKnowledgeSync())

    expect(result.current.syncStarting).toBe(false)
    expect(onNotice).toHaveBeenCalledWith('Worker 启动失败')
  })
})
