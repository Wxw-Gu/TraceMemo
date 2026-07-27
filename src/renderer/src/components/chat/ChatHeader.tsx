import React, { useEffect, useRef, useState } from 'react'
import { Contact } from '../../../../shared/types'
import { ConversationContentSearch } from './ConversationContentSearch'
import { AiIcon, MoreIcon, RefreshIcon, SearchIcon } from './icons'

interface ChatHeaderProps {
  contact: Contact
  isGroupChat: boolean
  loadedCount: number
  filteredCount: number
  contentFilter: string
  isAiLoading: boolean
  onContentFilterChange: (value: string) => void
  onRefresh?: () => void
  onRefreshData?: () => void
  onOpenAiSettings: () => void
}

export function ChatHeader({
  contact,
  isGroupChat,
  loadedCount,
  filteredCount,
  contentFilter,
  isAiLoading,
  onContentFilterChange,
  onRefresh,
  onRefreshData,
  onOpenAiSettings
}: ChatHeaderProps): React.ReactElement {
  const [searchOpen, setSearchOpen] = useState(Boolean(contentFilter))
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const displayName = contact.m_nsNickName || contact.m_nsUsrName || '未命名会话'
  const typeLabel = isGroupChat ? '群聊' : '联系人'
  const visibleCount = contentFilter ? filteredCount : loadedCount

  useEffect(() => {
    if (!moreOpen) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [moreOpen])

  const handleCloseSearch = (): void => {
    onContentFilterChange('')
    setSearchOpen(false)
  }

  return (
    <div className="chat-archive-header">
      <div className="chat-title-block">
        <div className="chat-title-avatar">
          {contact.avatar ? (
            <img src={contact.avatar} alt={displayName} referrerPolicy="no-referrer" />
          ) : (
            displayName.charAt(0)
          )}
        </div>
        <div className="chat-title-text">
          <h2>{displayName}</h2>
          <div className="chat-title-meta">
            <span>{typeLabel}</span>
            <span>{visibleCount} 条消息</span>
          </div>
        </div>
      </div>
      <div className="chat-header-actions">
        {searchOpen ? (
          <ConversationContentSearch
            value={contentFilter}
            resultCount={filteredCount}
            onChange={onContentFilterChange}
            onClose={handleCloseSearch}
          />
        ) : (
          <button
            type="button"
            className="chat-icon-button"
            onClick={() => setSearchOpen(true)}
            title="搜索当前聊天"
          >
            <SearchIcon />
          </button>
        )}
        <button type="button" className="chat-icon-button" onClick={onRefresh} title="刷新聊天记录">
          <RefreshIcon />
        </button>
        <div className="chat-menu" ref={moreRef}>
          <button
            type="button"
            className="chat-icon-button"
            onClick={() => setMoreOpen((current) => !current)}
            title="更多"
          >
            <MoreIcon />
          </button>
          {moreOpen && (
            <div className="chat-dropdown-menu right">
              <button
                type="button"
                onClick={() => {
                  onRefreshData?.()
                  setMoreOpen(false)
                }}
              >
                刷新数据
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className="chat-ai-button"
          onClick={onOpenAiSettings}
          disabled={isAiLoading}
          title={isGroupChat ? '生成 AI 日报' : 'AI 日报当前仅支持群聊'}
        >
          <AiIcon />
          <span>{isAiLoading ? '生成中' : '生成 AI 日报'}</span>
        </button>
      </div>
    </div>
  )
}
