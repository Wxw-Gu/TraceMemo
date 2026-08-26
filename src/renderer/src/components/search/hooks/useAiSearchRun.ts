import { useEffect, useRef, useState } from 'react'
import type {
  AiSearchAgentRun,
  AiSearchPipelineRequest,
  AiSearchPipelineResult,
  AiSearchProgressEvent
} from '../../../../../shared/ai-search'
import type { SearchProgressByStage } from '../searchTypes'

export type AiSearchRunStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AiSearchRunOutcome =
  | { kind: 'completed'; requestId: string; result: AiSearchPipelineResult }
  | { kind: 'cancelled'; requestId: string; result?: AiSearchPipelineResult }
  | { kind: 'failed'; requestId: string; error: string }
  | { kind: 'stale'; requestId: string }

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : '读取聊天记录失败'

export function useAiSearchRun({
  onAnswerDelta
}: {
  onAnswerDelta?: (delta: string) => void
} = {}): {
  status: AiSearchRunStatus
  requestId: string
  result: AiSearchPipelineResult | null
  error: string
  progress: SearchProgressByStage
  agentTrace: AiSearchAgentRun['trace']
  createRequestId: () => string
  startSearch: (request: AiSearchPipelineRequest) => Promise<AiSearchRunOutcome>
  cancelSearch: () => Promise<void>
  resetSearchRun: () => void
  isCurrentRequest: (requestId: string) => boolean
} {
  const [status, setStatus] = useState<AiSearchRunStatus>('idle')
  const [requestId, setRequestId] = useState('')
  const [result, setResult] = useState<AiSearchPipelineResult | null>(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<SearchProgressByStage>({})
  const [agentTrace, setAgentTrace] = useState<AiSearchAgentRun['trace']>([])
  const requestIdRef = useRef('')
  const onAnswerDeltaRef = useRef(onAnswerDelta)

  useEffect(() => {
    onAnswerDeltaRef.current = onAnswerDelta
  }, [onAnswerDelta])

  const createRequestId = (): string => globalThis.crypto?.randomUUID?.() || `search-${Date.now()}`

  const isCurrentRequest = (currentRequestId: string): boolean =>
    Boolean(currentRequestId) && requestIdRef.current === currentRequestId

  useEffect(() => {
    const unsubscribe = window.api.onAiSearchProgress((event: AiSearchProgressEvent) => {
      if (!isCurrentRequest(event.requestId)) return
      setProgress((current) => ({ ...current, [event.stage]: event }))
      if (event.answerDelta) onAnswerDeltaRef.current?.(event.answerDelta)
      if (event.agentTrace) {
        setAgentTrace((current) =>
          current.some((item) => item.sequence === event.agentTrace?.sequence)
            ? current
            : [...current, event.agentTrace as AiSearchAgentRun['trace'][number]]
        )
      }
    })
    return () => {
      requestIdRef.current = ''
      unsubscribe()
    }
  }, [])

  const startSearch = async (request: AiSearchPipelineRequest): Promise<AiSearchRunOutcome> => {
    requestIdRef.current = request.requestId
    setRequestId(request.requestId)
    setStatus('starting')
    setError('')
    setResult(null)
    setProgress({})
    setAgentTrace([])
    setStatus('running')
    try {
      const searchResult = await window.api.runAiSearch(request)
      if (!isCurrentRequest(request.requestId))
        return { kind: 'stale', requestId: request.requestId }
      requestIdRef.current = ''
      setRequestId('')
      setResult(searchResult)
      setAgentTrace(searchResult.agent.trace)
      if (searchResult.status === 'cancelled') {
        setStatus('cancelled')
        return { kind: 'cancelled', requestId: request.requestId, result: searchResult }
      }
      if (searchResult.status === 'failed' || searchResult.status === 'ai_failed') {
        setStatus('failed')
      } else {
        setStatus('completed')
      }
      return { kind: 'completed', requestId: request.requestId, result: searchResult }
    } catch (caughtError) {
      if (!isCurrentRequest(request.requestId))
        return { kind: 'stale', requestId: request.requestId }
      requestIdRef.current = ''
      setRequestId('')
      const message = errorMessage(caughtError)
      setError(message)
      setStatus('failed')
      return { kind: 'failed', requestId: request.requestId, error: message }
    }
  }

  const cancelSearch = async (): Promise<void> => {
    const currentRequestId = requestIdRef.current
    if (!currentRequestId) return
    requestIdRef.current = ''
    setRequestId('')
    setStatus('cancelled')
    setError('')
    setProgress({})
    setAgentTrace([])
    await window.api.cancelAiSearch(currentRequestId)
  }

  const resetSearchRun = (): void => {
    requestIdRef.current = ''
    setRequestId('')
    setStatus('idle')
    setResult(null)
    setError('')
    setProgress({})
    setAgentTrace([])
  }

  return {
    status,
    requestId,
    result,
    error,
    progress,
    agentTrace,
    createRequestId,
    startSearch,
    cancelSearch,
    resetSearchRun,
    isCurrentRequest
  }
}
