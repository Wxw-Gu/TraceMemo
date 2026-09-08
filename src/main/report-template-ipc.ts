import { ipcMain } from 'electron'
import { exportGroupReport } from './group-report-service'
import { reportTemplateService } from './report-template-service'
import { reportTemplateMarketService } from './report-template-market-service'
import type { GroupReportExportRequest } from '../shared/group-report'

let registered = false

export function registerReportTemplateIpc(): void {
  if (registered) return
  registered = true
  ipcMain.handle('report-template:list', () => reportTemplateService.list())
  ipcMain.handle('report-template:install', async (_, packagePath: string) => {
    try {
      return { success: true, template: await reportTemplateService.install(packagePath) }
    } catch (error) {
      return {
        success: false,
        code: error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'install_failed',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle('report-template:uninstall', async (_, id: string, version: string) => {
    try {
      await reportTemplateService.uninstall(id, version)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        code: error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'uninstall_failed',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle('report-template-market:list', () => reportTemplateMarketService.listCatalog())
  ipcMain.handle('report-template-market:install', (_, id: string, version: string) =>
    reportTemplateMarketService.installFromCatalog(String(id || ''), String(version || ''))
  )
  ipcMain.handle('report:export', (_, request: GroupReportExportRequest) => exportGroupReport(request))
}
