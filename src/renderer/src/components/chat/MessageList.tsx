import React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Contact, Message } from '../../../../shared/types'
import { MessageGroup } from './MessageGroup'
import { buildMessageGroups } from './messageGrouping'
import { resolveMessageJumpTarget } from './messageJump'

interface MessageListProps {
  contact: Contact
  messages: Message[]
  hiddenMessageCount: number
  isLoadingMessages?: boolean
  messageHistoryStatus?: 'idle' | 'end' | 'error'
  isGroupChat: boolean
  showAvatar: boolean
  listRef: React.RefObject<HTMLDivElement | null>
  bottomRef: React.RefObject<HTMLDivElement | null>
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void
  onReachTop?: () => Promise<void>
  onImageClick: (imageUrl: string) => void
  jumpToTime?: number | null
  /**
   * 精确跳转目标（规范化消息 id，即去掉 `local:` 前缀后的 WCDB 本地 id）。
   *
   * 优先于 `jumpToTime`：时间只能找到"附近的第一条"，秒级时间戳在群聊里经常
   * 对应多条消息，于是会定位并高亮错一条。有 id 时必须按 id 找。
   */
  jumpToMessageId?: string | null
}

export function MessageList({
  contact,
  messages,
  hiddenMessageCount,
  isLoadingMessages,
  messageHistoryStatus,
  isGroupChat,
  showAvatar,
  listRef,
  bottomRef,
  onScroll,
  onReachTop,
  onImageClick,
  jumpToTime,
  jumpToMessageId
}: MessageListProps): React.ReactElement {
  const groups = React.useMemo(() => buildMessageGroups(messages), [messages])
  const groupsRef = React.useRef(groups)
  const loadingOlderRef = React.useRef(false)
  groupsRef.current = groups
  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 96,
    getItemKey: (index) => groups[index]?.id || index,
    overscan: 8
  })
  const virtualItems = virtualizer.getVirtualItems()
  const jumpTarget = React.useMemo(
    () => resolveMessageJumpTarget(groups, jumpToTime, jumpToMessageId),
    [groups, jumpToTime, jumpToMessageId]
  )

  React.useEffect(() => {
    if (!jumpTarget) return
    const frame = window.requestAnimationFrame(() => {
      virtualizer.scrollToIndex(jumpTarget.groupIndex, { align: 'center' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [jumpTarget, virtualizer])

  const handleScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    onScroll(event)
    const scrollElement = event.currentTarget
    if (
      (jumpToTime !== undefined && jumpToTime !== null) ||
      (jumpToMessageId !== undefined && jumpToMessageId !== null) ||
      scrollElement.scrollTop >= 48 ||
      loadingOlderRef.current ||
      isLoadingMessages ||
      !onReachTop
    ) {
      return
    }

    loadingOlderRef.current = true
    const previousGroupCount = groups.length
    const previousScrollTop = scrollElement.scrollTop
    const previousScrollHeight = scrollElement.scrollHeight
    const anchorMessageId = groups[0]?.messages[0]?.id
    void (async () => {
      try {
        await onReachTop()
        for (let frame = 0; frame < 8; frame += 1) {
          if (groupsRef.current.length > previousGroupCount) break
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
        }
        if (!anchorMessageId) return
        const anchorIndex = groupsRef.current.findIndex((group) =>
          group.messages.some((message) => message.id === anchorMessageId)
        )
        if (anchorIndex <= 0) return
        virtualizer.measure()
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
        const addedHeight = scrollElement.scrollHeight - previousScrollHeight
        if (addedHeight > 0) {
          scrollElement.scrollTop = previousScrollTop + addedHeight
        } else {
          virtualizer.scrollToIndex(anchorIndex, { align: 'start' })
        }

        // Variable-height groups can finish measuring one frame later. Preserve
        // the same message anchor after that final measurement as well.
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
        if (scrollElement.scrollTop < 48) {
          virtualizer.scrollToIndex(anchorIndex, { align: 'start' })
        }
      } finally {
        window.setTimeout(() => {
          loadingOlderRef.current = false
        }, 250)
      }
    })()
  }

  return (
    <div className="message-list wechat-message-list" ref={listRef} onScroll={handleScroll}>
      {isLoadingMessages && <div className="message-loading-pill">正在加载聊天记录...</div>}
      {messageHistoryStatus === 'end' && (
        <div className="wechat-system-message-row">
          <div className="wechat-system-message">已显示本地数据库中的最早记录</div>
        </div>
      )}
      {messageHistoryStatus === 'error' && (
        <div className="wechat-system-message-row">
          <div className="wechat-system-message">
            无法读取更早记录，请检查数据目录或当前微信数据版本
          </div>
        </div>
      )}
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
              className={`virtual-message-group ${jumpTarget?.groupIndex === virtualItem.index ? 'archive-jump-target-group' : ''}`}
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              <MessageGroup
                group={group}
                contact={contact}
                isGroupChat={isGroupChat}
                showAvatar={showAvatar}
                onImageClick={onImageClick}
                jumpTargetMessageId={jumpTarget?.messageId}
              />
            </div>
          )
        })}
      </div>
      <div ref={bottomRef} />
    </div>
  )
}
