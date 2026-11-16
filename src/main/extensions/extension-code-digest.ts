import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 与安装器的排除规则保持一致：这些目录不属于扩展产物。 */
const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv'
])

const DEFAULT_IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db'])
const IGNORED_EXTENSIONS = new Set(['.pyc', '.log'])

export interface CodeDigestOptions {
  ignoreDirectories?: Iterable<string>
  ignoreFiles?: Iterable<string>
}

interface DigestEntry {
  path: string
  sha256: string
}

/**
 * 计算一个目录的代码指纹。
 *
 * 只覆盖**代码与静态资源**：不包含 `extensions-data`、日志或缓存，
 * 所以用户改配置不会让指纹变化，改一行 JS 就会。
 *
 * 细则：
 * - 相对路径参与哈希，因此改名与改内容都能被发现；
 * - 文件按路径排序后再累加，结果与遍历顺序无关；
 * - 符号链接按链接目标字符串参与哈希，不跟随（避免读到宿主私有文件）。
 */
export function computeDirectoryDigest(root: string, options: CodeDigestOptions = {}): string {
  const ignoreDirectories = new Set([
    ...DEFAULT_IGNORED_DIRECTORIES,
    ...(options.ignoreDirectories ?? [])
  ])
  const ignoreFiles = new Set([...DEFAULT_IGNORED_FILES, ...(options.ignoreFiles ?? [])])
  const entries: DigestEntry[] = []

  const walk = (directory: string, prefix: string): void => {
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.isDirectory()) {
        if (ignoreDirectories.has(item.name)) continue
        walk(path.join(directory, item.name), prefix ? `${prefix}/${item.name}` : item.name)
        continue
      }
      if (ignoreFiles.has(item.name)) continue
      if (IGNORED_EXTENSIONS.has(path.extname(item.name).toLowerCase())) continue

      const relative = prefix ? `${prefix}/${item.name}` : item.name
      const absolute = path.join(directory, item.name)
      if (item.isSymbolicLink()) {
        try {
          const target = fs.readlinkSync(absolute)
          entries.push({
            path: relative,
            sha256: createHash('sha256').update(`link:${target}`).digest('hex')
          })
        } catch {
          entries.push({ path: relative, sha256: 'link:unreadable' })
        }
        continue
      }
      if (!item.isFile()) continue
      try {
        const content = fs.readFileSync(absolute)
        entries.push({
          path: relative,
          sha256: createHash('sha256').update(content).digest('hex')
        })
      } catch {
        // 读不到的文件不应让整个指纹失效，但必须留下痕迹。
        entries.push({ path: relative, sha256: 'unreadable' })
      }
    }
  }

  walk(root, '')
  entries.sort((left, right) => left.path.localeCompare(right.path))
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.sha256}\n`)
  }
  return hash.digest('hex')
}

/** 列出参与指纹的文件数量；用于诊断「是不是把缓存算进去了」。 */
export function countDigestFiles(root: string): number {
  let count = 0
  const walk = (directory: string): void => {
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.isDirectory()) {
        if (DEFAULT_IGNORED_DIRECTORIES.has(item.name)) continue
        walk(path.join(directory, item.name))
        continue
      }
      if (DEFAULT_IGNORED_FILES.has(item.name)) continue
      if (IGNORED_EXTENSIONS.has(path.extname(item.name).toLowerCase())) continue
      count += 1
    }
  }
  walk(root)
  return count
}
