import React from 'react'
import { IconButton, Input } from '../ui'
import { CloseIcon, SearchIcon } from './icons'

interface ConversationContentSearchProps {
  value: string
  resultCount: number
  onChange: (value: string) => void
  onClose: () => void
}

export function ConversationContentSearch({
  value,
  resultCount,
  onChange,
  onClose
}: ConversationContentSearchProps): React.ReactElement {
  return (
    <div className="chat-content-search">
      <span className="chat-content-search-icon pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2">
        <SearchIcon />
      </span>
      <Input
        type="text"
        value={value}
        aria-label="搜索当前聊天内容"
        placeholder="搜索当前聊天内容"
        onChange={(event) => onChange(event.target.value)}
        className="h-9 pr-10 pl-9 text-xs min-[901px]:pr-[7.5rem]"
        autoFocus
      />
      <span className="chat-content-search-count absolute right-10 top-1/2 -translate-y-1/2">
        {value ? `${resultCount} 条结果` : '输入关键词'}
      </span>
      <IconButton
        label="关闭搜索"
        variant="ghost"
        tooltip="关闭搜索"
        className="absolute right-1 top-1 h-7 w-7"
        onClick={onClose}
      >
        <CloseIcon />
      </IconButton>
    </div>
  )
}
