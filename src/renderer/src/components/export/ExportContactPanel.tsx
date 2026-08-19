import React from 'react'
import type { ExportContactType } from '../../../../shared/export'
import { Button, Checkbox, Input, Tabs, TabsList, TabsTrigger } from '../ui'
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
    <aside className="flex min-h-0 min-w-0 flex-col border-r border-border bg-sidebar">
      <div className="border-b border-border px-4 pb-3 pt-5">
        <div className="mb-3.5 flex items-center justify-between gap-2">
          <h2 className="text-[17px] font-bold tracking-normal text-foreground">选择聊天</h2>
          <span className="whitespace-nowrap rounded-md bg-surface px-2 py-1 text-[11px] text-muted-foreground">
            共 {contacts.length.toLocaleString()} 个
          </span>
        </div>
        <label className="relative block">
          <span
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          >
            ⌕
          </span>
          <Input
            className="h-[38px] pl-9 text-[13px]"
            value={contactFilter}
            onChange={(event) => onContactFilterChange(event.target.value)}
            placeholder="搜索群聊、联系人或 wxid"
            aria-label="搜索聊天"
          />
        </label>
        <Tabs
          className="mt-3"
          value={contactType}
          onValueChange={(value) => onContactTypeChange(value as 'all' | 'group' | 'user')}
        >
          <TabsList className="grid w-full grid-cols-3 bg-muted">
            {(
              [
                ['all', '全部'],
                ['group', '群聊'],
                ['user', '联系人']
              ] as const
            ).map(([value, label]) => (
              <TabsTrigger
                key={value}
                className="w-full data-[state=active]:text-primary"
                value={value}
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Button
          variant="outline"
          className={`mt-2.5 h-auto w-full justify-between gap-3 px-2.5 py-2 text-left ${
            exportAll ? 'border-primary bg-primary/10 text-primary hover:bg-primary/15' : ''
          }`}
          aria-pressed={exportAll}
          onClick={onExportAll}
        >
          <span className="grid min-w-0 gap-0.5">
            <strong className="text-xs">全部导出</strong>
            <small className="text-[10px] font-normal text-muted-foreground">
              群聊和联系人按会话归档
            </small>
          </span>
          <b className="text-[11px] text-muted-foreground">
            {(exportAll ? selectedAllCount : contacts.length).toLocaleString()}
          </b>
        </Button>
        {exportAll && (
          <div className="mt-2 grid grid-cols-2 gap-2" aria-label="全部导出范围">
            {(
              [
                ['group', '群聊'],
                ['user', '联系人']
              ] as const
            ).map(([type, label]) => {
              const count = type === 'group' ? groupCount : userCount
              const checked = allContactTypes.includes(type)
              return (
                <label
                  className="grid min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-2 text-[11px] text-muted-foreground"
                  key={type}
                >
                  <Checkbox
                    aria-label={`导出全部${label}`}
                    checked={checked}
                    disabled={
                      exportRunning || (allContactTypes.length === 1 && allContactTypes[0] === type)
                    }
                    onCheckedChange={() => onToggleAllContactType(type)}
                  />
                  <span>{label}</span>
                  <b className="text-[10px] text-muted-foreground">{count.toLocaleString()}</b>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {exportAll ? (
        <div className="border-b border-border bg-primary/10 px-4 py-2 text-[11px] leading-[17px] text-primary">
          已选择 {allContactTypes.includes('group') ? `全部群聊 ${groupCount} 个` : ''}
          {allContactTypes.length === 2 ? '和' : ''}
          {allContactTypes.includes('user') ? `全部联系人 ${userCount} 个` : ''}
          ；点击单个聊天可切换回指定导出
        </div>
      ) : selectionMode ? (
        <div className="flex items-center justify-between border-b border-border bg-primary/10 px-4 py-2 text-xs text-primary">
          <span>
            已选 {selectedContactIds.length} / {selectionLimit} 个
          </span>
          <Button className="h-auto p-0 text-xs" variant="link" onClick={onCompleteSelection}>
            完成
          </Button>
        </div>
      ) : null}

      <div className="export-contact-list min-h-0 flex-1 overflow-auto py-2">
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
              className={`flex w-full items-center gap-2.5 border-0 border-l-[3px] px-4 py-[11px] text-left text-foreground transition-colors hover:bg-surface/60 disabled:cursor-not-allowed disabled:opacity-50 ${
                !exportAll && activeContact?.md5 === contact.md5
                  ? 'border-l-primary bg-primary/10'
                  : 'border-l-transparent bg-transparent'
              }`}
              onClick={() => onSelectContact(contact)}
              disabled={atLimit}
              aria-pressed={visuallySelected}
            >
              <span className="grid h-[38px] w-[38px] shrink-0 place-items-center overflow-hidden rounded-lg bg-primary/10 font-bold text-primary">
                {contact.avatar ? (
                  <img className="h-full w-full object-cover" src={contact.avatar} alt="" />
                ) : (
                  name.slice(0, 1)
                )}
              </span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">
                  {name}
                </strong>
                <small className="text-[11px] text-muted-foreground">
                  {contact.type === 'group' ? '群聊' : '联系人'}
                </small>
              </span>
              {!exportAll && selectionMode && (
                <span
                  className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded border text-xs text-primary-foreground ${
                    selected ? 'border-primary bg-primary' : 'border-border-strong'
                  }`}
                  aria-hidden
                >
                  {selected ? '✓' : ''}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <Button
        type="button"
        variant="ghost"
        className="h-auto justify-start gap-2 border-t border-border px-4 py-3.5 text-left"
        onClick={onOpenSettings}
      >
        <span className="grid h-[34px] w-[34px] shrink-0 place-items-center overflow-hidden rounded-full bg-primary/10 font-bold text-primary">
          {selfInfo?.avatar ? (
            <img className="h-full w-full object-cover" src={selfInfo.avatar} alt="" />
          ) : (
            (selfInfo?.nickname || '我').slice(0, 1)
          )}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-foreground">
            {selfInfo?.nickname || '当前账号'}
          </strong>
          <small className={`text-[11px] ${dbReady ? 'text-success' : 'text-muted-foreground'}`}>
            {dbReady ? '数据库已连接' : '数据库未连接'}
          </small>
        </span>
      </Button>
    </aside>
  )
}
