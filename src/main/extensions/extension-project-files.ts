import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { Open } from 'unzipper'
import { ExtensionError } from '../../shared/extensions/errors'
import { isSafeRelativeEntryPath } from '../../shared/extensions/manifest'
import { isPathInside } from './extension-paths'

const MAX_FILES = 2_000
const MAX_TOTAL_BYTES = 50 * 1024 * 1024

/** 与安装器 / 指纹一致的排除规则：这些不属于扩展源码。 */
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv'
])
const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db'])
const EXCLUDED_EXTENSIONS = new Set(['.pyc', '.log'])

/** 会被替换扩展 id 的文本文件类型。 */
const TEXT_FILE_PATTERN = /\.(js|mjs|cjs|ts|tsx|jsx|html|htm|css|json)$/i

export interface CreateProjectInput {
  zipPath: string
  targetDir: string
  /** 新扩展 id（必须与模板里的旧 id 不同）。 */
  extensionId: string
  /** 模板里的旧 id；用于替换代码中的身份引用。 */
  templateExtensionId: string
  name?: string
}

export interface CreateProjectOutcome {
  projectPath: string
  rewrittenFiles: string[]
}

/**
 * 目标目录必须是「不存在」或「空目录」。
 *
 * 这条检查在复制之前做，避免中途发现冲突时已经写了一半。
 */
export async function assertUsableTarget(targetDir: string): Promise<string> {
  const resolved = path.resolve(targetDir)
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isDirectory()) {
      throw new ExtensionError('EXTENSION_PROJECT_EXISTS', '目标路径已存在且不是目录')
    }
    const entries = await fs.readdir(resolved)
    if (entries.length > 0) {
      throw new ExtensionError('EXTENSION_PROJECT_EXISTS', '目标目录不是空目录，未写入任何文件')
    }
  } catch (error) {
    if (error instanceof ExtensionError) throw error
    const code = (error as { code?: string }).code
    if (code !== 'ENOENT') {
      throw new ExtensionError('EXTENSION_PROJECT_EXISTS', '目标目录不可用')
    }
  }
  return resolved
}

/** 在目标旁边建暂存目录：同一磁盘才能用 rename 原子落位。 */
async function createStaging(parent: string): Promise<string> {
  await fs.mkdir(parent, { recursive: true })
  return fs.mkdtemp(path.join(parent, '.tm-project-'))
}

async function cleanup(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
}

function shouldSkipFile(name: string): boolean {
  return EXCLUDED_FILES.has(name) || EXCLUDED_EXTENSIONS.has(path.extname(name).toLowerCase())
}

/** 解压到暂存目录；条目路径逐条校验，拒绝穿越与非法字符。 */
async function extractZip(zipPath: string, staging: string): Promise<void> {
  let archive: Awaited<ReturnType<typeof Open.file>>
  try {
    archive = await Open.file(zipPath)
  } catch {
    throw new ExtensionError('EXTENSION_INSTALL_FAILED', '模板压缩包无法读取')
  }

  let files = 0
  let total = 0
  for (const entry of archive.files) {
    const relative = String(entry.path || '').replace(/\\/g, '/')
    if (entry.type === 'Directory') continue
    if (!isSafeRelativeEntryPath(relative)) {
      throw new ExtensionError('EXTENSION_INVALID_PATH', `模板条目路径不合法：${relative}`)
    }
    const size = Number(entry.uncompressedSize || 0)
    total += size
    if (total > MAX_TOTAL_BYTES) {
      throw new ExtensionError('EXTENSION_INSTALL_FAILED', '模板解压后体积超过限制')
    }
    files += 1
    if (files > MAX_FILES) {
      throw new ExtensionError('EXTENSION_INSTALL_FAILED', '模板文件数量超过限制')
    }

    const destination = path.resolve(staging, relative)
    if (!isPathInside(staging, destination)) {
      throw new ExtensionError('EXTENSION_INVALID_PATH', `模板条目越界：${relative}`)
    }
    await fs.mkdir(path.dirname(destination), { recursive: true })
    const content = await entry.buffer()
    await fs.writeFile(destination, content)
  }
  if (!files) throw new ExtensionError('EXTENSION_INSTALL_FAILED', '模板压缩包是空的')
}

