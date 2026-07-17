import React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Contact, Message } from '../../../../shared/types'
import { MessageGroup } from './MessageGroup'
import { buildMessageGroups } from './messageGrouping'

interface MessageListProps {
  contact: Contact
  messages: Message[]
  hiddenMessageCount: number
  isLoadingMessages?: boolean
  isGroupChat: boolean
  showAvatar: boolean
  listRef: React.RefObject<HTMLDivElement | null>
  bottomRef: React.RefObject<HTMLDivElement | null>
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void
  onImageClick: (imageUrl: string) => void
}

export function MessageList({
  contact,
  messages,
  hiddenMessageCount,
  isLoadingMessages,
  isGroupChat,
  showAvatar,
  listRef,
  bottomRef,
  onScroll,
  onImageClick
}: MessageListProps): React.ReactElement {
  const groups = React.useMemo(() => buildMessageGroups(messages), [messages])
  // TanStack Virtual intentionally exposes mutable measurement methods.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 96,
    getItemKey: (index) => groups[index]?.id || index,
    overscan: 8
  })
  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="message-list wechat-message-list" ref={listRef} onScroll={onScroll}>
      {isLoadingMessages && <div className="message-loading-pill">正在加载聊天记录...</div>}
      {hiddenMessageCount > 0 && (
        <div className="wechat-system-message-row">
          <div className="wechat-system-message">
            已隐藏较早的 {hiddenMessageCount} 条消息，当前显示最新 {messages.length} 条
          </div>
        </div>
      )}
      <div className="virtual-message-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualItems.map((virtualItem) => {
          const group = groups[virtualItem.index]
          if (!group) return null
          return (
            <div
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              className="virtual-message-group"
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              <MessageGroup
                group={group}
                contact={contact}
                isGroupChat={isGroupChat}
                showAvatar={showAvatar}
                onImageClick={onImageClick}
              />
            </div>
          )
        })}
      </div>
      <div ref={bottomRef} />
    </div>
  )
}
