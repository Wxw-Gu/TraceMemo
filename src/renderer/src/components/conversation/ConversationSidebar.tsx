import React, { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Contact } from '../../../../shared/types'
import { AccountSummary } from '../account/AccountSummary'
import { ConversationItem } from './ConversationItem'
import { ConversationSidebarHeader } from './ConversationSidebarHeader'

interface SelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

export interface ConversationSidebarProps {
  contacts: Contact[]
  selectedContact: Contact | null
  onSelectContact: (contact: Contact) => void
  onSearch: (keyword: string) => void
  onContentFilter: (keyword: string) => void
  width: number
  selfInfo: SelfInfo | null
  dbReady: boolean
  dbConnecting?: boolean
  onOpenSettings: () => void
}

type SectionName = 'groups' | 'contacts'
type ConversationRow =
  | { kind: 'header'; id: string; title: string; count: number; section: SectionName }
  | { kind: 'contact'; id: string; contact: Contact }

export function ConversationSidebar({
  contacts,
  selectedContact,
  onSelectContact,
  onSearch,
  width,
  selfInfo,
  dbReady,
  dbConnecting = false,
  onOpenSettings
}: ConversationSidebarProps): React.ReactElement {
  const [searchTerm, setSearchTerm] = useState('')
  const [expandedSections, setExpandedSections] = useState<Record<SectionName, boolean>>({
    groups: true,
    contacts: false
  })
  const listRef = useRef<HTMLDivElement>(null)

  const groups = contacts.filter((contact) => contact.type === 'group')
  const users = contacts.filter((contact) => contact.type === 'user')
  const rows = useMemo<ConversationRow[]>(
    () => [
      { kind: 'header', id: 'groups-header', title: '群聊', count: groups.length, section: 'groups' },
      ...(expandedSections.groups
        ? groups.map((contact) => ({ kind: 'contact' as const, id: `group-${contact.md5}`, contact }))
        : []),
      { kind: 'header', id: 'contacts-header', title: '联系人', count: users.length, section: 'contacts' },
      ...(expandedSections.contacts
        ? users.map((contact) => ({ kind: 'contact' as const, id: `user-${contact.md5}`, contact }))
        : [])
    ],
    [expandedSections.contacts, expandedSections.groups, groups, users]
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'header' ? 38 : 58),
    getItemKey: (index) => rows[index]?.id || index,
    overscan: 10
  })

  const handleSearchChange = (term: string): void => {
    setSearchTerm(term)
    onSearch(term)
  }

  return (
    <aside className="conversation-sidebar" style={{ width }}>
      <ConversationSidebarHeader
        totalCount={contacts.length}
        searchValue={searchTerm}
        onSearchChange={handleSearchChange}
      />
      <div ref={listRef} className="conversation-list" aria-label="会话列表">
        <div className="conversation-virtual-content" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const row = rows[virtualItem.index]
            if (!row) return null
            if (row.kind === 'header') {
              const expanded = expandedSections[row.section]
              return (
                <button
                  key={virtualItem.key}
                  type="button"
                  className="conversation-section-header conversation-virtual-row"
                  style={{ transform: `translateY(${virtualItem.start}px)`, height: `${virtualItem.size}px` }}
                  onClick={() =>
                    setExpandedSections((current) => ({ ...current, [row.section]: !current[row.section] }))
                  }
                >
                  <span className="conversation-section-chevron" aria-hidden="true">
                    <svg viewBox="0 0 16 16" focusable="false">
                      <path d={expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
                    </svg>
                  </span>
                  <span className="conversation-section-title">{row.title} ({row.count})</span>
                </button>
              )
            }
            return (
              <div
                key={virtualItem.key}
                className="conversation-virtual-row"
                style={{ transform: `translateY(${virtualItem.start}px)`, height: `${virtualItem.size}px` }}
              >
                <ConversationItem
                  contact={row.contact}
                  active={selectedContact?.md5 === row.contact.md5}
                  onSelect={onSelectContact}
                />
              </div>
            )
          })}
        </div>
      </div>
      <div className="conversation-sidebar-account">
        <AccountSummary
          selfInfo={selfInfo}
          dbReady={dbReady}
          dbConnecting={dbConnecting}
          onClick={onOpenSettings}
        />
      </div>
    </aside>
  )
}
