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
  onRefresh: (filterKeyword: string) => Promise<void>
}

type SectionName = 'groups' | 'folded' | 'officialAccounts' | 'contacts'
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
  onOpenSettings,
  onRefresh
}: ConversationSidebarProps): React.ReactElement {
  const [searchTerm, setSearchTerm] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [expandedSections, setExpandedSections] = useState<Record<SectionName, boolean>>({
    groups: true,
    folded: false,
    officialAccounts: false,
    contacts: false
  })
  const listRef = useRef<HTMLDivElement>(null)

  const groups = contacts.filter((contact) => contact.type === 'group' && !contact.isFolded)
  const foldedGroups = contacts.filter((contact) => contact.type === 'group' && contact.isFolded)
  const officialAccounts = contacts.filter(
    (contact) =>
      contact.type === 'user' &&
      (contact.isOfficialAccount || contact.m_nsUsrName.startsWith('gh_'))
  )
  const users = contacts.filter(
    (contact) =>
      contact.type === 'user' &&
      !contact.isOfficialAccount &&
      !contact.m_nsUsrName.startsWith('gh_')
  )
  const rows = useMemo<ConversationRow[]>(
    () => [
      {
        kind: 'header',
        id: 'groups-header',
        title: '群聊',
        count: groups.length,
        section: 'groups'
      },
      ...(expandedSections.groups
        ? groups.map((contact) => ({
            kind: 'contact' as const,
            id: `group-${contact.md5}`,
            contact
          }))
        : []),
      ...(foldedGroups.length
        ? [
            {
              kind: 'header' as const,
              id: 'folded-header',
              title: '折叠群聊',
              count: foldedGroups.length,
              section: 'folded' as const
            },
            ...(expandedSections.folded
              ? foldedGroups.map((contact) => ({
                  kind: 'contact' as const,
                  id: `folded-${contact.md5}`,
                  contact
                }))
              : [])
          ]
        : []),
      ...(officialAccounts.length
        ? [
            {
              kind: 'header' as const,
              id: 'official-accounts-header',
              title: '公众号',
              count: officialAccounts.length,
              section: 'officialAccounts' as const
            },
            ...(expandedSections.officialAccounts
              ? officialAccounts.map((contact) => ({
                  kind: 'contact' as const,
                  id: `official-${contact.md5}`,
                  contact
                }))
              : [])
          ]
        : []),
      {
        kind: 'header',
        id: 'contacts-header',
        title: '联系人',
        count: users.length,
        section: 'contacts'
      },
      ...(expandedSections.contacts
        ? users.map((contact) => ({ kind: 'contact' as const, id: `user-${contact.md5}`, contact }))
        : [])
    ],
    [
      expandedSections.contacts,
      expandedSections.folded,
      expandedSections.groups,
      expandedSections.officialAccounts,
      foldedGroups,
      groups,
      officialAccounts,
      users
    ]
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

  const handleRefresh = async (): Promise<void> => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      await onRefresh(searchTerm)
    } finally {
      setIsRefreshing(false)
    }
  }

  return (
    <aside className="conversation-sidebar" style={{ width }}>
      <ConversationSidebarHeader
        totalCount={contacts.length}
        searchValue={searchTerm}
        onSearchChange={handleSearchChange}
        refreshing={isRefreshing}
        onRefresh={() => void handleRefresh()}
      />
      <div ref={listRef} className="conversation-list" aria-label="会话列表">
        <div
          className="conversation-virtual-content"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
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
                  style={{
                    transform: `translateY(${virtualItem.start}px)`,
                    height: `${virtualItem.size}px`
                  }}
                  onClick={() =>
                    setExpandedSections((current) => ({
                      ...current,
                      [row.section]: !current[row.section]
                    }))
                  }
                >
                  <span className="conversation-section-chevron" aria-hidden="true">
                    <svg viewBox="0 0 16 16" focusable="false">
                      <path d={expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
                    </svg>
                  </span>
                  <span className="conversation-section-title">
                    {row.title} ({row.count})
                  </span>
                </button>
              )
            }
            return (
              <div
                key={virtualItem.key}
                className="conversation-virtual-row"
                style={{
                  transform: `translateY(${virtualItem.start}px)`,
                  height: `${virtualItem.size}px`
                }}
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
