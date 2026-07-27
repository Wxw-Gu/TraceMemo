import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Message, Contact } from '../../../shared/types'
import { ChatHeader } from './chat/ChatHeader'
import { ChatStatusBar } from './chat/ChatStatusBar'
import { DataTrustBar } from './chat/DataTrustBar'
import { EmptyConversationState } from './chat/EmptyConversationState'
import { MessageList } from './chat/MessageList'

interface ChatWindowProps {
  contact: Contact | null
  messages: Message[]
  isLoadingMessages?: boolean
  contentFilter?: string
  onContentFilterChange?: (keyword: string) => void
  onRefresh?: () => void
  onRefreshData?: () => void
  onReloadAvatars?: () => Promise<void>
  onLoadOlderMessages?: () => Promise<void>
  onCreateGroupReport?: () => void
  isAiLoading?: boolean
}

const ChatWindow: React.FC<ChatWindowProps> = ({
  contact,
  messages,
  isLoadingMessages,
  contentFilter,
  onContentFilterChange,
  onRefresh,
  onRefreshData,
  onReloadAvatars,
  onLoadOlderMessages,
  onCreateGroupReport,
  isAiLoading = false
}) => {
  const isGroupChat = Boolean(
    contact?.type === 'group' || contact?.m_nsUsrName?.endsWith('@chatroom')
  )
  const messageListRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [imageScale, setImageScale] = useState(0.75)
  const [imageRotation, setImageRotation] = useState(0)
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 })
  const imageViewerStageRef = useRef<HTMLDivElement>(null)
  const imageDragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(
    null
  )
  const [showAvatar, setShowAvatar] = useState(true)
  const [isAtLatest, setIsAtLatest] = useState(true)
  const [isReloadingAvatars, setIsReloadingAvatars] = useState(false)
  const previousScrollTopRef = useRef(0)

  const scrollToBottom = useCallback((): void => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
    setIsAtLatest(true)
  }, [])

  const handleMessageListScroll = useCallback((event: React.UIEvent<HTMLDivElement>): void => {
    const target = event.currentTarget
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    if (distanceToBottom <= 24) {
      setIsAtLatest(true)
    } else if (target.scrollTop < previousScrollTopRef.current - 1) {
      setIsAtLatest(false)
    }
    previousScrollTopRef.current = target.scrollTop
  }, [])

  useEffect(() => {
    previousScrollTopRef.current = 0
    setIsAtLatest(true)
  }, [contact?.md5])

  useEffect(() => {
    if (!isAtLatest) return
    const frame = window.requestAnimationFrame(() => scrollToBottom())
    return () => window.cancelAnimationFrame(frame)
  }, [isAtLatest, messages, scrollToBottom])

  useEffect(() => {
    if (!isAtLatest) return
    const content = messageListRef.current?.querySelector('.virtual-message-list')
    if (!content) return
    const observer = new ResizeObserver(() => scrollToBottom())
    observer.observe(content)
    return () => observer.disconnect()
  }, [contact?.md5, isAtLatest, scrollToBottom])

  const openImagePreview = (imageUrl: string): void => {
    setPreviewImage(imageUrl)
    setImageScale(1)
    setImageRotation(0)
    setImageOffset({ x: 0, y: 0 })
  }

  const closeImagePreview = (): void => {
    setPreviewImage(null)
    imageDragRef.current = null
  }

  const zoomImage = (delta: number): void => {
    setImageScale((prev) => Math.min(8, Math.max(0.1, Number((prev + delta).toFixed(2)))))
  }

  const resetImageTransform = (): void => {
    setImageScale(1)
    setImageRotation(0)
    setImageOffset({ x: 0, y: 0 })
  }

  const handleViewerWheel = (event: React.WheelEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    zoomImage(event.deltaY > 0 ? -0.1 : 0.1)
  }

  const handleViewerMouseDown = (event: React.MouseEvent): void => {
    event.preventDefault()
    imageDragRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: imageOffset.x,
      offsetY: imageOffset.y
    }
  }

  const handleViewerMouseMove = (event: React.MouseEvent): void => {
    if (!imageDragRef.current) return
    const drag = imageDragRef.current
    setImageOffset({
      x: drag.offsetX + event.clientX - drag.x,
      y: drag.offsetY + event.clientY - drag.y
    })
  }

  const handleViewerMouseUp = (): void => {
    imageDragRef.current = null
  }

  const handleReloadAvatars = async (): Promise<void> => {
    if (!onReloadAvatars || isReloadingAvatars) return
    setIsReloadingAvatars(true)
    try {
      await onReloadAvatars()
    } finally {
      setIsReloadingAvatars(false)
    }
  }

  useEffect(() => {
    if (!previewImage) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const stage = imageViewerStageRef.current
    const preventBackgroundWheel = (event: WheelEvent): void => {
      event.preventDefault()
    }
    stage?.addEventListener('wheel', preventBackgroundWheel, { passive: false })

    return () => {
      document.body.style.overflow = previousOverflow
      stage?.removeEventListener('wheel', preventBackgroundWheel)
    }
  }, [previewImage])

  const filteredMessages = React.useMemo(() => {
    return messages.filter((msg) => {
      const filterTypes = (import.meta.env.VITE_FILTER_MSG_TYPES || '')
        .split(',')
        .map((type) => type.trim())
        .filter(Boolean)
      const typeMatch = !filterTypes.includes(msg.type)
      const contentMatch = !contentFilter || msg.content.includes(contentFilter)
      return typeMatch && contentMatch
    })
  }, [messages, contentFilter])
  if (!contact) return <EmptyConversationState />

  return (
    <div className="chat-window">
      <ChatHeader
        contact={contact}
        isGroupChat={isGroupChat}
        loadedCount={messages.length}
        filteredCount={filteredMessages.length}
        contentFilter={contentFilter || ''}
        isAiLoading={isAiLoading}
        onContentFilterChange={onContentFilterChange || (() => undefined)}
        onRefresh={onRefresh}
        onRefreshData={onRefreshData}
        onOpenAiSettings={onCreateGroupReport || (() => undefined)}
      />
      <DataTrustBar messageCount={messages.length} />
      <MessageList
        contact={contact}
        messages={filteredMessages}
        hiddenMessageCount={0}
        isLoadingMessages={isLoadingMessages}
        isGroupChat={isGroupChat}
        showAvatar={showAvatar}
        listRef={messageListRef}
        bottomRef={messagesEndRef}
        onScroll={handleMessageListScroll}
        onReachTop={onLoadOlderMessages}
        onImageClick={openImagePreview}
      />
      <ChatStatusBar
        count={filteredMessages.length}
        showAvatar={showAvatar}
        isAtLatest={isAtLatest}
        isReloadingAvatars={isReloadingAvatars}
        onShowAvatarChange={setShowAvatar}
        onReloadAvatars={() => void handleReloadAvatars()}
        onJumpToLatest={scrollToBottom}
      />

      {previewImage && (
        <div className="image-viewer-overlay" onClick={closeImagePreview}>
          <div className="image-viewer-window" onClick={(e) => e.stopPropagation()}>
            <div className="image-viewer-titlebar">
              <div className="image-viewer-tools">
                <span className="image-viewer-title">图片查看</span>
                <button onClick={() => zoomImage(-0.1)} title="缩小">
                  −
                </button>
                <span className="image-viewer-zoom">{Math.round(imageScale * 100)}%</span>
                <button onClick={() => zoomImage(0.1)} title="放大">
                  +
                </button>
                <span className="image-viewer-divider" />
                <button onClick={() => setImageRotation((prev) => prev - 90)} title="左旋转">
                  ↶
                </button>
                <button onClick={() => setImageRotation((prev) => prev + 90)} title="右旋转">
                  ↷
                </button>
                <button onClick={resetImageTransform} title="重置">
                  ⟲
                </button>
              </div>
              <button className="image-viewer-close" onClick={closeImagePreview} aria-label="关闭">
                ×
              </button>
            </div>
            <div
              ref={imageViewerStageRef}
              className="image-viewer-stage"
              onWheel={handleViewerWheel}
              onMouseDown={handleViewerMouseDown}
              onMouseMove={handleViewerMouseMove}
              onMouseUp={handleViewerMouseUp}
              onMouseLeave={handleViewerMouseUp}
            >
              <img
                src={previewImage}
                alt="图片预览"
                draggable={false}
                style={{
                  transform: `translate(${imageOffset.x}px, ${imageOffset.y}px) scale(${imageScale}) rotate(${imageRotation}deg)`
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
export default ChatWindow
