/**
 * 微信纯文本渲染。
 *
 * 微信气泡不渲染 Markdown，所以外发前把常见 Markdown 语法降级成可读纯文本。
 * 刻意不处理斜体（`*text*`）：微信里 `*` 常作为普通字符出现，转换会误伤正文。
 */

const RE_CODE_BLOCK = /```[^\n]*\n?([\s\S]*?)```/g
const RE_INLINE_CODE = /`([^`]+)`/g
const RE_IMAGE = /!\[[^\]]*\]\([^)]*\)/g
const RE_LINK = /\[([^\]]+)\]\([^)]*\)/g
const RE_TABLE_SEPARATOR = /^\|[\s:|-]+\|$/gm
const RE_TABLE_ROW = /^\|(.+)\|$/gm
const RE_HEADER = /^#{1,6}\s+/gm
const RE_BOLD = /\*\*(.+?)\*\*|__(.+?)__/g
const RE_STRIKE = /~~(.+?)~~/g
const RE_BLOCKQUOTE = /^>\s?/gm
const RE_HORIZONTAL_RULE = /^[-*_]{3,}\s*$/gm
const RE_UNORDERED_LIST = /^(\s*)[-*+]\s+/gm
const RE_EXCESS_BLANK_LINES = /\n{3,}/g
const RE_MARKDOWN_IMAGE_URL = /!\[[^\]]*\]\(([^)]+)\)/g

export function markdownToPlainText(text: string): string {
  let result = String(text ?? '')

  result = result.replace(RE_CODE_BLOCK, (_match, body: string) => String(body ?? '').trim())
  result = result.replace(RE_IMAGE, '')
  result = result.replace(RE_LINK, '$1')
  result = result.replace(RE_TABLE_SEPARATOR, '')
  result = result.replace(RE_TABLE_ROW, (_match, body: string) =>
    String(body ?? '')
      .split('|')
      .map((cell) => cell.trim())
      .join('  ')
  )
  result = result.replace(RE_HEADER, '')
  result = result.replace(RE_BOLD, (_match, strong: string, alternative: string) =>
    strong !== undefined && strong !== '' ? strong : String(alternative ?? '')
  )
  result = result.replace(RE_STRIKE, '$1')
  result = result.replace(RE_BLOCKQUOTE, '')
  result = result.replace(RE_HORIZONTAL_RULE, '')
  result = result.replace(RE_UNORDERED_LIST, '$1• ')
  result = result.replace(RE_INLINE_CODE, '$1')
  result = result.replace(RE_EXCESS_BLANK_LINES, '\n\n')

  return result.trim()
}

/** 提取 Markdown 中内嵌的 http(s) 图片地址，用于"文字 + 随后补发图片"。 */
export function extractMarkdownImageUrls(text: string): string[] {
  const urls: string[] = []
  for (const match of String(text ?? '').matchAll(RE_MARKDOWN_IMAGE_URL)) {
    const url = String(match[1] ?? '').trim()
    if (url.startsWith('http://') || url.startsWith('https://')) urls.push(url)
  }
  return urls
}
