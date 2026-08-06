export type ContactResolutionMatch = 'exact' | 'normalized' | 'alias' | 'fuzzy'

export interface ContactResolutionCandidate {
  conversationId: string
  displayName: string
  matchedBy: ContactResolutionMatch
  confidence: number
}

export interface ContactResolutionResult {
  matched: boolean
  personId?: string
  conversationId?: string
  canonicalName?: string
  displayName?: string
  matchedBy?: ContactResolutionMatch
  confidence: number
  candidates: ContactResolutionCandidate[]
  ambiguous: boolean
}

/**
 * Identity-only canonicalization. It deliberately does not use substring
 * matching: callers may use a separate UI-filter policy for broad discovery,
 * but identity resolution must never turn 张三 into 张三丰.
 */
export const normalizeContactName = (value: string): string =>
  String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{White_Space}\p{P}\p{S}_]+/gu, '')

export const emptyContactResolution = (): ContactResolutionResult => ({
  matched: false,
  confidence: 0,
  candidates: [],
  ambiguous: false
})
