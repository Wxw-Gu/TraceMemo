import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiSearchAgentTraceItem,
  AiSearchPipelineRequest,
  AiSearchPipelineResult,
  AiSearchProgressEvent,
  AiSearchProgressStage
} from '../../src/shared/ai-search'
import { useAiSearchRun } from '../../src/renderer/src/components/search/hooks/useAiSearchRun'
import { makeSearchResult } from './support/ai-search-fixtures'

const api = {
  runAiSearch: vi.fn(),
  cancelAiSearch: vi.fn(),
  onAiSearchProgress: vi.fn()
}

const request = (requestId: string, text = '测试问题'): AiSearchPipelineRequest => ({
  requestId,
  text,
  scope: 'global',
  range: '30d'
})

const resultFor = (
  requestId: string,
  status: 'completed' | 'failed' | 'ai_failed' | 'cancelled' = 'completed'
): AiSearchPipelineResult => makeSearchResult({ requestId, status })

const progressFor = (
  requestId: string,
  stage: AiSearchProgressStage,
  trace?: AiSearchAgentTraceItem
): AiSearchProgressEvent => ({
  requestId,
  stage,
  status: 'running',
  message: `${stage} ${requestId}`,
  agentTrace: trace
})

const traceFor = (sequence: number): AiSearchAgentTraceItem => ({
  sequence,
  event: 'agentDecision',
  label: `decision-${sequence}`
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

let progressListener: ((event: AiSearchProgressEvent) => void) | undefined
let unsubscribe: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  progressListener = undefined
  unsubscribe = vi.fn()
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  api.onAiSearchProgress.mockImplementation((listener) => {
    progressListener = listener
    return unsubscribe
  })
  api.cancelAiSearch.mockResolvedValue({ cancelled: true })
})

