import * as React from 'react'
import type { ConversationMessageCountEntry } from '../../../../../shared/conversation-message-count'
import type { ConversationSelectOption } from '../ConversationMultiSelect'

interface ContactLike {
  md5: string
  m_nsNickName: string
  m_nsUsrName: string
  type: 'user' | 'group'
  remark?: string
  wechatNickname?: string
  wechatId?: string
  wxid?: string
  alias?: string
  isOfficialAccount?: boolean
}

function toOption(
  contact: ContactLike,
  count: ConversationMessageCountEntry | undefined,
  activity: Record<string, number>
): ConversationSelectOption {
  const keywords = [
    contact.remark,
    contact.wechatNickname,
    contact.wechatId,
    contact.wxid,
    contact.alias,
    contact.m_nsUsrName
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(' ')
  const lastActiveAt = activity[contact.md5]
  return {
    conversationId: contact.md5,
    name: contact.m_nsNickName || contact.remark || contact.wechatId || contact.m_nsUsrName,
    type: contact.type,
    messageCount: count?.count ?? null,
    approximate: count?.approximate ?? false,
    countMeasured: (count?.measuredAt ?? 0) > 0,
    lastActiveAt: typeof lastActiveAt === 'number' && lastActiveAt > 0 ? lastActiveAt : null,
    keywords
  }
}

/** 消息数只来自只读 COUNT(*)，绝不为排序读正文；未知保持 null。 */
export function useConversationOptions(enabled: boolean): {
  options: ConversationSelectOption[]
  loading: boolean
  failed: boolean
} {
  const [contacts, setContacts] = React.useState<ContactLike[]>([])
  const [counts, setCounts] = React.useState<Map<string, ConversationMessageCountEntry>>(
    () => new Map()
  )
  const [activity, setActivity] = React.useState<Record<string, number>>({})
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (!enabled) return
    let disposed = false
    setLoading(true)
    setFailed(false)

    // 旧 preload（渲染层先加载到新代码、桥还是旧的）不该让整个搜索页崩掉。
    const unsubscribe =
      window.api.onConversationMessageCounts?.((entries) => {
        if (disposed) return
        setCounts((current) => {
          const next = new Map(current)
          for (const entry of entries) next.set(entry.conversationId, entry)
          return next
        })
      }) ?? (() => undefined)

    void (async () => {
      try {
        const list = (await window.api.getContacts()) as ContactLike[]
        if (disposed) return
        // 公众号不是聊天会话，进索引只会制造噪音。
        const conversations = (Array.isArray(list) ? list : []).filter(
          (contact) => contact?.md5 && !contact.isOfficialAccount
        )
        setContacts(conversations)

        const ids = conversations.map((contact) => contact.md5)
        const snapshot = (await window.api.getConversationMessageCounts?.(ids)) ?? { entries: [] }
        if (disposed) return
        const seeded = new Map<string, ConversationMessageCountEntry>()
        for (const entry of snapshot.entries) seeded.set(entry.conversationId, entry)
        setCounts(seeded)

        const activityRequest = window.api.getConversationActivity?.()
        const activityMap = activityRequest ? await activityRequest.catch(() => ({})) : {}
        if (disposed) return
        setActivity(activityMap ?? {})
      } catch {
        if (!disposed) setFailed(true)
      } finally {
        if (!disposed) setLoading(false)
      }
    })()

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [enabled])

  const options = React.useMemo(
    () => contacts.map((contact) => toOption(contact, counts.get(contact.md5), activity)),
    [contacts, counts, activity]
  )

  return { options, loading, failed }
}
