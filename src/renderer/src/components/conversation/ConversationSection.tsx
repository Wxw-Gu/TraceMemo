import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Contact } from '../../../../shared/types'
import { ConversationItem } from './ConversationItem'

interface ConversationSectionProps {
  title: string
  contacts: Contact[]
  expanded: boolean
  selectedContact: Contact | null
  emptyText: string
  onToggle: () => void
  onSelectContact: (contact: Contact) => void
}

function ChevronIcon({ expanded }: { expanded: boolean }): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
    </svg>
  )
}

export function ConversationSection({
  title,
  contacts,
  expanded,
  selectedContact,
  emptyText,
  onToggle,
  onSelectContact
}: ConversationSectionProps): React.ReactElement {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    const updateMargin = (): void => {
      const list = listRef.current
      const scrollElement = document.querySelector<HTMLDivElement>('.conversation-list')
      if (!list || !scrollElement) return
      setScrollMargin(list.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top)
    }
    updateMargin()
    window.addEventListener('resize', updateMargin)
    return () => window.removeEventListener('resize', updateMargin)
  }, [contacts.length, expanded])
  const virtualizer = useVirtualizer({
    count: expanded ? contacts.length : 0,
    getScrollElement: () => document.querySelector<HTMLDivElement>('.conversation-list'),
    scrollMargin,
    estimateSize: () => 58,
    overscan: 8
  })

  useEffect(() => {
    if (expanded) virtualizer.measure()
  }, [contacts.length, expanded, virtualizer])

  return (
    <section className="conversation-section">
      <button type="button" className="conversation-section-header" onClick={onToggle}>
        <span className="conversation-section-chevron">
          <ChevronIcon expanded={expanded} />
        </span>
        <span className="conversation-section-title">
          {title}（{contacts.length}）
        </span>
      </button>
      {expanded && (
        <div ref={listRef} className="conversation-section-list">
          {contacts.length > 0 ? (
            <div
              className="conversation-section-virtual-content"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const contact = contacts[virtualItem.index]
                return (
                  <div
                    key={virtualItem.key}
                    className="conversation-section-virtual-row"
                    style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
                  >
                    <ConversationItem
                      contact={contact}
                      active={selectedContact?.md5 === contact.md5}
                      onSelect={onSelectContact}
                    />
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="conversation-section-empty">{emptyText}</div>
          )}
        </div>
      )}
    </section>
  )
}
