import { useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  IconButton,
  Separator
} from '../ui'

interface ChatImageViewerProps {
  imageUrl: string
  onClose: () => void
}

export function ChatImageViewer({ imageUrl, onClose }: ChatImageViewerProps): React.ReactElement {
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const closingRef = useRef(false)

  const closeViewer = (): void => {
    if (closingRef.current) return
    closingRef.current = true
    const restoreFocus = restoreFocusRef.current
    restoreFocusRef.current = null
    onClose()
    queueMicrotask(() => restoreFocus?.focus())
  }

  const zoom = (delta: number): void => {
    setScale((current) => Math.min(8, Math.max(0.1, Number((current + delta).toFixed(2)))))
  }

  const reset = (): void => {
    setScale(1)
    setRotation(0)
    setOffset({ x: 0, y: 0 })
  }

  const handleMouseDown = (event: React.MouseEvent): void => {
    event.preventDefault()
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y
    }
  }

  const handleMouseMove = (event: React.MouseEvent): void => {
    if (!dragRef.current) return
    const drag = dragRef.current
    setOffset({
      x: drag.offsetX + event.clientX - drag.x,
      y: drag.offsetY + event.clientY - drag.y
    })
  }

  const stopDragging = (): void => {
    dragRef.current = null
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeViewer()}>
      <DialogContent
        ref={contentRef}
        className="h-[min(900px,calc(100vh-2rem))] max-w-[min(1280px,calc(100vw-2rem))] grid-rows-[48px_minmax(0,1fr)] gap-0 overflow-hidden rounded-lg bg-muted p-0"
        onOpenAutoFocus={(event) => {
          restoreFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
          event.preventDefault()
          contentRef.current?.focus()
        }}
      >
        <DialogHeader className="flex-row items-center space-y-0 border-b border-border bg-surface/90 px-4 pr-12">
          <DialogTitle className="mr-2 shrink-0 text-sm font-medium tracking-normal">
            图片查看
          </DialogTitle>
          <DialogDescription className="sr-only">
            可缩放、旋转和拖动查看当前聊天图片。
          </DialogDescription>
          <div className="flex min-w-0 items-center gap-1">
            <IconButton
              label="缩小"
              variant="ghost"
              className="h-7 w-7 text-lg"
              onClick={() => zoom(-0.1)}
            >
              <span aria-hidden>−</span>
            </IconButton>
            <span className="w-12 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
              {Math.round(scale * 100)}%
            </span>
            <IconButton
              label="放大"
              variant="ghost"
              className="h-7 w-7 text-lg"
              onClick={() => zoom(0.1)}
            >
              <span aria-hidden>+</span>
            </IconButton>
            <Separator orientation="vertical" className="mx-1 h-5" />
            <IconButton
              label="左旋转"
              variant="ghost"
              className="h-7 w-7 text-lg"
              onClick={() => setRotation((current) => current - 90)}
            >
              <span aria-hidden>↶</span>
            </IconButton>
            <IconButton
              label="右旋转"
              variant="ghost"
              className="h-7 w-7 text-lg"
              onClick={() => setRotation((current) => current + 90)}
            >
              <span aria-hidden>↷</span>
            </IconButton>
            <IconButton
              label="重置图片"
              tooltip="重置"
              variant="ghost"
              className="h-7 w-7 text-lg"
              onClick={reset}
            >
              <span aria-hidden>⟲</span>
            </IconButton>
          </div>
        </DialogHeader>
        <div
          className="flex min-h-0 cursor-grab select-none items-center justify-center overflow-hidden overscroll-contain bg-muted p-7 active:cursor-grabbing"
          aria-label="图片查看区域"
          onWheel={(event) => {
            event.preventDefault()
            zoom(event.deltaY > 0 ? -0.1 : 0.1)
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopDragging}
          onMouseLeave={stopDragging}
        >
          <img
            className="pointer-events-none h-auto w-auto max-w-none select-none object-contain shadow-floating transition-transform duration-fast ease-out"
            src={imageUrl}
            alt="图片预览"
            draggable={false}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg)`
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
