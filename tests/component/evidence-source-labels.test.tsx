/**
 * Evidence 的来源语义与来源标签。
 *
 * 不能退让的约束：
 * 1. **消息类型**与**派生来源**是两个正交维度，UI 必须分别标出来：
 *    前者说"原始消息是什么"（文本 / 图片 / 语音…），
 *    后者说"这条结果是靠什么命中的"（OCR命中 / 转写命中）；
 * 2. authoritative source 仍是原始消息 —— messageRef 不变，跳转目标就是它；
 * 3. 派生命中内容必须自报来源（`OCR摘录：` / `转写摘录：`），
 *    不能被读成群友真的发过这样一段文字；
 * 4. 引擎内部前缀（`图片文字：` / `OCR:` / `system-ocr`）绝不出现在用户可见文本里；
 * 5. 普通文字消息只标「文本消息」，不凭空多出来源标记。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AISearchEvidencePanel } from '../../src/renderer/src/components/search/AISearchEvidencePanel'
import { mapAskWechatEvidence } from '../../src/renderer/src/components/search/askWechatPresentation'
import type { EvidenceItem } from '../../src/renderer/src/components/search/searchTypes'
import type { AskWechatEvidenceItem } from '../../src/shared/query-agent'
import { encodeMessageRef } from '../../src/shared/local-query-api'

const OCR_TEXT = '今日特价 248 元'
const TRANSCRIPT_TEXT = '明天下午三点评审'
const IMAGE_REF = encodeMessageRef('fixture-conversation-a', '9001')
const VOICE_REF = encodeMessageRef('fixture-conversation-a', '9002')
const TEXT_REF = encodeMessageRef('fixture-conversation-a', '9003')

const base = {
  conversationName: '测试群',
  conversationType: 'group' as const,
  sender: '用户A',
  source: 'search_messages'
}

/** 图片 OCR 命中。 */
const imageOcrEvidence: AskWechatEvidenceItem = {
  ...base,
  messageRef: IMAGE_REF,
  timestamp: Date.parse('2026-09-03T14:32:00+08:00'),
  messageType: 'image',
  text: OCR_TEXT,
  derivedSource: 'image_ocr',
  imageOcrText: OCR_TEXT
}

/** 语音转写命中。 */
const voiceTranscriptEvidence: AskWechatEvidenceItem = {
  ...base,
  messageRef: VOICE_REF,
  timestamp: Date.parse('2026-09-03T14:34:00+08:00'),
  messageType: 'voice',
  text: TRANSCRIPT_TEXT,
  derivedSource: 'voice_transcript'
}

/** 普通文字消息（对照组）。 */
const plainEvidence: AskWechatEvidenceItem = {
  ...base,
  messageRef: TEXT_REF,
  timestamp: Date.parse('2026-09-03T14:30:00+08:00'),
  messageType: 'text',
  text: '这是一条普通的文字消息'
}

function renderPanel(evidence: EvidenceItem[]): React.ComponentProps<typeof AISearchEvidencePanel> {
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

describe('Evidence 的来源语义与来源标签', () => {
  it('映射层保留消息类型与派生来源，且 authoritative source 不变', () => {
    const [image] = mapAskWechatEvidence([imageOcrEvidence])
    expect(image.sourceKind).toBe('image')
    expect(image.derivedSource).toBe('image_ocr')
    expect(image.imageOcrText).toBe(OCR_TEXT)
    expect(image.messageRef).toBe(IMAGE_REF)

    const [voice] = mapAskWechatEvidence([voiceTranscriptEvidence])
    expect(voice.sourceKind).toBe('voice')
    expect(voice.derivedSource).toBe('voice_transcript')
    expect(voice.messageRef).toBe(VOICE_REF)
  })

  it('图片 OCR 命中：标「图片消息 + OCR命中」，片段写明是 OCR 摘录', () => {
    renderPanel(mapAskWechatEvidence([imageOcrEvidence]))

    expect(screen.getByTestId('evidence-badge-messageType').textContent).toBe('图片消息')
    expect(screen.getByTestId('evidence-badge-derivedSource').textContent).toBe('OCR命中')
    expect(screen.getByTestId('evidence-image-ocr-snippet').textContent).toContain(OCR_TEXT)

    const panelText = document.body.textContent || ''
    expect(panelText).toContain('OCR摘录：')
    // 内部前缀绝不能出现在用户可见文本里
    expect(panelText).not.toContain('图片文字：')
    expect(panelText).not.toContain('OCR:')
    expect(panelText).not.toContain('system-ocr')
    // 不暴露工程字段名
    expect(panelText).not.toContain('image_ocr')
    expect(panelText).not.toContain('derivedSource')
  })

  it('语音转写命中：标「语音消息 + 转写命中」，片段写明是转写摘录', () => {
    renderPanel(mapAskWechatEvidence([voiceTranscriptEvidence]))

    expect(screen.getByTestId('evidence-badge-messageType').textContent).toBe('语音消息')
    expect(screen.getByTestId('evidence-badge-derivedSource').textContent).toBe('转写命中')

    const panelText = document.body.textContent || ''
    expect(panelText).toContain('转写摘录：')
    expect(panelText).not.toContain('voice_transcript')
  })

  it('普通文字消息只标「文本消息」，没有派生来源标记', () => {
    renderPanel(mapAskWechatEvidence([plainEvidence]))

    expect(screen.getByTestId('evidence-badge-messageType').textContent).toBe('文本消息')
    expect(screen.queryByTestId('evidence-badge-derivedSource')).not.toBeInTheDocument()
    expect(screen.queryByTestId('evidence-image-ocr-snippet')).not.toBeInTheDocument()
    expect(screen.getByText('这是一条普通的文字消息')).toBeVisible()

    const panelText = document.body.textContent || ''
    expect(panelText).not.toContain('摘录：')
  })
})
