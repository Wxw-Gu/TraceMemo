import type { AiSearchAgentRun } from '../../../../shared/ai-search'
import type { EvidenceItem, SearchProgressByStage, SearchTrace } from './searchTypes'

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
