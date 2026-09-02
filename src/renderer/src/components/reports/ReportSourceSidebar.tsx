import React, { useMemo, useState } from 'react'
import { Contact } from '../../../../shared/types'
import { AccountSummary } from '../account/AccountSummary'
import { Button, Input } from '../ui'

interface SelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

interface ReportSourceSidebarProps {
  contacts: Contact[]
  selectedContact: Contact | null
  selfInfo: SelfInfo | null
  dbReady: boolean
  dbConnecting?: boolean
  onSelectContact: (contact: Contact) => void
  onOpenSettings: () => void
}

export function ReportSourceSidebar({
  contacts,
  selectedContact,
  selfInfo,
  dbReady,
  dbConnecting = false,
  onSelectContact,
  onOpenSettings
}: ReportSourceSidebarProps): React.ReactElement {
  const [keyword, setKeyword] = useState('')
  const groups = useMemo(() => {
    const lower = keyword.trim().toLowerCase()
    return contacts
      .filter((contact) => contact.type === 'group')
      .filter((contact) => {
        if (!lower) return true
        return (
          contact.m_nsNickName.toLowerCase().includes(lower) ||
          contact.m_nsUsrName.toLowerCase().includes(lower)
        )
      })
  }, [contacts, keyword])

  return (
    <aside className="report-source-sidebar">
      <div className="report-source-header">
        <div>
          <h2>日报来源</h2>
          <p>选择需要生成日报的群聊</p>
        </div>
        <span>{groups.length} 个群聊</span>
      </div>
      <label className="report-source-search">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="10.5" cy="10.5" r="5.5" />
          <path d="m15 15 4 4" />
        </svg>
        <Input
          className="pl-9"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索群聊"
        />
      </label>
      <div className="report-source-list">
        {groups.length ? (
          groups.map((contact) => {
            const selected = selectedContact?.md5 === contact.md5
            const nickname = contact.m_nsNickName.trim()
            const displayName = nickname || contact.m_nsUsrName || '未命名群聊'
            return (
              <Button
                key={contact.md5}
                variant="ghost"
                className={`report-source-item ${selected ? 'active' : ''}`}
                onClick={() => onSelectContact(contact)}
                title={contact.m_nsUsrName}
              >
                <span className="report-source-avatar">
                  {contact.avatar ? (
                    <img src={contact.avatar} alt={displayName} referrerPolicy="no-referrer" />
                  ) : (
                    displayName.charAt(0)
                  )}
                </span>
                <span className="report-source-text">
                  <span>{displayName}</span>
                </span>
              </Button>
            )
          })
        ) : (
          <div className="report-source-empty">没有匹配的群聊</div>
        )}
      </div>
      <div className="report-source-account">
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
