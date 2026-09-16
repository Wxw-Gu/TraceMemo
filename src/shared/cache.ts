export type CacheClearScope =
  | 'bootstrap'
  | 'electron'
  | 'knowledge'
  | 'image-text-index'
  | 'all'

export interface CacheSummaryItem {
  id: 'bootstrap' | 'electron' | 'knowledge' | 'image-text-index'
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
