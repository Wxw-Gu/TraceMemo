import React from 'react'
import type { Contact, SelfInfo } from './exportTypes'
import { displayName } from './exportUtils'

interface ExportContactPanelProps {
  contacts: Contact[]
  filteredContacts: Contact[]
  activeContact: Contact | null
  selectedContactIds: string[]
  selectionMode: boolean
  selectionLimit: number
  selfInfo: SelfInfo | null
  dbReady: boolean
  contactFilter: string
  contactType: 'all' | 'group' | 'user'
  onContactFilterChange: (value: string) => void
  onContactTypeChange: (value: 'all' | 'group' | 'user') => void
  onSelectContact: (contact: Contact) => void
  onCompleteSelection: () => void
  onOpenSettings: () => void
}

export function ExportContactPanel({
  contacts,
  filteredContacts,
  activeContact,
  selectedContactIds,
  selectionMode,
  selectionLimit,
  selfInfo,
  dbReady,
  contactFilter,
  contactType,
  onContactFilterChange,
  onContactTypeChange,
  onSelectContact,
  onCompleteSelection,
  onOpenSettings
}: ExportContactPanelProps): React.ReactElement {
  return (
    <aside className="export-contact-panel">
      <div className="export-panel-header">
        <div className="export-panel-title-row">
          <h2>选择聊天</h2>
          <span className="export-count-badge">共 {contacts.length.toLocaleString()} 个</span>
        </div>
        <label className="export-search-field">
          <span aria-hidden>⌕</span>
          <input
            value={contactFilter}
            onChange={(event) => onContactFilterChange(event.target.value)}
            placeholder="搜索群聊、联系人或 wxid"
            aria-label="搜索聊天"
          />
        </label>
        <div className="export-filter-tabs" role="tablist" aria-label="聊天类型">
          {(
            [
              ['all', '全部'],
              ['group', '群聊'],
              ['user', '联系人']
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={contactType === value ? 'active' : ''}
              onClick={() => onContactTypeChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {selectionMode && (
        <div className="export-multi-select-bar">
          <span>
            已选 {selectedContactIds.length} / {selectionLimit} 个
          </span>
          <button type="button" onClick={onCompleteSelection}>
            完成
          </button>
        </div>
      )}

      <div className="export-contact-list">
        {filteredContacts.map((contact) => {
          const name = displayName(contact)
          const selected = selectedContactIds.includes(contact.md5)
          const atLimit = selectionMode && !selected && selectedContactIds.length >= selectionLimit
          return (
            <button
              key={contact.md5}
              type="button"
              className={`export-contact-item ${activeContact?.md5 === contact.md5 ? 'active' : ''} ${selected ? 'selected' : ''}`}
              onClick={() => onSelectContact(contact)}
              disabled={atLimit}
              aria-pressed={selected}
            >
              <span className="export-contact-avatar">
                {contact.avatar ? <img src={contact.avatar} alt="" /> : name.slice(0, 1)}
              </span>
              <span className="export-contact-copy">
                <strong>{name}</strong>
                <small>{contact.type === 'group' ? '群聊' : '联系人'}</small>
              </span>
              {selectionMode && (
                <span className={`export-contact-check ${selected ? 'checked' : ''}`} aria-hidden>
                  {selected ? '✓' : ''}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <button type="button" className="export-account-summary" onClick={onOpenSettings}>
        <span className="export-account-avatar">
          {selfInfo?.avatar ? (
            <img src={selfInfo.avatar} alt="" />
          ) : (
            (selfInfo?.nickname || '我').slice(0, 1)
          )}
        </span>
        <span>
          <strong>{selfInfo?.nickname || '当前账号'}</strong>
          <small className={dbReady ? 'ready' : ''}>
            {dbReady ? '数据库已连接' : '数据库未连接'}
          </small>
        </span>
      </button>
    </aside>
  )
}
