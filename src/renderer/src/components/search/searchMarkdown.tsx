import React from 'react'

type MarkdownOptions = {
  evidenceCount?: number
  onEvidenceClick?: (index: number) => void
}

/** Converts AI Markdown into readable clipboard text while preserving evidence IDs. */
export const markdownToPlainText = (value: string): string =>
  value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}[-*+]\s+/, '• ')
        .replace(/^\s*>\s?/, '')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
        .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
        .trimEnd()
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const inlineMarkdown = (
  value: string,
  keyPrefix: string,
  options: MarkdownOptions = {}
): React.ReactNode[] =>
  value.split(/(\*\*.*?\*\*|`.*?`|\*.*?\*|\[E\d+\])/g).map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key}>{part.slice(1, -1)}</code>
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={key}>{part.slice(1, -1)}</em>
    }
    const evidence = /^\[E(\d+)\]$/.exec(part)
    if (evidence) {
      const evidenceIndex = Number(evidence[1]) - 1
      if (
        evidenceIndex >= 0 &&
        evidenceIndex < (options.evidenceCount || 0) &&
        options.onEvidenceClick
      ) {
        return (
          <button
            key={key}
            type="button"
            className="ai-search-inline-evidence"
            onClick={() => options.onEvidenceClick?.(evidenceIndex)}
            title={`查看证据 E${evidenceIndex + 1}`}
          >
            {part}
          </button>
        )
      }
    }
    return <React.Fragment key={key}>{part}</React.Fragment>
  })

export const renderMarkdown = (value: string, options: MarkdownOptions = {}): React.ReactNode =>
  value.split(/\r?\n/).map((line, index) => {
    const key = `markdown-${index}`
    if (!line.trim()) return <div key={key} className="ai-search-markdown-spacer" />
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const Heading = `h${heading[1].length}` as 'h1' | 'h2' | 'h3'
      return <Heading key={key}>{inlineMarkdown(heading[2], key, options)}</Heading>
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line)
    if (bullet) {
      return (
        <div key={key} className="ai-search-markdown-list-item">
          <span aria-hidden>•</span>
          <span>{inlineMarkdown(bullet[1], key, options)}</span>
        </div>
      )
    }
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (numbered) {
      return (
        <div key={key} className="ai-search-markdown-list-item">
          <span aria-hidden>{line.trim().match(/^\d+/)?.[0]}.</span>
          <span>{inlineMarkdown(numbered[1], key, options)}</span>
        </div>
      )
    }
    return <p key={key}>{inlineMarkdown(line, key, options)}</p>
  })
