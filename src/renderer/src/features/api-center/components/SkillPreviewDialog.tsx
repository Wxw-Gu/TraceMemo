import { useMemo, useState, type ReactElement } from 'react'

export function SkillPreviewDialog({
  content,
  version,
  onClose
}: {
  content: string
  version?: string
  onClose: () => void
}): ReactElement {
  const [raw, setRaw] = useState(false)
  const lines = useMemo(() => content.split('\n'), [content])
  return (
    <div
      className="api-markdown-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="TraceMemo Reader Skill 预览"
    >
      <div>
        <header>
          <div>
            <strong>TraceMemo Reader</strong>
            <span>{version || 'v1.0'}</span>
          </div>
          <div>
            <button type="button" onClick={() => setRaw((current) => !current)}>
              {raw ? '渲染预览' : '原始文本'}
            </button>
            <button type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>
        {raw ? (
          <pre>{content}</pre>
        ) : (
          <article className="skill-markdown-preview">
            {lines.map((line, index) =>
              line.startsWith('# ') ? (
                <h1 key={index}>{line.slice(2)}</h1>
              ) : line.startsWith('## ') ? (
                <h2 key={index}>{line.slice(3)}</h2>
              ) : line.startsWith('- ') ? (
                <li key={index}>{line.slice(2)}</li>
              ) : line.startsWith('```') ? null : line ? (
                <p key={index}>{line}</p>
              ) : (
                <br key={index} />
              )
            )}
          </article>
        )}
      </div>
    </div>
  )
}
