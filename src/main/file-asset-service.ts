import { promises as fs } from 'fs'
import { basename, join } from 'path'

type FileMessage = {
  createTime?: number
  contentData?: {
    type?: string
    title?: string
    typeVal?: string
  }
}

export type ResolvedFileAsset = {
  path: string
  name: string
  size: number
}

const normalizeName = (value: string): string => value.normalize('NFC').toLocaleLowerCase()

async function resolveInDirectory(directory: string, fileName: string): Promise<string | null> {
  const direct = join(directory, fileName)
  try {
    if ((await fs.stat(direct)).isFile()) return direct
  } catch {
    // Fall back to normalized matching for files whose Unicode form changed on disk.
  }

  try {
    const expected = normalizeName(fileName)
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const match = entries.find((entry) => entry.isFile() && normalizeName(entry.name) === expected)
    return match ? join(directory, match.name) : null
  } catch {
    return null
  }
}

export class FileAssetService {
  private readonly fileRoot: string

  constructor(accountRoot: string) {
    this.fileRoot = join(accountRoot, 'msg', 'file')
  }

  async resolve(message: FileMessage): Promise<ResolvedFileAsset | null> {
    const rawName = message.contentData?.title?.trim()
    if (!rawName) return null
    const fileName = basename(rawName)
    const month = message.createTime
      ? new Date(message.createTime * 1000).toLocaleDateString('sv-SE').slice(0, 7)
      : ''

    if (month) {
      const path = await resolveInDirectory(join(this.fileRoot, month), fileName)
      if (path) {
        const stat = await fs.stat(path)
        return { path, name: fileName, size: stat.size }
      }
    }

    try {
      const monthDirectories = await fs.readdir(this.fileRoot, { withFileTypes: true })
      for (const entry of monthDirectories) {
        if (!entry.isDirectory() || entry.name === month) continue
        const path = await resolveInDirectory(join(this.fileRoot, entry.name), fileName)
        if (!path) continue
        const stat = await fs.stat(path)
        return { path, name: fileName, size: stat.size }
      }
    } catch {
      return null
    }

    return null
  }
}
