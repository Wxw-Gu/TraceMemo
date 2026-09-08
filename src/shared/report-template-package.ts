import type { ReportTemplatePlatform } from './report-templates'

export const REPORT_TEMPLATE_PACKAGE_PROTOCOL_VERSION = '1.0'
export const REPORT_TEMPLATE_INTERFACE_VERSION = '1'

export const REPORT_TEMPLATE_LIMITS = {
  maxCompressedBytes: 20 * 1024 * 1024,
  maxExtractedBytes: 50 * 1024 * 1024,
  maxFiles: 100,
  maxFileBytes: 10 * 1024 * 1024,
  maxHtmlBytes: 2 * 1024 * 1024,
  maxCssBytes: 2 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024
} as const

export type ReportTemplateSource = 'builtin' | 'installed'
export interface ReportTemplateRef {
  id: string
  version?: string
}

export interface ReportTemplateManifest {
  protocolVersion: string
  kind: 'daily-report'
  id: string
  name: string
  author: { name: string; homepage?: string }
  templateVersion: string
  interfaceVersion: string
  entry: string
  preview?: string
  capture: { width: number; maxWidth: number; maxHeight: number }
  license: { spdx: string; notice?: string }
  minAppVersion?: string
  platform?: ReportTemplatePlatform
}

export interface InstalledReportTemplate {
  id: string
  version: string
  interfaceVersion: string
  source: ReportTemplateSource
  name: string
  author: string
  entryPath: string
  previewPath?: string
  capture: ReportTemplateManifest['capture']
  license: ReportTemplateManifest['license']
  packagePath?: string
  sha256?: string
  installedAt?: string
}

export type ReportTemplateValueKind = 'text' | 'html' | 'class'
export const REPORT_TEMPLATE_PLACEHOLDERS: Readonly<Record<string, ReportTemplateValueKind>> = {
  REPORT_TITLE: 'text', REPORT_DATE: 'text', GROUP_NAME: 'text', DATE_RANGE: 'text',
  RECORD_NOTE: 'text', OVERVIEW: 'text', HERO_HEADLINE: 'text', HERO_SUMMARY: 'text',
  HERO_TAKEAWAY: 'text', HERO_PENDING: 'text', HERO_STATUS_LINE: 'text', MESSAGE_COUNT: 'text',
  ACTIVE_USERS: 'text', TIME_SPAN: 'text', TOPIC_COUNT: 'text', MEDIA_COUNT: 'text',
  CONCLUSION_COUNT: 'text', TODO_COUNT: 'text', UNRESOLVED_COUNT: 'text',
  ACTIVITY_TIMELINE: 'text', GENERATED_AT: 'text', FOOTER_NOTE: 'text',
  TEMPLATE_LABEL: 'text', TEMPLATE_NAME: 'text',
  HERO_AVATARS: 'html', TOPIC_CARDS: 'html', IMPORTANT_MESSAGES: 'html', QUOTE_BLOCKS: 'html',
  QA_CARDS: 'html', RESOURCE_ITEMS: 'html', TODO_CARDS: 'html', UNRESOLVED_CARDS: 'html',
  STORYLINE_CARDS: 'html', REVERSAL_CARDS: 'html', CHAIN_CARDS: 'html', VISION_CARDS: 'html',
  VOICE_CARDS: 'html', VOICE_RANK_CARDS: 'html', BADGE_CARDS: 'html', RANK_ITEMS: 'html',
  HEAT_BARS: 'html', CLOUD_TAGS: 'html',
  TEMPLATE_CLASS: 'class', REPORT_MODE_CLASS: 'class', HERO_AVATAR_CLASS: 'class',
  HERO_STATUS_EMPTY_CLASS: 'class', HERO_TAKEAWAY_EMPTY_CLASS: 'class', HERO_PENDING_EMPTY_CLASS: 'class',
  TOPICS_EMPTY_CLASS: 'class', TOPICS_MORE_NOTE: 'html', MESSAGES_EMPTY_CLASS: 'class',
  MESSAGES_MORE_NOTE: 'html', QUOTES_EMPTY_CLASS: 'class', QUOTES_MORE_NOTE: 'html',
  ACTIONS_EMPTY_CLASS: 'class', ACTIONS_MORE_NOTE: 'html', QA_EMPTY_CLASS: 'class', QA_MORE_NOTE: 'html',
  RESOURCES_EMPTY_CLASS: 'class', RESOURCES_MORE_NOTE: 'html', STORYLINES_EMPTY_CLASS: 'class',
  STORYLINES_MORE_NOTE: 'html', REVERSALS_EMPTY_CLASS: 'class', REVERSALS_MORE_NOTE: 'html',
  CHAINS_EMPTY_CLASS: 'class', CHAINS_MORE_NOTE: 'html', VISION_EMPTY_CLASS: 'class',
  VOICE_EMPTY_CLASS: 'class', VOICE_MORE_NOTE: 'html', VOICE_RANK_EMPTY_CLASS: 'class',
  BADGES_EMPTY_CLASS: 'class', BADGES_MORE_NOTE: 'html', KEYWORDS_EMPTY_CLASS: 'class',
  KEYWORDS_MORE_NOTE: 'html', ANALYTICS_EMPTY_CLASS: 'class', TODO_EMPTY_CLASS: 'class',
  UNRESOLVED_EMPTY_CLASS: 'class'
}

export const REPORT_TEMPLATE_ALLOWED_TAGS = new Set([
  'html', 'head', 'body', 'meta', 'title', 'style', 'main', 'section', 'article', 'header',
  'footer', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'b', 'strong', 'em', 'i', 'small',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'br'
])
export const REPORT_TEMPLATE_ALLOWED_ATTRS = new Set([
  'class', 'id', 'title', 'aria-hidden', 'aria-label', 'alt', 'width', 'height', 'role', 'content',
  'charset', 'name', 'content', 'src'
])
export const REPORT_TEMPLATE_ALLOWED_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export class ReportTemplateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ReportTemplateError'
  }
}

export interface ReportTemplateOperationResult {
  success: boolean
  template?: InstalledReportTemplate
  error?: string
  code?: string
}
