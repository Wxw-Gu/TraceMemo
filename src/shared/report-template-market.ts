import type { ReportTemplateOperationResult } from './report-template-package'

export const REPORT_TEMPLATE_CATALOG_URL =
  'https://raw.githubusercontent.com/Wxw-Gu/TraceMemo-Templates/main/catalog/v1/index.json'

export interface ReportTemplateCatalogEntry {
  id: string
  version: string
  interfaceVersion: string
  name: string
  description: string
  author: string
  platform?: 'default' | 'mobile' | 'desktop'
  tags: string[]
  license: string
  minAppVersion: string | null
  download: string
  sizeBytes: number
  sha256: string
  preview?: string
  publishedAt?: string | null
  status: 'published' | 'draft'
}

export interface ReportTemplateCatalog {
  schemaVersion: '1'
  generatedAt?: string
  source?: {
    repository?: string
    commit?: string
  }
  status: 'published' | 'draft'
  templates: ReportTemplateCatalogEntry[]
}

export interface ReportTemplateCatalogResult {
  success: boolean
  catalog?: ReportTemplateCatalog
  error?: string
  code?: string
}

export interface ReportTemplateCatalogInstallResult extends ReportTemplateOperationResult {
  catalogEntry?: ReportTemplateCatalogEntry
}
