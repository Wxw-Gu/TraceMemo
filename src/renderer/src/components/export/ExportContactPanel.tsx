import React from 'react'
import type { ExportContactType } from '../../../../shared/export'
import type { Contact, SelfInfo } from './exportTypes'
import { displayName } from './exportUtils'

interface ExportContactPanelProps {
  contacts: Contact[]
  filteredContacts: Contact[]
  activeContact: Contact | null
  selectedContactIds: string[]
  selectionMode: boolean
  exportAll: boolean
  allContactTypes: ExportContactType[]
  exportRunning: boolean
  selectionLimit: number
  selfInfo: SelfInfo | null
  dbReady: boolean
  contactFilter: string
  contactType: 'all' | 'group' | 'user'
  onContactFilterChange: (value: string) => void
  onContactTypeChange: (value: 'all' | 'group' | 'user') => void
  onSelectContact: (contact: Contact) => void
  onCompleteSelection: () => void
  onExportAll: () => void
  onToggleAllContactType: (type: ExportContactType) => void
  onOpenSettings: () => void
}

export function ExportContactPanel({
  contacts,
  filteredContacts,
  activeContact,
  selectedContactIds,
  selectionMode,
  exportAll,
  allContactTypes,
  exportRunning,
  selectionLimit,
  selfInfo,
  dbReady,
  contactFilter,
  contactType,
  onContactFilterChange,
  onContactTypeChange,
  onSelectContact,
  onCompleteSelection,
  onExportAll,
  onToggleAllContactType,
  onOpenSettings
}: ExportContactPanelProps): React.ReactElement {
  const groupCount = contacts.filter((contact) => contact.type === 'group').length
  const userCount = contacts.length - groupCount
  const selectedAllCount =
    (allContactTypes.includes('group') ? groupCount : 0) +
    (allContactTypes.includes('user') ? userCount : 0)

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
        <button
          type="button"
          className={`export-all-button ${exportAll ? 'active' : ''}`}
          aria-pressed={exportAll}
          onClick={onExportAll}
        >
          <span>
            <strong>全部导出</strong>
            <small>群聊和联系人按会话归档</small>
          </span>
          <b>{(exportAll ? selectedAllCount : contacts.length).toLocaleString()}</b>
        </button>
        {exportAll && (
          <div className="export-all-type-options" aria-label="全部导出范围">
            {(
              [
                ['group', '群聊'],
                ['user', '联系人']
              ] as const
            ).map(([type, label]) => {
              const count = type === 'group' ? groupCount : userCount
              return (
                <label key={type}>
                  <input
                    type="checkbox"
                    aria-label={`导出全部${label}`}
                    checked={allContactTypes.includes(type)}
                    disabled={
                      exportRunning || (allContactTypes.length === 1 && allContactTypes[0] === type)
                    }
                    onChange={() => onToggleAllContactType(type)}
                  />
                  <span>{label}</span>
                  <b>{count.toLocaleString()}</b>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {exportAll ? (
        <div className="export-all-status">
          已选择 {allContactTypes.includes('group') ? `全部群聊 ${groupCount} 个` : ''}
          {allContactTypes.length === 2 ? '和' : ''}
          {allContactTypes.includes('user') ? `全部联系人 ${userCount} 个` : ''}
          ；点击单个聊天可切换回指定导出
        </div>
      ) : selectionMode ? (
        <div className="export-multi-select-bar">
          <span>
            已选 {selectedContactIds.length} / {selectionLimit} 个
          </span>
          <button type="button" onClick={onCompleteSelection}>
            完成
          </button>
        </div>
      ) : null}

      <div className="export-contact-list">
        {filteredContacts.map((contact) => {
          const name = displayName(contact)
          const selected = selectedContactIds.includes(contact.md5)
          const selectedByAll = exportAll && allContactTypes.includes(contact.type)
          const visuallySelected = exportAll ? selectedByAll : selected
          const atLimit =
            !exportAll && selectionMode && !selected && selectedContactIds.length >= selectionLimit
          return (
            <button
              key={contact.md5}
              type="button"
              className={`export-contact-item ${!exportAll && activeContact?.md5 === contact.md5 ? 'active' : ''} ${visuallySelected ? 'selected' : ''}`}
              onClick={() => onSelectContact(contact)}
              disabled={atLimit}
              aria-pressed={visuallySelected}
            >
              <span className="export-contact-avatar">
                {contact.avatar ? <img src={contact.avatar} alt="" /> : name.slice(0, 1)}
              </span>
              <span className="export-contact-copy">
                <strong>{name}</strong>
                <small>{contact.type === 'group' ? '群聊' : '联系人'}</small>
              </span>
              {!exportAll && selectionMode && (
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
