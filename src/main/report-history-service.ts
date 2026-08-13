import { app, nativeImage } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import type {
  GeneratedReportRecord,
  DeleteGeneratedReportResult,
  ReportAssetStatus,
  ReportHistoryResult,
  SaveGeneratedReportRequest,
  SaveGeneratedReportResult,
  UpdateGeneratedReportTemplateRequest,
  UpdateGeneratedReportTemplateResult
} from '../shared/report-history'
import type { GroupReportRenderSnapshot } from '../shared/group-report'

const REPORTS_DIR = 'reports'

const getReportsRoot = (): string => path.join(app.getPath('userData'), REPORTS_DIR)

const pad2 = (value: number): string => String(value).padStart(2, '0')

const safeSegment = (value: string): string =>
  value
    .trim()
    // Strip Windows-reserved filename characters and ASCII control chars.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 48) || 'report'

const parseDataUrl = (dataUrl: string): Buffer | null => {
  const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl)
  if (!match) return null
  return Buffer.from(match[1], 'base64')
}

const exists = async (filePath?: string): Promise<boolean> => {
  if (!filePath) return false
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

const fileStatus = async (filePath?: string): Promise<ReportAssetStatus> =>
  (await exists(filePath)) ? 'ready' : 'missing'

const readPngAsDataUrl = async (filePath?: string): Promise<string | undefined> => {
  if (!filePath || !(await exists(filePath))) return undefined
  const content = await fs.readFile(filePath)
  return `data:image/png;base64,${content.toString('base64')}`
}

const readPngSize = async (
  filePath?: string
): Promise<{ width: number; height: number } | undefined> => {
  if (!filePath || !(await exists(filePath))) return undefined
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) return undefined
  const size = image.getSize()
  return size.width && size.height ? size : undefined
}

const readFileSize = async (filePath?: string): Promise<number | undefined> => {
  if (!filePath) return undefined
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile() ? stat.size : undefined
  } catch {
    return undefined
  }
}

const normalizeRecord = async (
  record: GeneratedReportRecord,
  jsonPath: string
): Promise<GeneratedReportRecord> => {
  const htmlStatus = await fileStatus(record.htmlPath)
  const pngStatus = await fileStatus(record.pngPath)
  return {
    ...record,
    textModelName: record.textModelName || record.modelName,
    jsonPath,
    htmlStatus,
    pngStatus,
    generatedImage: await readPngAsDataUrl(record.pngPath),
    imageSize: await readPngSize(record.pngPath),
    fileSize: {
      html: await readFileSize(record.htmlPath),
      png: await readFileSize(record.pngPath)
    }
  }
}

