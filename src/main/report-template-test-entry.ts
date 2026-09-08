import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'

const userData = process.env.TRACEMEMO_TEMPLATE_TEST_USER_DATA
if (!userData) throw new Error('TRACEMEMO_TEMPLATE_TEST_USER_DATA is required')
app.setPath('userData', userData)
app.setPath('logs', path.join(userData, 'logs'))

app.whenReady().then(async () => {
  const { registerReportTemplateIpc } = await import('./report-template-ipc')
  const { reportTemplateService } = await import('./report-template-service')
  const {
    deleteGeneratedReport,
    listGeneratedReports,
    prepareGeneratedReportTemplateSwitch,
    saveGeneratedReport,
    updateGeneratedReportTemplate
  } = await import('./report-history-service')
  const { exportGroupReportSnapshot, extractGroupReportRenderSnapshot } = await import('./group-report-service')
  await reportTemplateService.recover()
  registerReportTemplateIpc()
  ipcMain.handle('report:listGenerated', () => listGeneratedReports())
  ipcMain.handle('report:saveGenerated', (_, request) => saveGeneratedReport(request))
  ipcMain.handle('report:updateGeneratedTemplate', (_, request) => updateGeneratedReportTemplate(request))
  ipcMain.handle('report:prepareTemplateSwitch', (_, request: { reportId: string }) =>
    prepareGeneratedReportTemplateSwitch(request.reportId, extractGroupReportRenderSnapshot)
  )
  ipcMain.handle('report:deleteGenerated', (_, reportId: string) => deleteGeneratedReport(reportId))
  ipcMain.handle('report:exportSnapshot', (_, request) => exportGroupReportSnapshot(request))
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  await window.loadFile(path.join(__dirname, '../renderer/index.html'))
})

app.on('window-all-closed', () => app.quit())
