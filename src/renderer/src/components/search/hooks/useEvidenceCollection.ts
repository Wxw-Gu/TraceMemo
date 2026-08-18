import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { Contact } from '../../../../../shared/types'
import type { EvidenceItem } from '../searchTypes'

export const EVIDENCE_PAGE_SIZE = 8

type UseEvidenceCollectionOptions = {
  onOpenEvidence: (contact: Contact, createTime?: number) => void
}

export function useEvidenceCollection({ onOpenEvidence }: UseEvidenceCollectionOptions): {
  evidence: EvidenceItem[]
  setEvidence: Dispatch<SetStateAction<EvidenceItem[]>>
  evidenceCollection: EvidenceItem[]
  setEvidenceCollection: Dispatch<SetStateAction<EvidenceItem[]>>
  visibleEvidenceCount: number
  setVisibleEvidenceCount: Dispatch<SetStateAction<number>>
  selectedEvidence: number
  setSelectedEvidence: Dispatch<SetStateAction<number>>
  visibleEvidence: EvidenceItem[]
  hasMoreEvidence: boolean
  evidenceFlash: { index: number; nonce: number }
  evidenceCardRefs: React.MutableRefObject<Map<number, HTMLElement>>
  setEvidenceResult: (summaryEvidence: EvidenceItem[], collection: EvidenceItem[]) => void
  clearEvidenceCollection: () => void
  loadMoreEvidence: () => void
  focusEvidence: (index: number) => void
  jumpToEvidence: (index: number) => void
  setEvidenceCardRef: (index: number, node: HTMLElement | null) => void
} {
  const [evidence, setEvidence] = useState<EvidenceItem[]>([])
  const [evidenceCollection, setEvidenceCollection] = useState<EvidenceItem[]>([])
  const [visibleEvidenceCount, setVisibleEvidenceCount] = useState(0)
  const [selectedEvidence, setSelectedEvidence] = useState(0)
  const [evidenceFlash, setEvidenceFlash] = useState({ index: -1, nonce: 0 })
  const evidenceCardRefs = useRef(new Map<number, HTMLElement>())
  const visibleEvidence = useMemo(
    () => evidenceCollection.slice(0, visibleEvidenceCount),
    [evidenceCollection, visibleEvidenceCount]
  )
  const hasMoreEvidence =
    visibleEvidence.length > 0 && visibleEvidence.length < evidenceCollection.length

  const setEvidenceResult = (summaryEvidence: EvidenceItem[], collection: EvidenceItem[]): void => {
    setEvidence(summaryEvidence)
    setEvidenceCollection(collection)
    setVisibleEvidenceCount(Math.min(EVIDENCE_PAGE_SIZE, collection.length))
  }

  const clearEvidenceCollection = (): void => {
    setEvidence([])
    setEvidenceCollection([])
    setVisibleEvidenceCount(0)
    setSelectedEvidence(0)
  }

  const loadMoreEvidence = (): void => {
    setVisibleEvidenceCount((current) =>
      Math.min(current + EVIDENCE_PAGE_SIZE, evidenceCollection.length)
    )
  }

  const focusEvidence = (index: number): void => {
    if (!Number.isInteger(index) || index < 0 || index >= evidenceCollection.length) return
    setVisibleEvidenceCount((current) => Math.max(current, index + 1))
    setSelectedEvidence(index)
    setEvidenceFlash((current) => ({ index, nonce: current.nonce + 1 }))
  }

  const jumpToEvidence = (index: number): void => {
    const item = evidenceCollection[index]
    if (!item) return
    onOpenEvidence(item.contact, item.message.createTime)
  }

  const setEvidenceCardRef = (index: number, node: HTMLElement | null): void => {
    if (node) evidenceCardRefs.current.set(index, node)
    else evidenceCardRefs.current.delete(index)
  }

  useEffect(() => {
    if (evidenceFlash.index < 0) return
    evidenceCardRefs.current.get(evidenceFlash.index)?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest'
    })
  }, [evidenceFlash])

  return {
    evidence,
    setEvidence,
    evidenceCollection,
    setEvidenceCollection,
    visibleEvidenceCount,
    setVisibleEvidenceCount,
    selectedEvidence,
    setSelectedEvidence,
    visibleEvidence,
    hasMoreEvidence,
    evidenceFlash,
    evidenceCardRefs,
    setEvidenceResult,
    clearEvidenceCollection,
    loadMoreEvidence,
    focusEvidence,
    jumpToEvidence,
    setEvidenceCardRef
  }
}
