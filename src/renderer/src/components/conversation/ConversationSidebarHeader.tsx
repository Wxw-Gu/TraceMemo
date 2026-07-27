import React from 'react'
import { ConversationSearch } from './ConversationSearch'

interface ConversationSidebarHeaderProps {
  totalCount: number
  searchValue: string
  onSearchChange: (value: string) => void
}

export function ConversationSidebarHeader({
  totalCount,
  searchValue,
  onSearchChange
}: ConversationSidebarHeaderProps): React.ReactElement {
  return (
    <div className="conversation-sidebar-header">
      <div className="conversation-sidebar-title-row">
        <h2>聊天档案</h2>
        <span>{totalCount} 个会话</span>
      </div>
      <ConversationSearch value={searchValue} onChange={onSearchChange} />
    </div>
  )
}