const walkJsonFiles = async (directory: string): Promise<string[]> => {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const children = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) return walkJsonFiles(entryPath)
        return entry.isFile() && entry.name.endsWith('.json') ? [entryPath] : []
      })
    )
    return children.flat()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function listGeneratedReports(): Promise<ReportHistoryResult> {
  try {
    const jsonFiles = await walkJsonFiles(getReportsRoot())
    const records = await Promise.all(
      jsonFiles.map(async (jsonPath) => {
        try {
          const content = await fs.readFile(jsonPath, 'utf8')
          return normalizeRecord(JSON.parse(content) as GeneratedReportRecord, jsonPath)
        } catch (error) {
          console.warn(`[ReportHistory] skip invalid report record: ${jsonPath}`, error)
          return null
        }
      })
    )
    const reports = records.filter((record): record is GeneratedReportRecord => Boolean(record))
    reports.sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt))
    return { success: true, reports }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function saveGeneratedReport(
  request: SaveGeneratedReportRequest
): Promise<SaveGeneratedReportResult> {
  try {
    const generatedAtDate = new Date(request.generatedAt)
    const timestamp = Number.isFinite(generatedAtDate.getTime()) ? generatedAtDate : new Date()
    const year = String(timestamp.getFullYear())
    const month = pad2(timestamp.getMonth() + 1)
    const directory = path.join(getReportsRoot(), year, month)
    await fs.mkdir(directory, { recursive: true })

    const id = `report_${timestamp.getTime()}_${Math.random().toString(36).slice(2, 8)}`
    const baseName = `${id}_${safeSegment(request.contactName)}`
    const htmlPath = path.join(directory, `${baseName}.html`)
    const pngPath = path.join(directory, `${baseName}.png`)
    const jsonPath = path.join(directory, `${baseName}.json`)

    let savedHtmlPath: string | undefined
    if (request.htmlPath && (await exists(request.htmlPath))) {
      await fs.copyFile(request.htmlPath, htmlPath)
      savedHtmlPath = htmlPath
    }

    let savedPngPath: string | undefined
    const imageBuffer = request.generatedImage ? parseDataUrl(request.generatedImage) : null
    if (imageBuffer) {
      await fs.writeFile(pngPath, imageBuffer)
      savedPngPath = pngPath
    } else if (request.pngPath && (await exists(request.pngPath))) {
      await fs.copyFile(request.pngPath, pngPath)
      savedPngPath = pngPath
    }

    const record: GeneratedReportRecord = {
      id,
      contactId: request.contactId,
      contactName: request.contactName,
      contactAvatar: request.contactAvatar,
      dateRange: request.dateRange,
      messageCount: request.messageCount,
      generatedAt: timestamp.toISOString(),
      reportDate: `${year}-${month}-${pad2(timestamp.getDate())}`,
      htmlPath: savedHtmlPath,
      pngPath: savedPngPath,
      jsonPath,
      htmlStatus: savedHtmlPath ? 'ready' : 'missing',
      pngStatus: savedPngPath ? 'ready' : 'missing',
      imageSize: await readPngSize(savedPngPath),
      duration: request.duration,
      textModelName: request.textModelName || request.modelName,
      imageModelName: request.imageModelName,
      modelName: request.modelName,
      tokenUsage: request.tokenUsage,
      fileSize: {
        html: await readFileSize(savedHtmlPath),
        png: await readFileSize(savedPngPath)
      },
      generationLogs: request.generationLogs,
      reportSnapshot: request.reportSnapshot,
      reportMetadata: request.reportMetadata,
      templateId: request.templateId
    }

    await fs.writeFile(jsonPath, JSON.stringify(record, null, 2), 'utf8')
    return {
      success: true,
      record: {
        ...record,
        generatedImage: savedPngPath ? await readPngAsDataUrl(savedPngPath) : undefined
      }
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function updateGeneratedReportTemplate(
  request: UpdateGeneratedReportTemplateRequest
): Promise<UpdateGeneratedReportTemplateResult> {
  try {
    const jsonFiles = await walkJsonFiles(getReportsRoot())
    for (const jsonPath of jsonFiles) {
      try {
        const content = await fs.readFile(jsonPath, 'utf8')
        const record = JSON.parse(content) as GeneratedReportRecord
        if (record.id !== request.reportId) continue
        if ((!record.reportSnapshot || !record.reportMetadata) && !record.reportRenderSnapshot) {
          return { success: false, error: '旧报告未保存结构化数据，无法无损切换模板' }
        }

        const directory = path.dirname(jsonPath)
        const baseName = path.basename(jsonPath, '.json')
        const htmlPath = record.htmlPath || path.join(directory, `${baseName}.html`)
        const pngPath = record.pngPath || path.join(directory, `${baseName}.png`)

        const imageBuffer = request.generatedImage ? parseDataUrl(request.generatedImage) : null
        const hasPngFile = Boolean(request.pngPath && (await exists(request.pngPath)))
        if (!request.htmlPath || !(await exists(request.htmlPath))) {
          return { success: false, error: '新模板 HTML 文件不存在' }
        }
        if (!imageBuffer && !hasPngFile) {
          return { success: false, error: '新模板 PNG 文件不存在' }
        }
        await fs.copyFile(request.htmlPath, htmlPath)
        if (imageBuffer) {
          await fs.writeFile(pngPath, imageBuffer)
        } else if (request.pngPath) {
          await fs.copyFile(request.pngPath, pngPath)
        }

        const updated: GeneratedReportRecord = {
          ...record,
          htmlPath,
          pngPath,
          jsonPath,
          htmlStatus: 'ready',
          pngStatus: 'ready',
          imageSize: await readPngSize(pngPath),
          fileSize: {
            html: await readFileSize(htmlPath),
            png: await readFileSize(pngPath)
          },
          templateId: request.templateId
        }
        delete updated.generatedImage
        await fs.writeFile(jsonPath, JSON.stringify(updated, null, 2), 'utf8')
        return {
          success: true,
          record: {
            ...updated,
            generatedImage: await readPngAsDataUrl(pngPath)
          }
        }
      } catch (error) {
        console.warn(
          `[ReportHistory] skip invalid report record while switching template: ${jsonPath}`,
          error
        )
      }
    }
    return { success: false, error: '未找到要切换模板的日报记录' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function prepareGeneratedReportTemplateSwitch(
  reportId: string,
  extractSnapshot: (
    htmlPath: string,
    fallback: {
      groupName: string
      reportDate: string
      dateRange: string
      messageCount: number
      generatedAt: string
    }
  ) => Promise<GroupReportRenderSnapshot>
): Promise<import('../shared/report-history').PrepareGeneratedReportTemplateSwitchResult> {
  try {
    const jsonFiles = await walkJsonFiles(getReportsRoot())
    for (const jsonPath of jsonFiles) {
      try {
        const content = await fs.readFile(jsonPath, 'utf8')
        const record = JSON.parse(content) as GeneratedReportRecord
        if (record.id !== reportId) continue
        if (record.reportRenderSnapshot)
          return { success: true, snapshot: record.reportRenderSnapshot }
        if (!record.htmlPath || !(await exists(record.htmlPath))) {
          return { success: false, error: '当前日报缺少 HTML 文件，无法迁移旧模板数据' }
        }
        const snapshot = await extractSnapshot(record.htmlPath, {
          groupName: record.contactName,
          reportDate: record.reportDate,
          dateRange: record.dateRange,
          messageCount: record.messageCount,
          generatedAt: record.generatedAt
        })
        const updated = { ...record, reportRenderSnapshot: snapshot }
        await fs.writeFile(jsonPath, JSON.stringify(updated, null, 2), 'utf8')
        return { success: true, snapshot }
      } catch (error) {
        console.warn(
          `[ReportHistory] skip invalid report record while preparing template switch: ${jsonPath}`,
          error
        )
      }
    }
    return { success: false, error: '未找到要切换模板的日报记录' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function deleteGeneratedReport(
  reportId: string
): Promise<DeleteGeneratedReportResult> {
  try {
    const jsonFiles = await walkJsonFiles(getReportsRoot())
    for (const jsonPath of jsonFiles) {
      try {
        const content = await fs.readFile(jsonPath, 'utf8')
        const record = JSON.parse(content) as GeneratedReportRecord
        if (record.id !== reportId) continue

        const paths = [record.htmlPath, record.pngPath, jsonPath].filter(
          (filePath): filePath is string => Boolean(filePath)
        )
        await Promise.all(
          paths.map(async (filePath) => {
            try {
              await fs.unlink(filePath)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
          })
        )
        return { success: true, deletedId: reportId }
      } catch (error) {
        console.warn(
          `[ReportHistory] skip invalid report record while deleting: ${jsonPath}`,
          error
        )
      }
    }
    return { success: false, error: '未找到要删除的日报记录' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
