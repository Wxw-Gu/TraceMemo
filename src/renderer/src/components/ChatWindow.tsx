import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Message, Contact } from '../../../shared/types'
import { ChatHeader } from './chat/ChatHeader'
import { ChatImageViewer } from './chat/ChatImageViewer'
import { ChatStatusBar } from './chat/ChatStatusBar'
import { DataTrustBar } from './chat/DataTrustBar'
import { EmptyConversationState } from './chat/EmptyConversationState'
import { MessageList } from './chat/MessageList'
import { PersonalWechatSendDialog } from './chat/PersonalWechatSendDialog'

interface ChatWindowProps {
  contact: Contact | null
  messages: Message[]
  isLoadingMessages?: boolean
  messageHistoryStatus?: 'idle' | 'end' | 'error'
  contentFilter?: string
  onContentFilterChange?: (keyword: string) => void
  onRefresh?: () => void
  onRefreshData?: () => void
  onReloadAvatars?: () => Promise<void>
  onLoadOlderMessages?: () => Promise<void>
  onCreateGroupReport?: () => void
  onOpenTextToSpeechSettings?: () => void
  isAiLoading?: boolean
  jumpToTime?: number | null
}

const ChatWindow: React.FC<ChatWindowProps> = ({
  contact,
  messages,
  isLoadingMessages,
  messageHistoryStatus,
  contentFilter,
  onContentFilterChange,
  onRefresh,
  onRefreshData,
  onReloadAvatars,
  onLoadOlderMessages,
  onCreateGroupReport,
  onOpenTextToSpeechSettings,
  isAiLoading = false,
  jumpToTime
}) => {
  const isGroupChat = Boolean(
    contact?.type === 'group' || contact?.m_nsUsrName?.endsWith('@chatroom')
  )
  const messageListRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [showAvatar, setShowAvatar] = useState(true)
  const [isAtLatest, setIsAtLatest] = useState(true)
  const [isReloadingAvatars, setIsReloadingAvatars] = useState(false)
  const [sendDialogOpen, setSendDialogOpen] = useState(false)
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
    if (jumpToTime !== undefined && jumpToTime !== null) setIsAtLatest(false)
  }, [jumpToTime])

  useEffect(() => {
    if (!isAtLatest || (jumpToTime !== undefined && jumpToTime !== null)) return
    const frame = window.requestAnimationFrame(() => scrollToBottom())
    return () => window.cancelAnimationFrame(frame)
  }, [isAtLatest, jumpToTime, messages, scrollToBottom])

  useEffect(() => {
    if (!isAtLatest || (jumpToTime !== undefined && jumpToTime !== null)) return
    const content = messageListRef.current?.querySelector('.virtual-message-list')
    if (!content) return
    const observer = new ResizeObserver(() => scrollToBottom())
    observer.observe(content)
    return () => observer.disconnect()
  }, [contact?.md5, isAtLatest, jumpToTime, scrollToBottom])

  const openImagePreview = (imageUrl: string): void => {
    setPreviewImage(imageUrl)
  }

  const closeImagePreview = (): void => {
    setPreviewImage(null)
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
        onTestSend={() => setSendDialogOpen(true)}
        onOpenAiSettings={onCreateGroupReport || (() => undefined)}
      />
      <DataTrustBar messageCount={messages.length} />
      <MessageList
        contact={contact}
        messages={filteredMessages}
        hiddenMessageCount={0}
        isLoadingMessages={isLoadingMessages}
        messageHistoryStatus={messageHistoryStatus}
        isGroupChat={isGroupChat}
        showAvatar={showAvatar}
        listRef={messageListRef}
        bottomRef={messagesEndRef}
        onScroll={handleMessageListScroll}
        onReachTop={onLoadOlderMessages}
        onImageClick={openImagePreview}
        jumpToTime={jumpToTime}
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

      {sendDialogOpen && (
        <PersonalWechatSendDialog
          contact={contact}
          isGroupChat={isGroupChat}
          onClose={() => setSendDialogOpen(false)}
          onOpenTextToSpeechSettings={onOpenTextToSpeechSettings}
        />
      )}

      {previewImage && <ChatImageViewer imageUrl={previewImage} onClose={closeImagePreview} />}
    </div>
  )
}
export default ChatWindow
