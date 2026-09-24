import * as React from 'react'
import { Input, RadioGroup, RadioGroupItem } from '../../components/ui'

/**
 * LeaveNotificationTargetPicker —— 「指定好友」展开后的联系人选择器。
 *
 * **单选**：通知只能发给一个联系人，所以这里是 radio 而不是 checkbox ——
 * 多选联系人不在范围内，也不该顺手加。
 *
 * 联系人清单由 main 侧提供（`listSendableContacts`），**已经过滤掉**
 * 群聊 / 公众号 / 文件传输助手 / 自己。这里不再二次筛选，避免两处规则漂移。
 */

export interface LeaveNotificationContactOption {
  /** 稳定 id（wxid）。保存与发送都用它，**不用显示名**。 */
  id: string
  name: string
}

export interface LeaveNotificationTargetPickerProps {
  contacts: LeaveNotificationContactOption[]
  selectedId: string
  onSelect: (id: string) => void
  searchPlaceholder: string
  emptyText: string
  ariaLabel: string
}

export function LeaveNotificationTargetPicker({
  contacts,
  selectedId,
  onSelect,
  searchPlaceholder,
  emptyText,
  ariaLabel
}: LeaveNotificationTargetPickerProps): React.ReactElement {
  const [filter, setFilter] = React.useState('')

  const visibleContacts = React.useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return contacts
    return contacts.filter(
      (contact) =>
        contact.name.toLowerCase().includes(needle) || contact.id.toLowerCase().includes(needle)
    )
  }, [contacts, filter])

  return (
    <RadioGroup
      value={selectedId}
      onValueChange={onSelect}
      aria-label={ariaLabel}
      className="automation-leave-contact-picker"
    >
      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
      />
      <div className="automation-leave-contact-list">
        {visibleContacts.length === 0 ? (
          <p className="automation-group-empty">{emptyText}</p>
        ) : (
          visibleContacts.map((contact) => (
            <div key={contact.id} className="automation-leave-radio option">
              <RadioGroupItem value={contact.id} id={`leave-contact-${contact.id}`} />
              <label htmlFor={`leave-contact-${contact.id}`}>{contact.name}</label>
            </div>
          ))
        )}
      </div>
    </RadioGroup>
  )
}
