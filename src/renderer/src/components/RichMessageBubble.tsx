import { ParsedContent } from '../../../shared/types'
import { useEffect, useState } from 'react'
import type { JSX, MouseEvent } from 'react'
import { renderWechatEmojiText } from '../utils/wechatEmojiText'
import { ImageBubble } from './ImageBubble'

const stickerDataUrlCache = new Map<string, string>()

interface RichMessageBubbleProps {
  contentData: ParsedContent
  sessionId?: string
  onImageClick?: (imageUrl: string) => void
}

export function RichMessageBubble({
  contentData,
  sessionId,
  onImageClick
}: RichMessageBubbleProps): JSX.Element {
  switch (contentData.type) {
    case 'location':
      return <LocationBubble data={contentData} />
    case 'card':
      return <CardBubble data={contentData} />
    case 'share':
      return <ShareBubble data={contentData} />
    case 'forwardBundle':
      return <ForwardBundleBubble data={contentData} />
    case 'miniProgram':
      return (
        <MiniProgramBubble data={contentData} sessionId={sessionId} onImageClick={onImageClick} />
      )
    case 'redPacket':
      return <RedPacketBubble data={contentData} />
    case 'voip':
      return <VoipBubble data={contentData} />
    case 'sticker':
      return <StickerBubble data={contentData} />
    case 'quote':
      return <QuoteBubble data={contentData} sessionId={sessionId} onImageClick={onImageClick} />
    case 'system':
      return <SystemBubble data={contentData} />
    case 'unknown':
      return (
        <div className="unsupported-message">
          <strong>暂不支持此消息</strong>
          <span>
            消息类型 {(contentData as { messageType?: string | number }).messageType || '未知'}
          </span>
        </div>
      )
    default:
      return <div className="message-text">[不支持的消息类型]</div>
  }
}

