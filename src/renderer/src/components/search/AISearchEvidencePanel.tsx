import * as React from 'react'
import { Button, EmptyState } from '../ui'
import type { EvidenceItem } from './searchTypes'
import { formatMessageTime, messageIdentity, messageText, senderName } from './searchUtils'

export interface AISearchEvidencePanelProps {
  evidence: EvidenceItem[]
  collectionCount: number
  selectedEvidence: number
  evidenceFlash: { index: number; nonce: number }
  senderNames: Record<string, string>
  hasMoreEvidence: boolean
  onFocusEvidence: (index: number) => void
  onJumpToEvidence: (index: number) => void
  onLoadMoreEvidence: () => void
  setEvidenceCardRef: (index: number, node: HTMLElement | null) => void
}

export function AISearchEvidencePanel({
  evidence,
  collectionCount,
  selectedEvidence,
  evidenceFlash,
  senderNames,
  hasMoreEvidence,
  onFocusEvidence,
  onJumpToEvidence,
  onLoadMoreEvidence,
  setEvidenceCardRef
}: AISearchEvidencePanelProps): React.ReactElement {
  return (
    <aside className="min-h-0 min-w-0 overflow-y-auto border-l border-border bg-surface-muted px-3.5 py-4 [@media(max-height:820px)]:pt-3">
      <div className="mb-3.5 flex items-start justify-between gap-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] leading-[15px] text-muted-foreground">可追溯数据</span>
          <strong className="text-sm font-bold leading-5 text-foreground">证据与来源</strong>
        </div>
        {collectionCount > 0 && (
          <span className="whitespace-nowrap rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-bold leading-4 text-accent-foreground">
            {evidence.length}/{collectionCount} 条样本
          </span>
        )}
      </div>
      {evidence.length ? (
        evidence.map((item, index) => {
          const selected = selectedEvidence === index
          const flashing = evidenceFlash.index === index
          const evidenceLabel = item.evidenceId || `E${index + 1}`
          const evidenceSender = senderName(item.message, item.contact, senderNames)
          return (
            <article
              key={`${messageIdentity(item.message)}-${index}-${flashing ? evidenceFlash.nonce : 0}`}
              ref={(node) => setEvidenceCardRef(index, node)}
              className={`group relative mb-2 block w-full rounded-md border bg-surface-elevated p-3 text-left text-foreground shadow-surface transition-colors duration-fast ease-tm-standard has-[:hover]:border-primary ${selected ? 'border-primary bg-accent' : 'border-border'} ${flashing ? 'focus-flash ai-search-evidence-focus-flash' : ''}`}
              style={{ animationDelay: `${Math.min(index, 7) * 45}ms` }}
            >
              <button
                type="button"
                className="absolute inset-0 z-0 cursor-pointer rounded-md border-0 bg-transparent p-0 hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                aria-label={`选择证据 ${evidenceLabel}，${evidenceSender}`}
                onClick={() => onFocusEvidence(index)}
              >
                <span className="sr-only">选择这条证据</span>
              </button>
              <div className="pointer-events-none relative z-[1]">
                <span className="flex justify-between gap-2">
                  <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] font-bold">
                    {evidenceLabel} · {evidenceSender}
                  </strong>
                  <time className="shrink-0 text-[9px] text-muted-foreground">
                    {formatMessageTime(item.message)}
                  </time>
                </span>
                <span className="mt-0.5 block text-[10px] leading-[15px] text-primary">
                  {item.contact.m_nsNickName}
                </span>
                {item.sourceKind === 'voice' && (
                  <span className="block text-[11px] font-semibold text-primary">语音转写</span>
                )}
                <span className="mt-[7px] block overflow-hidden text-[11px] leading-[17px] text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                  {messageText(item.message)}
                </span>
                <Button
                  variant="link"
                  size="sm"
                  className="pointer-events-auto relative z-[2] mt-1.5 h-auto p-0 text-[10px] font-bold"
                  onClick={() => onJumpToEvidence(index)}
                >
                  跳转到原聊天 ↗
                </Button>
              </div>
            </article>
          )
        })
      ) : (
        <EmptyState
          className="min-h-[260px] border-0 bg-transparent px-6 py-8"
          icon={<span className="text-[34px] leading-none opacity-60">⌕</span>}
          title="等待检索结果"
          description="分析完成后，这里会显示支持结论的原始消息。"
        />
      )}
      {hasMoreEvidence && (
        <Button
          variant="outline"
          size="sm"
          className="mb-3 mt-1 w-full text-[11px] font-bold text-primary"
          onClick={onLoadMoreEvidence}
        >
          加载更多证据
        </Button>
      )}
    </aside>
  )
}
