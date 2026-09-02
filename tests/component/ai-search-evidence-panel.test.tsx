import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AISearchEvidencePanel } from '../../src/renderer/src/components/search/AISearchEvidencePanel'
import type { EvidenceItem } from '../../src/renderer/src/components/search/searchTypes'
import { makeCacheRecord, makePipelineEvidence } from './support/ai-search-fixtures'

const evidence = makeCacheRecord({
  query: '证据测试',
  evidence: [makePipelineEvidence(1)]
}).evidence as EvidenceItem[]

const renderPanel = (
  overrides: Partial<React.ComponentProps<typeof AISearchEvidencePanel>> = {}
): React.ComponentProps<typeof AISearchEvidencePanel> => {
  const props: React.ComponentProps<typeof AISearchEvidencePanel> = {
    evidence,
    collectionCount: 2,
    selectedEvidence: 0,
    evidenceFlash: { index: -1, nonce: 0 },
    senderNames: { 'sender-1': '发送者 1' },
    hasMoreEvidence: true,
    onFocusEvidence: vi.fn(),
    onJumpToEvidence: vi.fn(),
    onLoadMoreEvidence: vi.fn(),
    setEvidenceCardRef: vi.fn(),
    ...overrides
  }
  render(<AISearchEvidencePanel {...props} />)
  return props
}

describe('AISearchEvidencePanel', () => {
  it('renders stable Evidence labels and routes focus, jump, and load-more callbacks', async () => {
    const user = userEvent.setup()
    const props = renderPanel()

    expect(screen.getByText('1/2 条样本')).toBeVisible()
    expect(screen.getByText(/E1 · 发送者 1/)).toBeVisible()
    expect(screen.getByText('证据 1')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '选择证据 E1，发送者 1' }))
    expect(props.onFocusEvidence).toHaveBeenCalledWith(0)

    await user.click(screen.getByRole('button', { name: '跳转到原聊天 ↗' }))
    expect(props.onJumpToEvidence).toHaveBeenCalledWith(0)

    await user.click(screen.getByRole('button', { name: '加载更多证据' }))
    expect(props.onLoadMoreEvidence).toHaveBeenCalledOnce()
  })

  it('supports keyboard focus selection and the focus-flash state', async () => {
    const user = userEvent.setup()
    const props = renderPanel({ evidenceFlash: { index: 0, nonce: 1 } })
    const card = screen.getByText(/E1 · 发送者 1/).closest('article')
    const selection = screen.getByRole('button', { name: '选择证据 E1，发送者 1' })

    expect(card).toHaveClass('ai-search-evidence-focus-flash')
    selection.focus()
    await user.keyboard('{Enter}')
    expect(props.onFocusEvidence).toHaveBeenCalledWith(0)
  })

  it('uses the shared EmptyState when no Evidence is visible', () => {
    renderPanel({ evidence: [], collectionCount: 0, hasMoreEvidence: false })

    expect(screen.getByText('等待检索结果')).toBeVisible()
    expect(screen.queryByRole('button', { name: '加载更多证据' })).not.toBeInTheDocument()
  })
})
