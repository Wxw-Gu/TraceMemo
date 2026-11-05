import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 发送能力组件定位：读 current.json 找目录，按 manifest 校验 size/sha256，不过当没装。
 * 组件放用户目录，避免被自动更新清掉。
 */

export interface ComponentLocation {
  dir: string
  helperPath: string
  version: string
  /** 打包时工作区是否 dirty（内部调试构建标识，正式发布不应出现） */
  dirty: boolean
}

interface ManifestFile {
  path?: unknown
  size?: unknown
  sha256?: unknown
}

const HELPER_NAME = 'tm-wcdb-config-helper.exe'

const verifyCache = new Map<string, { stamp: string; ok: boolean; dirty: boolean }>()

function sha256File(filePath: string): string | null {
  try {
    const hash = crypto.createHash('sha256')
    hash.update(fs.readFileSync(filePath))
    return hash.digest('hex')
  } catch {
    return null
  }
}

function verifyManifest(dir: string): { ok: boolean; dirty: boolean } {
  const manifestPath = path.join(dir, 'manifest.json')
  let stat: fs.Stats
  try {
    stat = fs.statSync(manifestPath)
  } catch {
    return { ok: false, dirty: false }
  }
  const stamp = `${dir}|${stat.mtimeMs}|${stat.size}`
  const cached = verifyCache.get(dir)
  if (cached && cached.stamp === stamp) return { ok: cached.ok, dirty: cached.dirty }

  let ok = false
  let dirty = false
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      worktreeDirty?: unknown
      files?: ManifestFile[]
    }
    dirty = manifest.worktreeDirty === true
    const files = Array.isArray(manifest.files) ? manifest.files : []
    if (files.length === 0) {
      ok = false
    } else {
      ok = files.every((entry) => {
        const name = typeof entry.path === 'string' ? entry.path : ''
        if (!name) return false
        const target = path.join(dir, name)
        let size = -1
        try {
          size = fs.statSync(target).size
        } catch {
          return false
        }
        if (typeof entry.size === 'number' && size !== entry.size) return false
        if (typeof entry.sha256 === 'string' && entry.sha256.length === 64) {
          return sha256File(target) === entry.sha256
        }
        return true
      })
    }
  } catch {
    ok = false
  }
  verifyCache.set(dir, { stamp, ok, dirty })
  return { ok, dirty }
}

/**
 * 返回发送能力组件位置；不存在、校验失败、非 Windows 一律返回 null。
 * 调用方拿到 null 时应当把它当作「组件没装」，而不是「没授权」。
 */
export function resolveExternalComponent(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ComponentLocation | null {
  if (platform !== 'win32') return null
  const localAppData = env.LOCALAPPDATA
  if (!localAppData) return null

  const root = path.join(localAppData, 'TraceMemo', 'Pro', 'windows-x64')
  const pointerPath = path.join(root, 'current.json')
  if (!fs.existsSync(pointerPath)) return null

  let version = ''
  let dir = ''
  try {
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as {
      version?: unknown
      dir?: unknown
    }
    version = typeof pointer.version === 'string' ? pointer.version : ''
    dir = typeof pointer.dir === 'string' ? pointer.dir : ''
  } catch {
    return null
  }
  if (!version || !dir) return null
  try {
    if (!fs.statSync(dir).isDirectory()) return null
  } catch {
    return null
  }

  const helperPath = path.join(dir, HELPER_NAME)
  if (!fs.existsSync(helperPath)) return null

  const verified = verifyManifest(dir)
  if (!verified.ok) return null

  return { dir, helperPath, version, dirty: verified.dirty }
}

/** 测试用：清掉校验缓存 */
export function resetComponentCache(): void {
  verifyCache.clear()
}
