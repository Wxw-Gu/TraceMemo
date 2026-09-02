import { useMemo, useRef, useState, type ReactElement } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../../components/ui'

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
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const closingRef = useRef(false)

  const closeDialog = (): void => {
    if (closingRef.current) return
    closingRef.current = true
    const restoreFocus = restoreFocusRef.current
    restoreFocusRef.current = null
    onClose()
    queueMicrotask(() => restoreFocus?.focus())
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent
        className="h-[min(720px,calc(100vh-2rem))] max-w-[820px] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={() => {
          restoreFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
      >
        <DialogHeader className="flex-row items-center justify-between space-y-0 border-b border-border px-6 py-4 pr-14">
          <div className="flex min-w-0 items-baseline gap-2">
            <DialogTitle className="truncate tracking-normal">
              TraceMemo Reader Skill 预览
            </DialogTitle>
            <span className="shrink-0 text-xs text-muted-foreground">{version || 'v1.0'}</span>
          </div>
          <DialogDescription className="sr-only">
            查看 TraceMemo Reader Skill 的渲染预览或原始文本。
          </DialogDescription>
          <Button variant="outline" size="sm" onClick={() => setRaw((current) => !current)}>
            {raw ? '渲染预览' : '原始文本'}
          </Button>
        </DialogHeader>
        {raw ? (
          <pre className="m-0 min-h-0 overflow-auto whitespace-pre-wrap break-words bg-muted/40 px-6 py-5 font-mono text-xs leading-5 text-foreground">
            {content}
          </pre>
        ) : (
          <article className="min-h-0 overflow-auto px-6 py-5 text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
            {lines.map((line, index) =>
              line.startsWith('# ') ? (
                <h1 className="mb-4 text-xl font-semibold tracking-normal" key={index}>
                  {line.slice(2)}
                </h1>
              ) : line.startsWith('## ') ? (
                <h2 className="mb-2 mt-5 text-base font-semibold tracking-normal" key={index}>
                  {line.slice(3)}
                </h2>
              ) : line.startsWith('- ') ? (
                <li className="ml-5 list-disc" key={index}>
                  {line.slice(2)}
                </li>
              ) : line.startsWith('```') ? null : line ? (
                <p className="my-1.5" key={index}>
                  {line}
                </p>
              ) : (
                <br key={index} />
              )
            )}
          </article>
        )}
      </DialogContent>
    </Dialog>
  )
}