function ForwardBundleBubble({
  data
}: {
  data: Extract<ParsedContent, { type: 'forwardBundle' }>
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const visibleItems = expanded ? data.items : data.items.slice(0, 3)
  const hiddenCount = Math.max(0, data.items.length - visibleItems.length)

  return (
    <div className="forward-bundle-message">
      <button
        type="button"
        className="forward-bundle-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span>{data.title || '聊天记录'}</span>
        <small>
          {data.items.length ? `${data.items.length} 条消息` : data.description || '聊天记录'}
        </small>
      </button>
      <div className="forward-bundle-list">
        {visibleItems.length ? (
          visibleItems.map((item, index) => (
            <div
              className="forward-bundle-item"
              key={`${item.sender || ''}-${item.sentAt || ''}-${index}`}
            >
              {item.sender && <b>{item.sender}</b>}
              <span>{renderWechatEmojiText(item.text, 24)}</span>
              {item.nested?.length ? <small>包含 {item.nested.length} 条聊天记录</small> : null}
            </div>
          ))
        ) : (
          <div className="forward-bundle-empty">暂未解析到可展示的记录</div>
        )}
      </div>
      {(hiddenCount > 0 || expanded) && data.items.length > 3 ? (
        <button
          type="button"
          className="forward-bundle-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起' : `展开其余 ${hiddenCount} 条`}
        </button>
      ) : null}
    </div>
  )
}

function LocationBubble({
  data
}: {
  data: Extract<ParsedContent, { type: 'location' }>
}): JSX.Element {
  const { poiname, label, lat, lng } = data
  const locationText = poiname || label || '位置'
  const hasCoords = lat !== 0 || lng !== 0

  const handleClick = (): void => {
    if (hasCoords) {
      const url = `https://maps.apple.com/?q=${encodeURIComponent(locationText)}&ll=${lat},${lng}`
      window.open(url, '_blank')
    }
  }

  return (
    <div className="location-message" onClick={hasCoords ? handleClick : undefined}>
      <div className="location-icon">位置</div>
      <div className="location-info">
        <div className="location-name">{locationText}</div>
        {label && poiname && label !== poiname && <div className="location-label">{label}</div>}
        {hasCoords && (
          <div className="location-coords">
            {lat.toFixed(6)}, {lng.toFixed(6)}
          </div>
        )}
      </div>
    </div>
  )
}

function CardBubble({ data }: { data: Extract<ParsedContent, { type: 'card' }> }): JSX.Element {
  const { username, nickname } = data

  const handleCopy = (e: MouseEvent): void => {
    e.stopPropagation()
    navigator.clipboard.writeText(username)
  }

  return (
    <div className="card-message">
      <div className="card-avatar">{(nickname || username).charAt(0).toUpperCase()}</div>
      <div className="card-info">
        <div className="card-nickname">{nickname || '未知'}</div>
        <div className="card-username" onClick={handleCopy} title="点击复制">
          {username}
        </div>
      </div>
    </div>
  )
}

function ShareBubble({ data }: { data: Extract<ParsedContent, { type: 'share' }> }): JSX.Element {
  const { title, des, url, appname } = data

  const handleClick = (): void => {
    if (url) {
      window.open(url, '_blank')
    }
  }

  const urlHost = getUrlHost(url)

  return (
    <div className="share-message" onClick={handleClick}>
      {appname && <div className="share-appname">{appname}</div>}
      <div className="share-title">{title || '链接'}</div>
      {des && <div className="share-desc">{des}</div>}
      {urlHost && <div className="share-url">{urlHost}</div>}
    </div>
  )
}

function MiniProgramBubble({
  data,
  sessionId,
  onImageClick
}: {
  data: Extract<ParsedContent, { type: 'miniProgram' }>
  sessionId?: string
  onImageClick?: (imageUrl: string) => void
}): JSX.Element {
  return (
    <div className="mini-program-message">
      <div className="mini-program-title">{data.title}</div>
      {data.description && <div className="mini-program-description">{data.description}</div>}
      {data.thumbDataUrl ? (
        <div className="mini-program-preview">
          <img
            className="mini-program-inline-image"
            src={data.thumbDataUrl}
            alt={data.title}
            onClick={() => onImageClick?.(data.thumbDataUrl || '')}
          />
        </div>
      ) : data.thumbMd5 ? (
        <div className="mini-program-preview">
          <ImageBubble
            imageMd5={data.thumbMd5}
            imageDatName={data.thumbDatName}
            sessionId={sessionId}
            isThumb
            fallbackUrl={data.iconUrl}
            onImageClick={onImageClick}
          />
        </div>
      ) : data.iconUrl ? (
        <img className="mini-program-icon" src={data.iconUrl} alt="" referrerPolicy="no-referrer" />
      ) : null}
      <div className="mini-program-footer">
        <span aria-hidden>⌁</span>
        <span>{data.appName || '小程序'}</span>
      </div>
    </div>
  )
}

function RedPacketBubble({
  data
}: {
  data: Extract<ParsedContent, { type: 'redPacket' }>
}): JSX.Element {
  const handleClick = (): void => {
    if (data.url) window.open(data.url, '_blank')
  }

  return (
    <div
      className={`red-packet-message ${data.url ? 'is-clickable' : ''}`}
      onClick={data.url ? handleClick : undefined}
    >
      <div className="red-packet-main">
        <span className="red-packet-icon" aria-hidden>
          ¥
        </span>
        <span className="red-packet-copy">
          <strong>{data.title}</strong>
          <small>{data.description || '恭喜发财，大吉大利'}</small>
        </span>
      </div>
      <div className="red-packet-footer">微信红包</div>
    </div>
  )
}

function VoipBubble({ data }: { data: Extract<ParsedContent, { type: 'voip' }> }): JSX.Element {
  const { status, roomType, duration } = data
  const isVideo = roomType === 1

  const formatDuration = (seconds: number | undefined): string => {
    if (!seconds) return ''
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    if (mins > 0) {
      return `${mins}分${secs}秒`
    }
    return `${secs}秒`
  }

  return (
    <div className="voip-message">
      <span className="voip-icon">{isVideo ? '视频' : '通话'}</span>
      <span className="voip-status">
        {status}
        {duration ? ` ${formatDuration(duration)}` : ''}
      </span>
    </div>
  )
}

function StickerBubble({
  data
}: {
  data: Extract<ParsedContent, { type: 'sticker' }>
}): JSX.Element {
  const { md5, url, thumbUrl } = data
  const sourceUrl = url || thumbUrl || ''
  const cacheKey = md5 || sourceUrl
  const [displayUrl, setDisplayUrl] = useState(() =>
    cacheKey ? stickerDataUrlCache.get(cacheKey) || '' : ''
  )
  const [loading, setLoading] = useState(Boolean(sourceUrl || md5) && !displayUrl)
  const [error, setError] = useState(false)
  const [errorText, setErrorText] = useState('')

  useEffect(() => {
    if (!cacheKey || displayUrl || error) return

    let cancelled = false
    window.api
      .getSticker(sourceUrl, md5)
      .then((result) => {
        if (cancelled) return
        if (result.success && result.data) {
          stickerDataUrlCache.set(cacheKey, result.data)
          setDisplayUrl(result.data)
          setError(false)
          setErrorText('')
        } else {
          setError(true)
          setErrorText(result.error || '表情包未缓存')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true)
          setErrorText('表情包加载失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [cacheKey, displayUrl, error, md5, sourceUrl])

  if (displayUrl) {
    return (
      <div className="sticker-message">
        <img src={displayUrl} alt="表情包" className="sticker-image" referrerPolicy="no-referrer" />
      </div>
    )
  }

  if (loading) {
    return (
      <div className="sticker-message">
        <div className="sticker-placeholder">表情包加载中...</div>
      </div>
    )
  }

  return (
    <div className="sticker-message">
      <div className="sticker-placeholder">{error ? errorText || '表情包未缓存' : '表情包'}</div>
      {md5 && <div className="sticker-md5">MD5: {md5}</div>}
    </div>
  )
}

function QuoteBubble({
  data,
  sessionId,
  onImageClick
}: {
  data: Extract<ParsedContent, { type: 'quote' }>
  sessionId?: string
  onImageClick?: (imageUrl: string) => void
}): JSX.Element {
  const quotedText = data.quotedContent || data.content || '[引用消息]'
  const replyText = data.content || data.title || ''
  const quotedSender = data.quotedSender || data.sender || ''

  return (
    <div className="quote-message">
      <div className="quoted-message">
        {quotedSender && <span className="quoted-sender">{quotedSender}</span>}
        {data.quotedImageMd5 || data.quotedImageDatName ? (
          <ImageBubble
            imageMd5={data.quotedImageMd5}
            imageDatName={data.quotedImageDatName}
            sessionId={sessionId}
            isThumb
            onImageClick={onImageClick}
          />
        ) : (
          <span className="quoted-text">{renderWechatEmojiText(quotedText, 18)}</span>
        )}
      </div>
      {replyText && <div className="quote-reply">{renderWechatEmojiText(replyText)}</div>}
    </div>
  )
}

function SystemBubble({ data }: { data: Extract<ParsedContent, { type: 'system' }> }): JSX.Element {
  return <div className="message-text">{renderWechatEmojiText(data.content || '[系统消息]')}</div>
}

function getUrlHost(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
