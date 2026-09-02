import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEvidenceCollection } from '../../src/renderer/src/components/search/hooks/useEvidenceCollection'
import type { EvidenceItem } from '../../src/renderer/src/components/search/searchTypes'
import {
  aiSearchContact,
  makeCacheRecord,
  makePipelineEvidence
} from './support/ai-search-fixtures'

const onOpenEvidence = vi.fn()

const makeEvidence = (count: number, offset = 0): EvidenceItem[] =>
  Array.from({ length: count }, (_, index) => {
    const item = makePipelineEvidence(index + offset + 1)
    return {
      evidenceId: item.id,
      contact: aiSearchContact,
      message: {
        id: item.messageId,
        from: item.senderId,
        type: '检索消息',
        datetime: new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false }),
        content: item.text,
        isSender: false,
        name: item.sender,
        senderId: item.senderId,
        createTime: Math.floor(item.timestamp / 1000)
      }
    }
  })

const useEvidenceHarness = () => useEvidenceCollection({ onOpenEvidence })

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { runAiSearch: vi.fn() }
  })
})

describe('useEvidenceCollection', () => {
  it('starts with zero Summary Evidence and zero Collection Evidence', () => {
    const { result } = renderHook(() => useEvidenceHarness())

    expect(result.current.evidence).toEqual([])
    expect(result.current.evidenceCollection).toEqual([])
    expect(result.current.visibleEvidence).toEqual([])
    expect(result.current.hasMoreEvidence).toBe(false)
  })

  it('shows one Evidence item without rendering a load-more affordance', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const summary = makeEvidence(1)

    act(() => result.current.setEvidenceResult(summary, summary))

    expect(result.current.evidence).toHaveLength(1)
    expect(result.current.visibleEvidence).toHaveLength(1)
    expect(result.current.hasMoreEvidence).toBe(false)
  })

  it('shows all eight Summary Evidence items on the first page', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const summary = makeEvidence(8)

    act(() => result.current.setEvidenceResult(summary, summary))

    expect(result.current.evidence).toHaveLength(8)
    expect(result.current.visibleEvidence).toHaveLength(8)
    expect(result.current.hasMoreEvidence).toBe(false)
  })

  it('keeps Summary Evidence capped at eight while Collection contains more items', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const summary = makeEvidence(8)
    const collection = makeEvidence(16)

    act(() => result.current.setEvidenceResult(summary, collection))

    expect(result.current.evidence).toHaveLength(8)
    expect(result.current.evidenceCollection).toHaveLength(16)
    expect(result.current.visibleEvidence).toHaveLength(8)
    expect(result.current.hasMoreEvidence).toBe(true)
  })

  it('loads more Collection Evidence in pages without invoking Search', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const summary = makeEvidence(8)
    const collection = makeEvidence(16)
    act(() => result.current.setEvidenceResult(summary, collection))

    act(() => result.current.loadMoreEvidence())

    expect(result.current.visibleEvidence).toHaveLength(16)
    expect(result.current.hasMoreEvidence).toBe(false)
    expect(window.api.runAiSearch).not.toHaveBeenCalled()
  })

  it('does not change Summary Evidence when loading more Collection Evidence', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const summary = makeEvidence(8)
    const collection = makeEvidence(17)
    act(() => result.current.setEvidenceResult(summary, collection))
    const summaryIds = result.current.evidence.map((item) => item.evidenceId)

    act(() => result.current.loadMoreEvidence())

    expect(result.current.evidence.map((item) => item.evidenceId)).toEqual(summaryIds)
    expect(result.current.evidence).toHaveLength(8)
  })

  it('preserves stable E1…En identifiers and ordering across pagination', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const collection = makeEvidence(17)
    act(() => result.current.setEvidenceResult(collection.slice(0, 8), collection))

    const firstPageIds = result.current.visibleEvidence.map((item) => item.evidenceId)
    act(() => result.current.loadMoreEvidence())
    const allIds = result.current.visibleEvidence.map((item) => item.evidenceId)

    expect(firstPageIds).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'])
    expect(allIds).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
      'E5',
      'E6',
      'E7',
      'E8',
      'E9',
      'E10',
      'E11',
      'E12',
      'E13',
      'E14',
      'E15',
      'E16'
    ])
  })

  it('selects and highlights an Evidence item while expanding visibility when needed', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const collection = makeEvidence(16)
    act(() => result.current.setEvidenceResult(collection.slice(0, 8), collection))

    act(() => result.current.focusEvidence(10))

    expect(result.current.selectedEvidence).toBe(10)
    expect(result.current.visibleEvidence).toHaveLength(11)
    expect(result.current.evidenceFlash.index).toBe(10)
    expect(result.current.evidenceFlash.nonce).toBe(1)
  })

  it('scrolls the highlighted Evidence card into view', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const scrollIntoView = vi.fn()
    const card = { scrollIntoView } as unknown as HTMLElement
    const collection = makeEvidence(1)
    act(() => result.current.setEvidenceResult(collection, collection))
    act(() => {
      result.current.setEvidenceCardRef(0, card)
      result.current.focusEvidence(0)
    })

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' })
  })

  it('passes the selected Evidence contact and timestamp to the jump callback', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const collection = makeEvidence(1)
    act(() => result.current.setEvidenceResult(collection, collection))

    act(() => result.current.jumpToEvidence(0))

    expect(onOpenEvidence).toHaveBeenCalledWith(aiSearchContact, collection[0].message.createTime)
  })

  it('clears the previous request Evidence and selection before the next result is applied', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const first = makeEvidence(1)
    const second = makeEvidence(1, 1)
    act(() => {
      result.current.setEvidenceResult(first, first)
      result.current.focusEvidence(0)
      result.current.clearEvidenceCollection()
    })

    expect(result.current.evidence).toEqual([])
    expect(result.current.evidenceCollection).toEqual([])
    expect(result.current.selectedEvidence).toBe(0)
    expect(result.current.visibleEvidence).toEqual([])

    act(() => result.current.setEvidenceResult(second, second))
    expect(result.current.evidence.map((item) => item.evidenceId)).toEqual(['E2'])
    expect(result.current.evidence).not.toContain(first[0])
  })

  it('accepts legacy cache normalization where missing evidenceCollection falls back to evidence', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const cached = makeCacheRecord({
      query: 'legacy evidence',
      evidence: [makePipelineEvidence(1)]
    })
    const legacyEvidence = cached.evidence as EvidenceItem[]

    act(() => result.current.setEvidenceResult(legacyEvidence, legacyEvidence))

    expect(result.current.evidenceCollection).toBe(result.current.evidence)
    expect(result.current.visibleEvidence).toHaveLength(1)
  })

  it('replaces, rather than merges, Collection Evidence between request boundaries', () => {
    const { result } = renderHook(() => useEvidenceHarness())
    const first = makeEvidence(9)
    const second = makeEvidence(2, 20)

    act(() => result.current.setEvidenceResult(first.slice(0, 8), first))
    act(() => {
      result.current.clearEvidenceCollection()
      result.current.setEvidenceResult(second, second)
    })

    expect(result.current.evidenceCollection.map((item) => item.evidenceId)).toEqual(['E21', 'E22'])
    expect(result.current.evidenceCollection).not.toContain(first[8])
  })
})
