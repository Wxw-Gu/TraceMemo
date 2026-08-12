import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPORT_TEMPLATE,
  getReportTemplate,
  isReportTemplateId,
  isSelectableReportTemplateId,
  REPORT_TEMPLATES,
  SELECTABLE_REPORT_TEMPLATES
} from '../../src/shared/report-templates'

describe('daily report templates', () => {
  it('exposes the classic default plus exactly three mobile and two desktop product templates', () => {
    expect(REPORT_TEMPLATES).toHaveLength(5)
    expect(SELECTABLE_REPORT_TEMPLATES).toHaveLength(6)
    expect(SELECTABLE_REPORT_TEMPLATES[0]).toEqual(DEFAULT_REPORT_TEMPLATE)
    expect(DEFAULT_REPORT_TEMPLATE).toMatchObject({
      id: 'v1',
      label: '默认模板',
      name: '经典日报',
      resourceFile: 'mobile_daily_report_v1.html'
    })
    expect(REPORT_TEMPLATES.filter((template) => template.platform === 'mobile')).toHaveLength(3)
    expect(REPORT_TEMPLATES.filter((template) => template.platform === 'desktop')).toHaveLength(2)
    expect(new Set(REPORT_TEMPLATES.map((template) => template.cssClass)).size).toBe(5)
  })

  it('uses mobile and desktop capture widths appropriate to their layouts', () => {
    expect(DEFAULT_REPORT_TEMPLATE.captureWidth).toBe(430)
    expect(DEFAULT_REPORT_TEMPLATE.maxCaptureWidth).toBeGreaterThanOrEqual(
      DEFAULT_REPORT_TEMPLATE.captureWidth
    )
    for (const template of REPORT_TEMPLATES) {
      expect(
        template.platform === 'mobile' ? template.captureWidth : template.captureWidth >= 1280
      ).toBeTruthy()
      expect(template.maxCaptureWidth).toBeGreaterThanOrEqual(template.captureWidth)
    }
  })

  it('resolves v1 and unknown ids to the classic default template', () => {
    expect(isReportTemplateId('desktop-editorial')).toBe(true)
    expect(isReportTemplateId('v1')).toBe(false)
    expect(isSelectableReportTemplateId('v1')).toBe(true)
    expect(isSelectableReportTemplateId('v2')).toBe(false)
    expect(getReportTemplate('unknown').id).toBe('v1')
    expect(getReportTemplate('v1')).toEqual(DEFAULT_REPORT_TEMPLATE)
  })

  it('ships the classic resource and shared semantic resource with five distinct layout classes', () => {
    expect(existsSync(resolve('resources', DEFAULT_REPORT_TEMPLATE.resourceFile))).toBe(true)
    const resourcePath = resolve('resources', 'daily_report_templates.html')
    expect(existsSync(resourcePath)).toBe(true)
    const html = readFileSync(resourcePath, 'utf8')
    for (const template of REPORT_TEMPLATES) {
      expect(html).toContain(`.${template.cssClass}`)
    }
    expect(html).toContain('{{TOPIC_CARDS}}')
    expect(html).toContain('{{IMPORTANT_MESSAGES}}')
    expect(html).toContain('{{QA_CARDS}}')
    expect(html).toContain('{{RANK_ITEMS}}')
    expect(html).toContain('{{HERO_AVATARS}}')
    expect(html).not.toContain('群聊相册')
    expect(html).not.toContain('今日群相册')
    expect(html).toContain('grid-template-columns: minmax(78px, 104px) minmax(72px, 1fr) 34px')
    expect(html).toContain('.template-mobile-dashboard .heat-name {')
    expect(html).toContain('white-space: normal')
  })
})
