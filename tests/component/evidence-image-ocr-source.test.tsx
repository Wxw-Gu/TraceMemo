/**
 * §1 / §17：Evidence 的「图片文字」来源语义。
 *
 * 三条不能退让的约束：
 * 1. 来自图片 OCR 的命中，UI 必须有轻量来源标记（「图片文字」），
 *    让用户知道这段内容来自图片，而不是群友真的发了一条文字消息；
 * 2. authoritative source 仍然是**原始图片消息** —— messageRef 不变，跳转目标就是原图；
 * 3. 引擎内部前缀（`图片文字：` / `OCR:` / `system-ocr`）绝不允许出现在用户可见文本里；
 * 4. 普通文字消息的 Evidence 完全不受影响（不该凭空多出一个标记）。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AISearchEvidencePanel } from '../../src/renderer/src/components/search/AISearchEvidencePanel'
import { mapAskWechatEvidence } from '../../src/renderer/src/components/search/askWechatPresentation'
import type { EvidenceItem } from '../../src/renderer/src/components/search/searchTypes'
import type { AskWechatEvidenceItem } from '../../src/shared/query-agent'
import { encodeMessageRef } from '../../src/shared/local-query-api'

const OCR_TEXT = 'OpenAI ChatGPT Plus $20 Pro $200'
const IMAGE_REF = encodeMessageRef('md5-tech-group', '9001')
const TEXT_REF = encodeMessageRef('md5-tech-group', '9002')

/** Query Agent 交给渲染层的证据（图片 OCR 命中）。 */
const imageOcrEvidence: AskWechatEvidenceItem = {
  messageRef: IMAGE_REF,
  conversationName: '技术交流群',
  conversationType: 'group',
  sender: '张三',
  timestamp: Date.parse('2026-09-03T14:32:00+08:00'),
  messageType: 'image',
  // 已经由 main 侧剥掉内部前缀的可读文本
  text: OCR_TEXT,
  derivedSource: 'image_ocr',
  imageOcrText: OCR_TEXT,
  source: 'search_messages'
}

/** 普通文字消息证据（对照组）。 */
const plainEvidence: AskWechatEvidenceItem = {
  messageRef: TEXT_REF,
  conversationName: '技术交流群',
  conversationType: 'group',
  sender: '张三',
  timestamp: Date.parse('2026-09-03T14:30:00+08:00'),
  messageType: 'text',
  text: '今天正常讨论一下 API',
  source: 'search_messages'
}

function renderPanel(evidence: EvidenceItem[]) {
  const props: React.ComponentProps<typeof AISearchEvidencePanel> = {
    evidence,
    collectionCount: evidence.length,
    selectedEvidence: 0,
    evidenceFlash: { index: -1, nonce: 0 },
    senderNames: {},
    hasMoreEvidence: false,
    onFocusEvidence: vi.fn(),
    onJumpToEvidence: vi.fn(),
    onLoadMoreEvidence: vi.fn(),
    setEvidenceCardRef: vi.fn()
  }
  render(<AISearchEvidencePanel {...props} />)
  return props
}

describe('图片文字 Evidence 的来源语义', () => {
  it('映射层保留派生来源与 OCR 片段，且跳转目标仍是原始图片消息', () => {
    const [mapped] = mapAskWechatEvidence([imageOcrEvidence])

    expect(mapped.derivedSource).toBe('image_ocr')
    expect(mapped.imageOcrText).toBe(OCR_TEXT)
    // authoritative source = 原始图片消息：引用不变
    expect(mapped.messageRef).toBe(IMAGE_REF)
    expect(mapped.message.id).toBe('9001')
    expect(mapped.contact.m_nsNickName).toBe('技术交流群')
    expect(mapped.sourceKind).toBe('image')
  })

  it('图片 OCR 命中显示「图片文字」标记与命中解释，不泄露内部前缀', () => {
    const evidence = mapAskWechatEvidence([imageOcrEvidence])
    renderPanel(evidence)

    const badge = screen.getByTestId('evidence-image-ocr-badge')
    expect(badge).toBeVisible()
    expect(badge.textContent).toBe('图片文字')

    const snippet = screen.getByTestId('evidence-image-ocr-snippet')
    expect(snippet.textContent).toContain(OCR_TEXT)

    // 内部前缀绝不能出现在用户可见文本里
    const panelText = document.body.textContent || ''
    expect(panelText).not.toContain('图片文字：')
    expect(panelText).not.toContain('OCR:')
    expect(panelText).not.toContain('system-ocr')
  })

  it('普通文字消息的 Evidence 不受影响：没有来源标记，也没有 OCR 片段', () => {
    const evidence = mapAskWechatEvidence([plainEvidence])
    renderPanel(evidence)

    expect(screen.queryByTestId('evidence-image-ocr-badge')).not.toBeInTheDocument()
    expect(screen.queryByTestId('evidence-image-ocr-snippet')).not.toBeInTheDocument()
    expect(screen.getByText('今天正常讨论一下 API')).toBeVisible()
  })
})
