import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportTemplateMarketWorkspace } from '../../src/renderer/src/components/reports/ReportTemplateMarketWorkspace'

const installed = {
  id: 'community.github.tracememo.quickread',
  version: '1.0.0',
  interfaceVersion: '1',
  source: 'installed' as const,
  name: '极简速读',
  author: 'fixture',
  entryPath: '/tmp/entry.html',
  capture: { width: 414, maxWidth: 414, maxHeight: 2000 },
  license: { spdx: 'MIT' }
}

const availableEntry = {
  id: 'community.github.tracememo.paperdaily',
  version: '1.0.2',
  interfaceVersion: '1',
  name: '霓光指挥日报',
  description: '霓光主题的桌面指挥日报。',
  author: 'fixture',
  platform: 'desktop' as const,
  tags: [],
  license: 'MIT',
  minAppVersion: null,
  download: 'https://example.com/template.zip',
  sizeBytes: 1,
  sha256: 'a'.repeat(64),
  preview: 'https://example.com/preview.png',
  status: 'published' as const
}

const listReportTemplates = vi.fn()
const listReportTemplateCatalog = vi.fn()
const installReportTemplateFromCatalog = vi.fn()
const uninstallReportTemplate = vi.fn()

describe('ReportTemplateMarketWorkspace', () => {
  beforeEach(() => {
    listReportTemplates.mockReset().mockResolvedValue([installed])
    listReportTemplateCatalog.mockReset().mockResolvedValue({
      success: true,
      catalog: { schemaVersion: '1', status: 'published', templates: [availableEntry] }
    })
    installReportTemplateFromCatalog.mockReset().mockResolvedValue({ success: true })
    uninstallReportTemplate.mockReset().mockResolvedValue({ success: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listReportTemplates,
        listReportTemplateCatalog,
        installReportTemplateFromCatalog,
        uninstallReportTemplate
      }
    })
  })

  it('lists builtin, installed and installable market templates with all market actions', async () => {
    render(<ReportTemplateMarketWorkspace value="v1" onChange={vi.fn()} />)

    expect(await screen.findByText('极简速读')).toBeVisible()
    expect(screen.getByText('霓光指挥日报')).toBeVisible()
    expect(screen.getByText('经典日报')).toBeVisible()
    expect(screen.getByText('已安装市场模板')).toBeVisible()
    expect(screen.getByText('已安装 1 个市场模板，另有 1 个可以安装。')).toBeVisible()
    expect(screen.getByRole('button', { name: '安装' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '卸载' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '当前使用' })).not.toBeInTheDocument()
  })

  it('links to the community template repository for submitting new templates', async () => {
    render(<ReportTemplateMarketWorkspace value="v1" onChange={vi.fn()} />)

    const link = await screen.findByRole('link', { name: '前往提交模板' })
    expect(link).toHaveAttribute('href', 'https://github.com/Wxw-Gu/TraceMemo-Templates')
    expect(link).toHaveAttribute('target', '_blank')
    expect(
      screen.getByText(
        '如果想提供给其他人模板样式，可以来 TraceMemo-Templates 项目里提交 PR，方便给其他用户使用。'
      )
    ).toBeVisible()
  })

  it('uninstalls a market template and refreshes the list', async () => {
    const user = userEvent.setup()
    uninstallReportTemplate.mockImplementation(async () => {
      listReportTemplates.mockResolvedValue([])
      return { success: true }
    })
    render(<ReportTemplateMarketWorkspace value="v1" onChange={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: '卸载' }))

    await waitFor(() =>
      expect(uninstallReportTemplate).toHaveBeenCalledWith(installed.id, installed.version)
    )
    expect(await screen.findByText('已安装 0 个市场模板，另有 1 个可以安装。')).toBeVisible()
  })

  it('falls back to the default template when the active market template is uninstalled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    uninstallReportTemplate.mockResolvedValue({ success: true })
    render(
      <ReportTemplateMarketWorkspace
        value={`external:${installed.id}@${installed.version}`}
        onChange={onChange}
      />
    )

    await user.click(await screen.findByRole('button', { name: '卸载' }))

    expect(onChange).toHaveBeenCalledWith('v1')
  })

  it('reports an uninstall failure without dropping the installed template', async () => {
    const user = userEvent.setup()
    uninstallReportTemplate.mockResolvedValue({ success: false, error: '模板正在使用中' })
    render(<ReportTemplateMarketWorkspace value="v1" onChange={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: '卸载' }))

    expect(await screen.findByText('模板市场：模板正在使用中')).toBeVisible()
    expect(screen.getByText('极简速读')).toBeVisible()
  })

  it('installs a market template and refreshes the list', async () => {
    const user = userEvent.setup()
    installReportTemplateFromCatalog.mockImplementation(async () => {
      listReportTemplates.mockResolvedValue([installed, { ...availableEntry, source: 'installed' }])
      listReportTemplateCatalog.mockResolvedValue({
        success: true,
        catalog: { schemaVersion: '1', status: 'published', templates: [availableEntry] }
      })
      return { success: true }
    })
    render(<ReportTemplateMarketWorkspace value="v1" onChange={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: '安装' }))

    await waitFor(() =>
      expect(installReportTemplateFromCatalog).toHaveBeenCalledWith(
        availableEntry.id,
        availableEntry.version
      )
    )
    expect(await screen.findByText('已安装 2 个市场模板，另有 0 个可以安装。')).toBeVisible()
  })

  it('reports an install failure without losing the catalog', async () => {
    const user = userEvent.setup()
    installReportTemplateFromCatalog.mockResolvedValue({ success: false, error: '下载校验失败' })
    render(<ReportTemplateMarketWorkspace value="v1" onChange={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: '安装' }))

    expect(await screen.findByText('模板市场：下载校验失败')).toBeVisible()
    expect(screen.getByText('霓光指挥日报')).toBeVisible()
  })

  it('previews a market template and can switch to it once installed', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ReportTemplateMarketWorkspace value="v1" onChange={onChange} />)

    const installedRow = (await screen.findByText('极简速读')).closest('.report-template-item')!
    await user.click(within(installedRow as HTMLElement).getByRole('button', { name: '查看版式' }))
    const dialog = await screen.findByRole('dialog', { name: '极简速读' })
    await user.click(within(dialog).getByRole('button', { name: '选择此模板' }))

    expect(onChange).toHaveBeenCalledWith(`external:${installed.id}@${installed.version}`)
  })

  it('does not let an uninstalled market template be selected from the preview', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ReportTemplateMarketWorkspace value="v1" onChange={onChange} />)

    const availableRow = (await screen.findByText('霓光指挥日报')).closest('.report-template-item')!
    await user.click(within(availableRow as HTMLElement).getByRole('button', { name: '查看版式' }))
    const dialog = await screen.findByRole('dialog', { name: '霓光指挥日报' })

    expect(within(dialog).getByRole('button', { name: '请先安装' })).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: '使用此模板' })).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('marks the active market template and hides the switch action', async () => {
    render(
      <ReportTemplateMarketWorkspace
        value={`external:${installed.id}@${installed.version}`}
        onChange={vi.fn()}
      />
    )

    const installedRow = (await screen.findByText('极简速读')).closest('.report-template-item')!
    expect(within(installedRow as HTMLElement).getByRole('button', { name: '当前使用' })).toBeDisabled()
    expect(within(installedRow as HTMLElement).queryByRole('button', { name: '使用' })).toBeNull()
    expect(within(installedRow as HTMLElement).getByRole('button', { name: '卸载' })).toBeEnabled()
  })
})
