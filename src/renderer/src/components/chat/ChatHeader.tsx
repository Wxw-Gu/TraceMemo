import React, { useState } from 'react'
import { Contact } from '../../../../shared/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui'
import { ConversationContentSearch } from './ConversationContentSearch'
import { AiIcon, MoreIcon, RefreshIcon, SearchIcon, SendIcon } from './icons'
import { supportsPersonalWechatSend } from '../../utils/runtime-environment'

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
  onTestSend: () => void
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
  onTestSend,
  onOpenAiSettings
}: ChatHeaderProps): React.ReactElement {
  const [searchOpen, setSearchOpen] = useState(Boolean(contentFilter))
  const displayName = contact.m_nsNickName || contact.m_nsUsrName || '未命名会话'
  const typeLabel = isGroupChat ? '群聊' : '联系人'
  const visibleCount = contentFilter ? filteredCount : loadedCount

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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="chat-icon-button" title="更多">
              <MoreIcon />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onRefreshData?.()}>刷新数据</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span
          className="chat-tool-button-wrapper"
          title={supportsPersonalWechatSend ? '发送消息' : '仅支持 macOS'}
          aria-label={supportsPersonalWechatSend ? '发送消息' : '仅支持 macOS'}
          tabIndex={supportsPersonalWechatSend ? -1 : 0}
        >
          <button
            type="button"
            className="chat-tool-button"
            onClick={onTestSend}
            disabled={!supportsPersonalWechatSend}
          >
            <SendIcon />
            <span>发送消息</span>
          </button>
        </span>
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
