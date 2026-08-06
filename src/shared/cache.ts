export type CacheClearScope = 'bootstrap' | 'electron' | 'knowledge' | 'all'

export interface CacheSummaryItem {
  id: 'bootstrap' | 'electron' | 'knowledge'
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
