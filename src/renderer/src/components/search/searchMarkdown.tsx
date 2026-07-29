import React from 'react'

const inlineMarkdown = (value: string, keyPrefix: string): React.ReactNode[] =>
  value.split(/(\*\*.*?\*\*|`.*?`|\*.*?\*)/g).map((part, index) => {
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
    return <React.Fragment key={key}>{part}</React.Fragment>
  })

export const renderMarkdown = (value: string): React.ReactNode =>
  value.split(/\r?\n/).map((line, index) => {
    const key = `markdown-${index}`
    if (!line.trim()) return <div key={key} className="ai-search-markdown-spacer" />
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const Heading = `h${heading[1].length}` as 'h1' | 'h2' | 'h3'
      return <Heading key={key}>{inlineMarkdown(heading[2], key)}</Heading>
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line)
    if (bullet) {
      return (
        <div key={key} className="ai-search-markdown-list-item">
          <span aria-hidden>•</span>
          <span>{inlineMarkdown(bullet[1], key)}</span>
        </div>
      )
    }
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (numbered) {
      return (
        <div key={key} className="ai-search-markdown-list-item">
          <span aria-hidden>{line.trim().match(/^\d+/)?.[0]}.</span>
          <span>{inlineMarkdown(numbered[1], key)}</span>
        </div>
      )
    }
    return <p key={key}>{inlineMarkdown(line, key)}</p>
  })
