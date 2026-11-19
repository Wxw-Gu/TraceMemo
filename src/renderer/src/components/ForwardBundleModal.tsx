import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX, MouseEvent } from 'react'
import type { ForwardedMessageItem } from '../../../shared/types'
import { renderWechatEmojiText } from '../utils/wechatEmojiText'
import { ImageBubble } from './ImageBubble'

export interface ForwardBundleWindowLayer {
  id: string
  title: string
  items: ForwardedMessageItem[]
}

interface ForwardBundleModalStackProps {
  layers: ForwardBundleWindowLayer[]
  sessionId?: string
  onOpenNested: (title: string, items: ForwardedMessageItem[]) => void
  onCloseFromIndex: (index: number) => void
  onImageClick?: (imageUrl: string) => void
}

function formatSentAt(value?: string): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^\d{9,13}$/.test(raw)) {
    const ms = raw.length > 10 ? Number(raw) : Number(raw) * 1000
    const date = new Date(ms)
    if (!Number.isNaN(date.getTime())) {
      const yyyy = date.getFullYear()
      const mm = String(date.getMonth() + 1).padStart(2, '0')
      const dd = String(date.getDate()).padStart(2, '0')
      const hh = String(date.getHours()).padStart(2, '0')
      const min = String(date.getMinutes()).padStart(2, '0')
      return `${yyyy}-${mm}-${dd} ${hh}:${min}`
    }
  }
  return raw
}

function ForwardAvatar({ src, name }: { src?: string; name?: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const initial = Array.from(String(name || '?').trim())[0] || '?'

  if (src && !failed) {
    return (
      <div className="forward-modal-avatar">
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </div>
    )
  }

  return <div className="forward-modal-avatar forward-modal-avatar-fallback">{initial}</div>
}

function ForwardModalItemRow({
  item,
  sessionId,
  onOpenNested,
  onImageClick
}: {
  item: ForwardedMessageItem
  sessionId?: string
  onOpenNested: (title: string, items: ForwardedMessageItem[]) => void
  onImageClick?: (imageUrl: string) => void
}): JSX.Element {
  const isNested = item.messageType === 17 || Boolean(item.nested?.length)
  const isImage =
    !isNested &&
    (item.messageType === 2 || Boolean(item.imageMd5 || item.thumbMd5 || item.imageDatName))
  const senderName = item.sender || '未知发送者'
  const formattedTime = formatSentAt(item.sentAt)

  const handleOpenNested = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    if (!item.nested?.length) return
    onOpenNested(item.nestedTitle || item.title || '聊天记录', item.nested)
  }

  return (
    <article className="forward-modal-row">
      <ForwardAvatar src={item.sourceHeadUrl} name={senderName} />
      <div className="forward-modal-row-main">
        <header className="forward-modal-row-meta">
          <span className="forward-modal-sender">{senderName}</span>
          {formattedTime ? <time className="forward-modal-time">{formattedTime}</time> : null}
        </header>
        <div className="forward-modal-row-body">
          {isImage ? (
            <div className="forward-modal-image-wrap">
              <ImageBubble
                imageMd5={item.imageMd5 || item.thumbMd5}
                imageDatName={item.imageDatName}
                sessionId={sessionId}
                onImageClick={onImageClick}
              />
            </div>
          ) : isNested ? (
            <button
              type="button"
              className={`forward-modal-nested-card${item.nested?.length ? ' is-clickable' : ''}`}
              disabled={!item.nested?.length}
              onClick={handleOpenNested}
            >
              <div className="forward-modal-nested-title">
                {item.nestedTitle || item.title || '聊天记录'}
              </div>
              {item.nested?.length ? (
                <div className="forward-modal-nested-preview">
                  {item.nested.slice(0, 3).map((child, idx) => (
                    <div
                      key={`${child.dataId || ''}-${child.sender || ''}-${idx}`}
                      className="forward-modal-nested-line"
                    >
                      {child.sender ? `${child.sender}: ` : ''}
                      {child.text}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="forward-modal-nested-empty">{item.text || '[聊天记录]'}</div>
              )}
              <div className="forward-modal-nested-footer">
                <span>聊天记录</span>
                {item.nested?.length ? <span>共 {item.nested.length} 条 · 打开新窗口</span> : null}
              </div>
            </button>
          ) : (
            <div className="forward-modal-text">
              {renderWechatEmojiText(item.text || item.title || '[消息]', 22)}
              {item.linkUrl && /^https?:\/\//i.test(item.linkUrl) ? (
                <a
                  className="forward-modal-link"
                  href={item.linkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  打开链接 ↗
                </a>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

export function ForwardBundleModalStack({
  layers,
  sessionId,
  onOpenNested,
  onCloseFromIndex,
  onImageClick
}: ForwardBundleModalStackProps): JSX.Element | null {
  useEffect(() => {
    if (layers.length === 0) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 若此时已打开更上层的 Radix Dialog（例如 ChatImageViewer），优先交由其处理 Escape。
      if (document.querySelector('[role="dialog"][data-state="open"]')) return
      event.preventDefault()
      event.stopPropagation()
      onCloseFromIndex(layers.length - 1)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [layers.length, onCloseFromIndex])

  if (layers.length === 0 || typeof document === 'undefined') return null

  return createPortal(
    <>
      {layers.map((layer, index) => {
        const zIndex = Math.min(58, 45 + index)
        const offsetX = Math.min(index, 5) * 28
        const offsetY = Math.min(index, 5) * 24

        return (
          <div
            key={layer.id}
            className="forward-modal-backdrop"
            style={{ zIndex }}
            onClick={() => onCloseFromIndex(index)}
          >
            <section
              className="forward-modal-window"
              role="dialog"
              aria-modal="true"
              aria-label={layer.title || '聊天记录'}
              style={{
                transform: `translate(${offsetX}px, ${offsetY}px)`
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <header className="forward-modal-header">
                <div className="forward-modal-header-text">
                  <h3 className="forward-modal-title">{layer.title || '聊天记录'}</h3>
                  <span className="forward-modal-subtitle">
                    共 {layer.items.length} 条消息
                    {index > 0 ? ` · 嵌套窗口 #${index + 1}` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="forward-modal-close"
                  aria-label="关闭聊天记录窗口"
                  onClick={() => onCloseFromIndex(index)}
                >
                  ×
                </button>
              </header>
              <div className="forward-modal-body">
                {layer.items.length > 0 ? (
                  layer.items.map((item, itemIdx) => (
                    <ForwardModalItemRow
                      key={`${layer.id}-${item.dataId || ''}-${item.dataIndex ?? itemIdx}-${itemIdx}`}
                      item={item}
                      sessionId={sessionId}
                      onOpenNested={onOpenNested}
                      onImageClick={onImageClick}
                    />
                  ))
                ) : (
                  <div className="forward-modal-empty">暂未解析到可展示的记录</div>
                )}
              </div>
            </section>
          </div>
        )
      })}
    </>,
    document.body
  )
}
