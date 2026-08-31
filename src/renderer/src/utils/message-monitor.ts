export interface WcdbMonitorEvent {
  db?: string
  table?: string
  action?: string
}

const normalizeMonitorValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const monitorBasename = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
  return basename.replace(/-(?:wal|shm)$/i, '')
}

export const parseWcdbMonitorEvent = (rawPayload: string): WcdbMonitorEvent | null => {
  try {
    const parsed: unknown = JSON.parse(rawPayload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const event = parsed as Record<string, unknown>
    const result: WcdbMonitorEvent = {}
    const db = normalizeMonitorValue(event.db)
    const table = normalizeMonitorValue(event.table)
    const action = normalizeMonitorValue(event.action)
    if (db) result.db = db
    if (table) result.table = table
    if (action) result.action = action
    return result
  } catch {
    return null
  }
}

const isMessageStoreName = (value: string): boolean => {
  const basename = monitorBasename(value).toLowerCase()
  return (
    basename === 'message' ||
    basename.startsWith('message_') ||
    basename === 'msg' ||
    basename.startsWith('msg_')
  )
}

export const isRelevantMessageMonitorEvent = (
  rawPayload: string,
  targetIds: string[] = []
): boolean => {
  const event = parseWcdbMonitorEvent(rawPayload)
  if (!event) return false

  const db = event.db || ''
  const table = event.table || ''
  if (isMessageStoreName(table) || isMessageStoreName(db)) return true

  if (!db && !table) return true

  const normalizedTargets = targetIds.map((value) => value.trim().toLowerCase()).filter(Boolean)
  const eventText = `${db} ${table}`.toLowerCase()
  return normalizedTargets.some((targetId) => eventText.includes(targetId))
}
