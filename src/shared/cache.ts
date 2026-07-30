export type CacheClearScope = 'bootstrap' | 'electron' | 'all'

export interface CacheSummaryItem {
  id: 'bootstrap' | 'electron'
  label: string
  description: string
  sizeBytes: number
  fileCount: number
}

export interface CacheSummary {
  items: CacheSummaryItem[]
  totalBytes: number
  updatedAt: number
}
