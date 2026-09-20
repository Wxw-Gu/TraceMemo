import { useEffect, useState } from 'react'
import type { Contact } from '../../../shared/types'
import type { GroupExitMonitorEvent } from '../../../shared/group-exit-monitor'

/**
 * 取某个群的退群推断事件（档案合并展示用）。
 *
 * 两条硬约束：
 * 1. **只对群聊请求** —— 单聊没有「群成员快照」这个概念；
 * 2. **任何失败都退化成「没有事件」** —— 退群事件是附加信息，
 *    拿不到它绝不能让档案本身的消息展示受影响。
 */
export function useGroupExitEvents(contact: Contact | null): GroupExitMonitorEvent[] {
  const [events, setEvents] = useState<GroupExitMonitorEvent[]>([])
  const roomId = contact?.type === 'group' ? contact.m_nsUsrName || '' : ''

  useEffect(() => {
    if (!roomId) {
      setEvents([])
      return
    }
    let disposed = false
    window.api
      .listGroupExitMonitorEvents({ roomId })
      .then((list) => {
        if (!disposed) setEvents(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (!disposed) setEvents([])
      })
    return () => {
      disposed = true
    }
  }, [roomId])

  return events
}
