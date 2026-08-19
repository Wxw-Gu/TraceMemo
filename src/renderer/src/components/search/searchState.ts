import type { AiSearchAgentRun, AiSearchPipelineResult } from '../../../../shared/ai-search'
import { RANGE_LABELS } from './searchUtils'
import type {
  EvidenceItem,
  SearchProgressByStage,
  SearchRange,
  SearchStage,
  SearchTrace
} from './searchTypes'

export interface SearchResultResetState {
  analysisError: string
  answer: string
  evidence: EvidenceItem[]
  evidenceCollection: EvidenceItem[]
  visibleEvidenceCount: number
  selectedEvidence: number
  cachedAt: number
  searchTrace: SearchTrace | null
  searchProgress: SearchProgressByStage
  agentTrace: AiSearchAgentRun['trace']
  searchDetailsOpen: boolean
}

export const createSearchResultResetState = (): SearchResultResetState => ({
  analysisError: '',
  answer: '',
  evidence: [],
  evidenceCollection: [],
  visibleEvidenceCount: 0,
  selectedEvidence: 0,
  cachedAt: 0,
  searchTrace: null,
  searchProgress: {},
  agentTrace: [],
  searchDetailsOpen: false
})

export type SearchResultViewTransition =
  | {
      stage: Extract<SearchStage, 'partial' | 'insufficient'>
      analysisError: string
    }
  | {
      stage: Extract<SearchStage, 'result'>
      analysisError: ''
      answer?: string
    }

export const resolveSearchResultViewTransition = (
  result: AiSearchPipelineResult,
  range: SearchRange
): SearchResultViewTransition => {
  if (result.status === 'no_evidence') {
    return {
      stage: 'insufficient',
      analysisError: `${RANGE_LABELS[range]}内没有找到与问题相关的聊天消息。`
    }
  }
  if (result.status === 'retrieval_incomplete') {
    return {
      stage: 'partial',
      analysisError: result.error || '当前检索未完整覆盖聊天记录，未生成总结。'
    }
  }
  if (result.status === 'failed') {
    return {
      stage: 'insufficient',
      analysisError: result.error || '本地搜索暂时无法完成'
    }
  }
  if (result.status === 'ai_failed') {
    return {
      stage: 'partial',
      analysisError: result.error || '证据已找到，但 AI 暂时无法生成回答'
    }
  }

  return {
    stage: 'result',
    analysisError: '',
    answer: result.answer
  }
}
