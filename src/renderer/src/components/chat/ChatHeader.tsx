import React, { useState } from 'react'
import { Contact } from '../../../../shared/types'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '../ui'
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
    <div className={`chat-archive-header${searchOpen ? ' is-searching' : ''}`}>
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
          <IconButton
            label="搜索当前聊天"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => setSearchOpen(true)}
          >
            <SearchIcon />
          </IconButton>
        )}
        <IconButton label="刷新聊天记录" variant="ghost" className="h-8 w-8" onClick={onRefresh}>
          <RefreshIcon />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="更多" tooltip="" variant="ghost" className="h-8 w-8">
              <MoreIcon />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onRefreshData?.()}>刷新数据</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {supportsPersonalWechatSend ? (
          <Button
            variant="outline"
            size="sm"
            className="chat-header-text-action"
            aria-label="发送消息"
            onClick={onTestSend}
          >
            <SendIcon />
            <span>发送消息</span>
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} aria-label="仅支持 macOS">
                <Button
                  variant="outline"
                  size="sm"
                  className="chat-header-text-action"
                  aria-label="发送消息"
                  onClick={onTestSend}
                  disabled
                >
                  <SendIcon />
                  <span>发送消息</span>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>仅支持 macOS</TooltipContent>
          </Tooltip>
        )}
        <Button
          variant="default"
          size="sm"
          className="chat-header-text-action"
          aria-label={isAiLoading ? '生成中' : '生成 AI 日报'}
          onClick={onOpenAiSettings}
          disabled={isAiLoading}
          aria-busy={isAiLoading}
          title={isGroupChat ? '生成 AI 日报' : 'AI 日报当前仅支持群聊'}
        >
          <AiIcon />
          <span>{isAiLoading ? '生成中' : '生成 AI 日报'}</span>
        </Button>
      </div>
    </div>
  )
}
