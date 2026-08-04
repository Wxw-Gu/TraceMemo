import fs from 'fs-extra'
import path from 'path'
import type { Wcdb4Client } from './wcdb4-client'

export type FileAssetResult = {
  success: boolean
  filePath?: string
  fileName?: string
  error?: string
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const monthName = (timestamp?: number): string => {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export class FileAssetService {
  private index:
    | {
        root: string
        files: { filePath: string; fileName: string; month: string; mtimeMs: number }[]
      }
    | undefined

  constructor(private readonly client: Pick<Wcdb4Client, 'getAccountRoot'>) {}

  resolve(fileTitle: string, createTime?: number): FileAssetResult {
    const normalizedTitle = path.basename(
      String(fileTitle || '')
        .trim()
        .replace(/\\/g, '/')
    )
    if (!normalizedTitle) return { success: false, error: '文件名为空，无法定位本地附件' }

    const configuredRoot = path.resolve(this.client.getAccountRoot(), 'msg', 'file')
    if (!fs.existsSync(configuredRoot)) {
      return { success: false, error: '本地文件附件目录不存在' }
    }
    const root = fs.realpathSync(configuredRoot)

    const preferredMonth = monthName(createTime)
    const extension = path.extname(normalizedTitle)
    const stem = normalizedTitle.slice(0, normalizedTitle.length - extension.length)
    const duplicatePattern = new RegExp(
      `^${escapeRegExp(stem)}(?:\\(\\d+\\))?${escapeRegExp(extension)}$`,
      'i'
    )
    const expectedTime = createTime ? createTime * 1000 : 0
    const candidates = this.getIndex(root).filter(({ fileName }) => duplicatePattern.test(fileName))

    candidates.sort((left, right) => {
      const leftPreferred = left.month === preferredMonth ? 1 : 0
      const rightPreferred = right.month === preferredMonth ? 1 : 0
      if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred
      const leftExact = left.fileName === normalizedTitle ? 1 : 0
      const rightExact = right.fileName === normalizedTitle ? 1 : 0
      if (leftExact !== rightExact) return rightExact - leftExact
      if (expectedTime) {
        const timeDifference =
          Math.abs(left.mtimeMs - expectedTime) - Math.abs(right.mtimeMs - expectedTime)
        if (timeDifference) return timeDifference
      }
      return left.fileName.localeCompare(right.fileName)
    })

    const selected = candidates[0]
    if (!selected) return { success: false, error: `本地未找到文件附件：${normalizedTitle}` }
    return { success: true, filePath: selected.filePath, fileName: selected.fileName }
  }

  private isSafeChild(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`)
  }

  private getIndex(
    root: string
  ): { filePath: string; fileName: string; month: string; mtimeMs: number }[] {
    if (this.index?.root === root) return this.index.files
    const files: { filePath: string; fileName: string; month: string; mtimeMs: number }[] = []
    for (const month of fs.readdirSync(root)) {
      const monthPath = path.resolve(root, month)
      if (!this.isSafeChild(root, monthPath) || !this.isDirectory(monthPath)) continue
      for (const fileName of fs.readdirSync(monthPath)) {
        const candidate = path.resolve(monthPath, fileName)
        if (!this.isSafeChild(root, candidate) || !this.isFile(candidate)) continue
        const filePath = fs.realpathSync(candidate)
        if (!this.isSafeChild(root, filePath)) continue
        files.push({ filePath, fileName, month, mtimeMs: this.mtimeMs(filePath) })
      }
    }
    this.index = { root, files }
    return files
  }

  private isDirectory(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isDirectory()
    } catch {
      return false
    }
  }

  private isFile(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isFile()
    } catch {
      return false
    }
  }

  private mtimeMs(filePath: string): number {
    try {
      return fs.statSync(filePath).mtimeMs
    } catch {
      return 0
    }
  }
}
