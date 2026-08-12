export type ReportTemplateId =
  | 'mobile-feed'
  | 'mobile-magazine'
  | 'mobile-dashboard'
  | 'desktop-workspace'
  | 'desktop-editorial'

export type LegacyReportTemplateId = 'v1' | 'v2'
export type SelectableReportTemplateId = 'v1' | ReportTemplateId
export type ReportTemplateRequestId = ReportTemplateId | LegacyReportTemplateId
export type ReportTemplatePlatform = 'default' | 'mobile' | 'desktop'

export interface ReportTemplateDefinition {
  id: SelectableReportTemplateId
  order: number
  platform: ReportTemplatePlatform
  label: string
  name: string
  tagline: string
  fileLabel: string
  cssClass: string
  resourceFile: string
  captureWidth: number
  maxCaptureWidth: number
}

const SHARED_RESOURCE = 'daily_report_templates.html'

export const DEFAULT_REPORT_TEMPLATE: Readonly<ReportTemplateDefinition> = {
  id: 'v1',
  order: 0,
  platform: 'default',
  label: '默认模板',
  name: '经典日报',
  tagline: '熟悉的单栏日报版式，信息完整，适合直接生成与分享',
  fileLabel: '经典版',
  cssClass: 'template-classic',
  resourceFile: 'mobile_daily_report_v1.html',
  captureWidth: 430,
  maxCaptureWidth: 1200
}

export const REPORT_TEMPLATES: readonly ReportTemplateDefinition[] = [
  {
    id: 'mobile-feed',
    order: 1,
    platform: 'mobile',
    label: 'Mobile 01',
    name: '微信信息流',
    tagline: '聊天头像、真实消息与 AI 重点整理并列呈现',
    fileLabel: '手机微信信息流',
    cssClass: 'template-mobile-feed',
    resourceFile: SHARED_RESOURCE,
    captureWidth: 430,
    maxCaptureWidth: 430
  },
  {
    id: 'mobile-magazine',
    order: 2,
    platform: 'mobile',
    label: 'Mobile 02',
    name: 'AI Magazine',
    tagline: '大标题、大数字与编辑式留白的科技日报',
    fileLabel: '手机AI杂志',
    cssClass: 'template-mobile-magazine',
    resourceFile: SHARED_RESOURCE,
    captureWidth: 430,
    maxCaptureWidth: 430
  },
  {
    id: 'mobile-dashboard',
    order: 3,
    platform: 'mobile',
    label: 'Mobile 03',
    name: 'AI Command Center',
    tagline: 'KPI、热度、排行与问答构成的群聊数据驾驶舱',
    fileLabel: '手机数据驾驶舱',
    cssClass: 'template-mobile-dashboard',
    resourceFile: SHARED_RESOURCE,
    captureWidth: 430,
    maxCaptureWidth: 430
  },
  {
    id: 'desktop-workspace',
    order: 4,
    platform: 'desktop',
    label: 'Desktop 01',
    name: '三栏 AI 工作台',
    tagline: '概览、核心讨论、成员与问答同时可见',
    fileLabel: '桌面三栏工作台',
    cssClass: 'template-desktop-workspace',
    resourceFile: SHARED_RESOURCE,
    captureWidth: 1440,
    maxCaptureWidth: 1920
  },
  {
    id: 'desktop-editorial',
    order: 5,
    platform: 'desktop',
    label: 'Desktop 02',
    name: 'Editorial 科技日报',
    tagline: '头条、专栏、引语与新闻式分隔构成的编辑版面',
    fileLabel: '桌面Editorial',
    cssClass: 'template-desktop-editorial',
    resourceFile: SHARED_RESOURCE,
    captureWidth: 1440,
    maxCaptureWidth: 1920
  }
]

export const SELECTABLE_REPORT_TEMPLATES: readonly ReportTemplateDefinition[] = [
  DEFAULT_REPORT_TEMPLATE,
  ...REPORT_TEMPLATES
]

export const isReportTemplateId = (value: unknown): value is ReportTemplateId =>
  REPORT_TEMPLATES.some((template) => template.id === value)

export const isSelectableReportTemplateId = (
  value: unknown
): value is SelectableReportTemplateId =>
  SELECTABLE_REPORT_TEMPLATES.some((template) => template.id === value)

export const getReportTemplate = (value?: string): ReportTemplateDefinition =>
  SELECTABLE_REPORT_TEMPLATES.find((template) => template.id === value) || DEFAULT_REPORT_TEMPLATE
