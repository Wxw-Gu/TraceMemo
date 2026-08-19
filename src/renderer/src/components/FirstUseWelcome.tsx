import React, { useRef } from 'react'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from './ui'

interface FirstUseWelcomeProps {
  onDismiss: () => void
  onOpenSearch: () => void
  onOpenReport: () => void
  onOpenAISettings: () => void
}

const GUIDE_URL =
  'https://github.com/Wxw-Gu/WechatExplorer/blob/main/docs/user-guide/getting-started.md'

export function FirstUseWelcome({
  onDismiss,
  onOpenSearch,
  onOpenReport,
  onOpenAISettings
}: FirstUseWelcomeProps): React.ReactElement {
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  const dismiss = (): void => {
    const restoreFocus = restoreFocusRef.current
    restoreFocusRef.current = null
    onDismiss()
    queueMicrotask(() => restoreFocus?.focus())
  }

  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] max-w-[520px] overflow-y-auto p-6 sm:p-8"
        onOpenAutoFocus={() => {
          restoreFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
      >
        <div
          className="mb-4 grid h-10 w-10 place-items-center rounded-md bg-primary text-xl text-primary-foreground shadow-surface"
          aria-hidden="true"
        >
          ✦
        </div>
        <p className="text-xs font-semibold uppercase text-primary">微信已连接</p>
        <DialogTitle className="mt-1 text-2xl">开始探索你的微信</DialogTitle>
        <DialogDescription className="mt-2 text-sm leading-relaxed">
          最关键的一步已经完成。现在，让 AI 帮你看看最近的聊天都发生了什么。
        </DialogDescription>

        <Button
          className="mt-5 h-auto w-full justify-start whitespace-normal p-4 text-left"
          onClick={onOpenReport}
        >
          <span
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface text-lg text-primary"
            aria-hidden="true"
          >
            ✦
          </span>
          <span className="min-w-0 flex-1">
            <strong className="block text-sm">试试 AI 群聊日报</strong>
            <small className="mt-0.5 block text-xs text-primary-foreground/75">
              选择一个群聊，看看最近聊了什么
            </small>
          </span>
          <span className="shrink-0 text-xs" aria-hidden="true">
            立即体验 →
          </span>
        </Button>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={dismiss}>
            查看聊天记录
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpenSearch}>
            问问你的微信
          </Button>
        </div>

        <div className="mt-5 flex flex-col items-start gap-2 border-t border-border pt-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>还没有配置 AI？</span>
          <Button className="h-auto p-0 text-xs" variant="link" onClick={onOpenAISettings}>
            配置 AI 模型
          </Button>
          <a
            className="text-primary hover:underline"
            href={GUIDE_URL}
            target="_blank"
            rel="noreferrer"
          >
            查看完整使用教程
          </a>
        </div>
      </DialogContent>
    </Dialog>
  )
}
