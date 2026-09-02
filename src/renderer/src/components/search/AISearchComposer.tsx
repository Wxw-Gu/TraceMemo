import * as React from 'react'
import { Button, Popover, PopoverClose, PopoverContent, PopoverTrigger, Textarea } from '../ui'

export interface AISearchComposerProps {
  query: string
  sourceLabel: string
  rangeLabel: string
  history: string[]
  historyOpen: boolean
  loading: boolean
  knowledgeSyncing: boolean
  inputRef?: React.Ref<HTMLTextAreaElement>
  onQueryChange: (value: string) => void
  onHistoryOpenChange: (open: boolean) => void
  onRestoreHistory: (query: string) => void
  onRemoveHistory: (query: string) => void
  onSubmit: () => void
  onCancel: () => void
}

export function AISearchComposer({
  query,
  sourceLabel,
  rangeLabel,
  history,
  historyOpen,
  loading,
  knowledgeSyncing,
  inputRef,
  onQueryChange,
  onHistoryOpenChange,
  onRestoreHistory,
  onRemoveHistory,
  onSubmit,
  onCancel
}: AISearchComposerProps): React.ReactElement {
  return (
    <form
      className="relative border-t border-border bg-surface px-[18px] pb-3.5 pt-3 [@media(max-height:820px)]:pb-2.5 [@media(max-height:820px)]:pt-[9px]"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="flex items-center gap-[7px] text-[10px] leading-[15px] text-muted-foreground">
        <span>正在询问</span>
        <strong className="font-bold text-primary">{sourceLabel}</strong>
        <span className="text-foreground/70">{rangeLabel}</span>
        <Popover open={historyOpen} onOpenChange={onHistoryOpenChange}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-6 rounded-full bg-background px-2 text-[10px] text-primary shadow-none"
            >
              历史提问{history.length ? ` · ${history.length}` : ''}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="max-h-[236px] w-[min(420px,calc(100vw-36px))] overflow-y-auto p-2.5"
            aria-label="历史提问"
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={16}
          >
            <div className="flex items-center justify-between gap-2 px-1 pb-2 text-xs font-semibold">
              <span>历史提问</span>
              <PopoverClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-base text-muted-foreground"
                  aria-label="关闭历史提问"
                >
                  <span aria-hidden>×</span>
                </Button>
              </PopoverClose>
            </div>
            {history.length ? (
              history.map((item) => (
                <div className="flex items-center gap-1" key={item}>
                  <Button
                    variant="ghost"
                    className="h-8 min-w-0 flex-1 justify-start overflow-hidden px-2 text-xs font-normal text-muted-foreground"
                    onClick={() => onRestoreHistory(item)}
                    title={item}
                  >
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">{item}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-base text-muted-foreground"
                    onClick={() => onRemoveHistory(item)}
                    aria-label={`删除历史问题：${item}`}
                    title="删除这条历史问题"
                  >
                    <span aria-hidden>×</span>
                  </Button>
                </div>
              ))
            ) : (
              <span className="block px-1 pb-1 pt-2 text-[10px] text-muted-foreground">
                还没有历史提问
              </span>
            )}
          </PopoverContent>
        </Popover>
      </div>
      <div className="mt-[7px] flex items-end gap-2">
        <Textarea
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            onSubmit()
          }}
          className="min-h-[56px] min-w-0 flex-1 resize-none bg-background px-2.5 py-2 text-xs leading-[18px]"
          placeholder="例如：技术交流群最近讨论了哪些 Windows 性能问题？"
          rows={2}
        />
        {loading ? (
          <Button
            type="button"
            variant="outline"
            className="border-destructive/50 bg-destructive/10 px-3 text-[11px] text-destructive hover:bg-destructive/15 hover:text-destructive"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onCancel()
            }}
          >
            取消分析
            <span aria-hidden className="text-base leading-3">
              ×
            </span>
          </Button>
        ) : (
          <Button
            type="submit"
            className="px-3 text-[11px]"
            disabled={knowledgeSyncing}
            title={knowledgeSyncing ? '知识库同步完成后才能开始分析' : undefined}
          >
            {knowledgeSyncing ? '同步中，暂不可分析' : '开始分析'}
            <span aria-hidden className="text-base leading-3">
              →
            </span>
          </Button>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] leading-[15px] text-muted-foreground">
        <span>Enter 发送 · Shift + Enter 换行</span>
        <span>AI 仅使用当前搜索所需的受控证据</span>
      </div>
    </form>
  )
}
