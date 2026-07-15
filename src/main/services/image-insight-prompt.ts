// src/main/services/image-insight-prompt.ts
// 图片理解 prompt 模板 — 输出严格的 JSON,便于程序化解析

export const IMAGE_ANALYSIS_SYSTEM_PROMPT = `你是微信群聊的图片分析助手。
请根据用户提供的图片和图片前后的聊天上下文,生成对该图片的结构化理解。

输出要求(严格遵守):
1. 必须输出 JSON,不要用 markdown 代码块包裹
2. description:1-2 句中文,30-80 字,描述图片核心内容
3. ocrText:如果图片含文字(截图、文档、票据等),提取出来;纯风景/表情包可填空字符串
4. tags:3-6 个中文关键词标签
5. category:screenshot / photo / meme / document / chart / other 之一
6. importance:low / medium / high — 根据图片的信息密度和后续讨论热度判断

禁止:
- 不要猜测图片中未明确可见的内容
- 不要复述聊天上下文本身(那是 description 之外的事)
- 不要输出 markdown 标记`

export interface ImageAnalysisContext {
  sender: string
  sentAt: number
  contextBefore: string[] // 图片前 1-3 条消息
  contextAfter: string[] // 图片后 1-3 条消息
}

export function buildImageAnalysisUserText(ctx: ImageAnalysisContext): string {
  const before = ctx.contextBefore.length
    ? ctx.contextBefore.map((m, i) => `  ${i + 1}. ${m}`).join('\n')
    : '  (无前文)'
  const after = ctx.contextAfter.length
    ? ctx.contextAfter.map((m, i) => `  ${i + 1}. ${m}`).join('\n')
    : '  (无后续讨论)'
  const time = new Date(ctx.sentAt * 1000).toLocaleString('zh-CN', { hour12: false })

  return `发送者:${ctx.sender}
时间:${time}

图片前的聊天:
${before}

图片后的聊天:
${after}

请输出 JSON(严格遵守 system 要求):
{"description":"...","ocrText":"...","tags":["..."],"category":"...","importance":"..."}`
}

/**
 * 把 AI 文本响应解析成结构化字段。
 * 容忍:无 markdown 包裹、有 markdown 包裹、尾部有杂质等。
 */
export function parseImageAnalysisResponse(raw: string): {
  description: string
  ocrText: string
  tags: string[]
  category: 'screenshot' | 'photo' | 'meme' | 'document' | 'chart' | 'other'
  importance: 'low' | 'medium' | 'high'
} {
  const text = raw.trim()
  // 提取 JSON 段
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('AI 未返回合法 JSON')
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    throw new Error('AI 返回的 JSON 无法解析')
  }

  const description = String(parsed.description || '').trim()
  if (!description) throw new Error('AI 未返回 description')

  const ocrText = String(parsed.ocrText || '').trim()
  const tagsRaw = parsed.tags
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
    : []

  const categoryRaw = String(parsed.category || 'other').toLowerCase()
  const category: 'screenshot' | 'photo' | 'meme' | 'document' | 'chart' | 'other' =
    ['screenshot', 'photo', 'meme', 'document', 'chart'].includes(categoryRaw)
      ? (categoryRaw as 'screenshot' | 'photo' | 'meme' | 'document' | 'chart')
      : 'other'

  const importanceRaw = String(parsed.importance || 'medium').toLowerCase()
  const importance: 'low' | 'medium' | 'high' = ['low', 'medium', 'high'].includes(importanceRaw)
    ? (importanceRaw as 'low' | 'medium' | 'high')
    : 'medium'

  return { description, ocrText, tags, category, importance }
}