describe('useAiSearchRun', () => {
  it('starts idle and registers exactly one progress listener', () => {
    const { result, rerender } = renderHook(() => useAiSearchRun())

    expect(result.current.status).toBe('idle')
    expect(result.current.requestId).toBe('')
    expect(result.current.progress).toEqual({})
    expect(result.current.agentTrace).toEqual([])
    rerender()
    expect(api.onAiSearchProgress).toHaveBeenCalledOnce()
  })

  it('starts a run with the exact request payload and exposes the running requestId', async () => {
    const run = deferred<AiSearchPipelineResult>()
    api.runAiSearch.mockReturnValue(run.promise)
    const { result } = renderHook(() => useAiSearchRun())

    let startPromise!: ReturnType<typeof result.current.startSearch>
    act(() => {
      startPromise = result.current.startSearch(request('request-a', '原始问题'))
    })

    expect(result.current.status).toBe('running')
    expect(result.current.requestId).toBe('request-a')
    expect(api.runAiSearch).toHaveBeenCalledWith(request('request-a', '原始问题'))

    await act(async () => {
      run.resolve(resultFor('request-a'))
      await startPromise
    })
  })

  it('applies the current request result and converges to completed', async () => {
    api.runAiSearch.mockResolvedValue(resultFor('request-a'))
    const { result } = renderHook(() => useAiSearchRun())

    let outcome!: Awaited<ReturnType<typeof result.current.startSearch>>
    await act(async () => {
      outcome = await result.current.startSearch(request('request-a'))
    })

    expect(outcome).toMatchObject({ kind: 'completed', requestId: 'request-a' })
    expect(result.current.status).toBe('completed')
    expect(result.current.requestId).toBe('')
    expect(result.current.result?.requestId).toBe('request-a')
  })

  it('converges to failed when the pipeline returns a failed status', async () => {
    api.runAiSearch.mockResolvedValue(resultFor('request-failed', 'failed'))
    const { result } = renderHook(() => useAiSearchRun())

    let outcome!: Awaited<ReturnType<typeof result.current.startSearch>>
    await act(async () => {
      outcome = await result.current.startSearch(request('request-failed'))
    })

    expect(outcome.kind).toBe('completed')
    expect(result.current.status).toBe('failed')
    expect(result.current.result?.status).toBe('failed')
  })

  it('converges to failed with an error when runAiSearch rejects', async () => {
    api.runAiSearch.mockRejectedValue(new Error('Worker failed'))
    const { result } = renderHook(() => useAiSearchRun())

    let outcome!: Awaited<ReturnType<typeof result.current.startSearch>>
    await act(async () => {
      outcome = await result.current.startSearch(request('request-error'))
    })

    expect(outcome).toEqual({ kind: 'failed', requestId: 'request-error', error: 'Worker failed' })
    expect(result.current.status).toBe('failed')
    expect(result.current.error).toBe('Worker failed')
    expect(result.current.requestId).toBe('')
  })

  it('applies current progress and deduplicates current Agent Trace events', async () => {
    const run = deferred<AiSearchPipelineResult>()
    api.runAiSearch.mockReturnValue(run.promise)
    const { result } = renderHook(() => useAiSearchRun())
    act(() => {
      void result.current.startSearch(request('request-a'))
    })

    act(() => progressListener?.(progressFor('request-a', 'agent_tool', traceFor(1))))
    act(() => progressListener?.(progressFor('request-a', 'agent_tool', traceFor(1))))

    expect(result.current.progress.agent_tool?.requestId).toBe('request-a')
    expect(result.current.agentTrace).toHaveLength(1)
    expect(result.current.agentTrace[0].sequence).toBe(1)
    await act(async () => {
      run.resolve(resultFor('request-a'))
    })
  })

  it('ignores stale progress and Agent Trace after a newer request starts', async () => {
    const runA = deferred<AiSearchPipelineResult>()
    const runB = deferred<AiSearchPipelineResult>()
    api.runAiSearch.mockReturnValueOnce(runA.promise).mockReturnValueOnce(runB.promise)
    const { result } = renderHook(() => useAiSearchRun())
    let promiseA!: ReturnType<typeof result.current.startSearch>
    let promiseB!: ReturnType<typeof result.current.startSearch>
    act(() => {
      promiseA = result.current.startSearch(request('request-a'))
      promiseB = result.current.startSearch(request('request-b'))
    })

    act(() => {
      progressListener?.(progressFor('request-a', 'query_understanding', traceFor(1)))
      progressListener?.(progressFor('request-b', 'agent_tool', traceFor(2)))
    })

    expect(result.current.progress.query_understanding).toBeUndefined()
    expect(result.current.progress.agent_tool?.requestId).toBe('request-b')
    expect(result.current.agentTrace.map((item) => item.sequence)).toEqual([2])

    await act(async () => {
      runA.resolve(resultFor('request-a'))
      expect(await promiseA).toEqual({ kind: 'stale', requestId: 'request-a' })
      runB.resolve(resultFor('request-b'))
      expect((await promiseB).kind).toBe('completed')
    })
    expect(result.current.result?.requestId).toBe('request-b')
  })

  it('ignores a stale result so it cannot overwrite the current request', async () => {
    const runA = deferred<AiSearchPipelineResult>()
    const runB = deferred<AiSearchPipelineResult>()
    api.runAiSearch.mockReturnValueOnce(runA.promise).mockReturnValueOnce(runB.promise)
    const { result } = renderHook(() => useAiSearchRun())
    let promiseA!: ReturnType<typeof result.current.startSearch>
    let promiseB!: ReturnType<typeof result.current.startSearch>
    act(() => {
      promiseA = result.current.startSearch(request('request-a'))
      promiseB = result.current.startSearch(request('request-b'))
    })

    await act(async () => {
      runA.resolve(resultFor('request-a'))
      expect(await promiseA).toEqual({ kind: 'stale', requestId: 'request-a' })
      expect(result.current.result).toBeNull()
      runB.resolve(resultFor('request-b'))
      await promiseB
    })

    expect(result.current.result?.requestId).toBe('request-b')
    expect(result.current.status).toBe('completed')
  })

  it('ignores a stale error so it cannot overwrite the current request', async () => {
    const runA = deferred<AiSearchPipelineResult>()
    const runB = deferred<AiSearchPipelineResult>()
    api.runAiSearch.mockReturnValueOnce(runA.promise).mockReturnValueOnce(runB.promise)
    const { result } = renderHook(() => useAiSearchRun())
    let promiseA!: ReturnType<typeof result.current.startSearch>
    let promiseB!: ReturnType<typeof result.current.startSearch>
    act(() => {
      promiseA = result.current.startSearch(request('request-a'))
      promiseB = result.current.startSearch(request('request-b'))
    })

    await act(async () => {
      runA.reject(new Error('late A error'))
      expect(await promiseA).toEqual({ kind: 'stale', requestId: 'request-a' })
      expect(result.current.error).toBe('')
      runB.resolve(resultFor('request-b'))
      await promiseB
    })

    expect(result.current.error).toBe('')
    expect(result.current.result?.requestId).toBe('request-b')
  })

  it('cancels the current request through the existing IPC and converges state', async () => {
    const run = deferred<AiSearchPipelineResult>()
    api.runAiSearch.mockReturnValue(run.promise)
    const { result } = renderHook(() => useAiSearchRun())
    act(() => {
      void result.current.startSearch(request('request-cancel'))
    })

    await act(async () => result.current.cancelSearch())

    expect(api.cancelAiSearch).toHaveBeenCalledWith('request-cancel')
    expect(result.current.status).toBe('cancelled')
    expect(result.current.requestId).toBe('')
    expect(result.current.progress).toEqual({})
    expect(result.current.agentTrace).toEqual([])
  })

  it('ignores a late result after cancellation', async () => {
    const run = deferred<AiSearchPipelineResult>()
    api.runAiSearch.mockReturnValue(run.promise)
    const { result } = renderHook(() => useAiSearchRun())
    let startPromise!: ReturnType<typeof result.current.startSearch>
    act(() => {
      startPromise = result.current.startSearch(request('request-cancel'))
    })
    await act(async () => result.current.cancelSearch())

    await act(async () => {
      run.resolve(resultFor('request-cancel'))
      expect(await startPromise).toEqual({ kind: 'stale', requestId: 'request-cancel' })
    })
    expect(result.current.result).toBeNull()
    expect(result.current.status).toBe('cancelled')
  })

  it('does not call cancel IPC when no request is active', async () => {
    const { result } = renderHook(() => useAiSearchRun())

    await act(async () => result.current.cancelSearch())

    expect(api.cancelAiSearch).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('ignores progress after the request has ended', async () => {
    api.runAiSearch.mockResolvedValue(resultFor('request-ended'))
    const { result } = renderHook(() => useAiSearchRun())
    await act(async () => result.current.startSearch(request('request-ended')))
    const progressBefore = result.current.progress

    act(() => progressListener?.(progressFor('request-ended', 'error', traceFor(9))))

    expect(result.current.progress).toBe(progressBefore)
    expect(result.current.agentTrace).toEqual([])
  })

  it('resets the run state without cancelling an IPC request', async () => {
    const run = deferred<AiSearchPipelineResult>()
    api.runAiSearch.mockReturnValue(run.promise)
    const { result } = renderHook(() => useAiSearchRun())
    act(() => {
      void result.current.startSearch(request('request-reset'))
    })
    act(() => result.current.resetSearchRun())

    expect(result.current.status).toBe('idle')
    expect(result.current.requestId).toBe('')
    expect(result.current.result).toBeNull()
    expect(result.current.progress).toEqual({})
    expect(result.current.agentTrace).toEqual([])
    expect(api.cancelAiSearch).not.toHaveBeenCalled()
    await act(async () => {
      run.resolve(resultFor('request-reset'))
    })
  })

  it('cleans up the progress listener and invalidates an active request on unmount', async () => {
    const run = deferred<AiSearchPipelineResult>()
    api.runAiSearch.mockReturnValue(run.promise)
    const { result, unmount } = renderHook(() => useAiSearchRun())
    let startPromise!: ReturnType<typeof result.current.startSearch>
    act(() => {
      startPromise = result.current.startSearch(request('request-unmount'))
    })

    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
    await act(async () => {
      run.resolve(resultFor('request-unmount'))
      expect(await startPromise).toEqual({ kind: 'stale', requestId: 'request-unmount' })
    })
  })
})
