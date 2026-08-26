import React from 'react'
import { IconButton } from '../ui'
import { ConversationSearch } from './ConversationSearch'

interface ConversationSidebarHeaderProps {
  totalCount: number
  searchValue: string
  onSearchChange: (value: string) => void
  refreshing: boolean
  onRefresh: () => void
}

export function ConversationSidebarHeader({
  totalCount,
  searchValue,
  onSearchChange,
  refreshing,
  onRefresh
}: ConversationSidebarHeaderProps): React.ReactElement {
  return (
    <div className="conversation-sidebar-header">
      <div className="conversation-sidebar-title-row">
        <h2>聊天档案</h2>
        <div className="conversation-sidebar-meta">
          <span>{totalCount} 个会话</span>
          <IconButton
            variant="ghost"
            className={`conversation-refresh-button ${refreshing ? 'is-refreshing' : ''}`}
            label={refreshing ? '正在刷新会话列表' : '刷新会话列表'}
            title={refreshing ? '正在刷新…' : '刷新会话列表'}
            disabled={refreshing}
            onClick={onRefresh}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M16.1 6.2A7 7 0 1 0 17 12h-2a5 5 0 1 1-.7-3.4L12 11h6V5l-1.9 1.2Z" />
            </svg>
          </IconButton>
        </div>
      </div>
      <ConversationSearch value={searchValue} onChange={onSearchChange} />
    </div>
  )
}