async function listTextFiles(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  const items = await fs.readdir(path.join(root, prefix), { withFileTypes: true })
  for (const item of items) {
    if (item.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(item.name)) continue
      const nested = prefix ? `${prefix}/${item.name}` : item.name
      result.push(...(await listTextFiles(root, nested)))
      continue
    }
    if (shouldSkipFile(item.name)) continue
    const relative = prefix ? `${prefix}/${item.name}` : item.name
    if (!TEXT_FILE_PATTERN.test(relative)) continue
    result.push(relative)
  }
  return result.sort()
}

/**
 * 把代码里的扩展身份改成新 id。
 *
 * 只替换精确字符串：模板示例里 id 至少出现在 manifest 与页面桥的
 * `EXTENSION_ID` 常量中，漏掉任何一处都会让页面桥失联。
 */
export async function rewriteExtensionIdentity(
  root: string,
  oldId: string,
  newId: string,
  name?: string
): Promise<string[]> {
  const rewritten: string[] = []
  const manifestPath = path.join(root, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>
  if (String(manifest.id) !== oldId) {
    throw new ExtensionError(
      'EXTENSION_INVALID_MANIFEST',
      `模板 manifest.id 与索引不一致（${String(manifest.id)}）`
    )
  }
  manifest.id = newId
  if (name) manifest.name = name
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  for (const relative of await listTextFiles(root)) {
    if (relative === 'manifest.json') continue
    const full = path.join(root, relative)
    const text = await fs.readFile(full, 'utf8')
    if (!text.includes(oldId)) continue
    await fs.writeFile(full, text.split(oldId).join(newId), 'utf8')
    rewritten.push(relative)
  }
  return rewritten
}

/** 生成后自检：任何残留的旧 id 都意味着页面桥或后台仍指向模板身份。 */
export async function assertNoIdentityLeftover(root: string, oldId: string): Promise<void> {
  for (const relative of await listTextFiles(root)) {
    const text = await fs.readFile(path.join(root, relative), 'utf8')
    if (text.includes(oldId)) {
      throw new ExtensionError(
        'EXTENSION_INVALID_MANIFEST',
        `生成的项目里仍残留旧扩展 id：${relative}`
      )
    }
  }
}

/** 从模板 ZIP 生成独立项目；全过程在暂存目录完成，成功后才落位。 */
export async function createProjectFromTemplate(
  input: CreateProjectInput
): Promise<CreateProjectOutcome> {
  const target = await assertUsableTarget(input.targetDir)
  if (input.extensionId === input.templateExtensionId) {
    throw new ExtensionError('INVALID_REQUEST', '新项目必须使用不同的扩展 id')
  }

  const staging = await createStaging(path.dirname(target))
  try {
    await extractZip(input.zipPath, staging)
    const rewritten = await rewriteExtensionIdentity(
      staging,
      input.templateExtensionId,
      input.extensionId,
      input.name
    )
    await assertNoIdentityLeftover(staging, input.templateExtensionId)
    await fs.rename(staging, target)
    return { projectPath: target, rewrittenFiles: rewritten }
  } catch (error) {
    await cleanup(staging)
    throw error
  }
}

/** 把已安装副本整体复制成外部项目（保留用户改过的代码）。 */
export async function exportInstalledCopy(
  sourceDir: string,
  targetDir: string
): Promise<{ projectPath: string }> {
  if (!existsSync(path.join(sourceDir, 'manifest.json'))) {
    throw new ExtensionError('EXTENSION_INVALID_MANIFEST', '安装副本不完整，无法导出')
  }
  const target = await assertUsableTarget(targetDir)
  const staging = await createStaging(path.dirname(target))
  try {
    await fs.cp(sourceDir, staging, {
      recursive: true,
      filter: (source) => {
        const name = path.basename(source)
        if (EXCLUDED_DIRECTORIES.has(name)) return false
        if (shouldSkipFile(name)) return false
        return true
      }
    })
    // 复制结果必须仍然可读，否则宁可失败也不留一个半成品项目。
    await fs.access(path.join(staging, 'manifest.json'))
    await fs.rename(staging, target)
    return { projectPath: target }
  } catch (error) {
    await cleanup(staging)
    throw error
  }
}
