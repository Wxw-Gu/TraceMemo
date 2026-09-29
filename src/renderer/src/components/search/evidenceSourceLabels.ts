import type { KnowledgeDerivedSource, KnowledgeMessageKind } from '../../../../shared/knowledge'

/**
 * 证据卡的来源标签。
 *
 * 两个维度**正交**，必须分开表达，不能混成一个标签：
 * - 消息类型（`sourceKind`）：原始消息本身是什么；
 * - 派生来源（`derivedSource`）：这条结果是**靠什么命中**的（本地派生的 OCR / 转写）。
 *
 * 文案面向用户：不出现 `image_ocr` 这类工程词。每条证据最多两个标签，
 * 顺序固定为「消息类型 + 派生来源」。
 */

/** 只列用户看得懂的类型；`other` 之类没有信息量的取值不给标签。 */
const MESSAGE_TYPE_LABELS: Record<string, string> = {
  text: '文本消息',
  image: '图片消息',
  voice: '语音消息',
  video: '视频消息',
  file: '文件消息',
  link: '链接消息',
  sticker: '表情消息',
  system: '系统消息'
}

const DERIVED_SOURCE_LABELS: Record<KnowledgeDerivedSource, string> = {
  image_ocr: 'OCR命中',
  voice_transcript: '转写命中'
}

/**
 * 派生命中内容的 snippet 前缀。
 *
 * 目的只有一个：**不能让派生文本看起来像原始聊天内容**。
 * 普通文本消息不加前缀，原样展示。
 */
const DERIVED_SNIPPET_PREFIXES: Record<KnowledgeDerivedSource, string> = {
  image_ocr: 'OCR摘录：',
  voice_transcript: '转写摘录：'
}

export interface EvidenceSourceBadge {
  /** 稳定的 DOM key，不用下标 —— 标签顺序可能随数据变化。 */
  key: 'messageType' | 'derivedSource'
  label: string
}

export function evidenceSourceBadges(item: {
  sourceKind?: KnowledgeMessageKind | string
  derivedSource?: KnowledgeDerivedSource
}): EvidenceSourceBadge[] {
  const badges: EvidenceSourceBadge[] = []
  const messageLabel = item.sourceKind ? MESSAGE_TYPE_LABELS[item.sourceKind] : undefined
  if (messageLabel) badges.push({ key: 'messageType', label: messageLabel })
  const derivedLabel = item.derivedSource ? DERIVED_SOURCE_LABELS[item.derivedSource] : undefined
  if (derivedLabel) badges.push({ key: 'derivedSource', label: derivedLabel })
  return badges
}

/** 派生内容的 snippet 前缀；普通文本消息返回空串（原样展示）。 */
export function derivedSnippetPrefix(source?: KnowledgeDerivedSource): string {
  return source ? DERIVED_SNIPPET_PREFIXES[source] : ''
}
