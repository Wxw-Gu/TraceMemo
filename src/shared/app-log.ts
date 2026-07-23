export type AppLogLevel = 'info' | 'warn' | 'error'

export interface AppLogEntry {
  level: AppLogLevel
  scope: string
  message: string
  details?: Record<string, unknown>
}
