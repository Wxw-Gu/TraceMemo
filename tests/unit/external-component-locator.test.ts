import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  resetComponentCache,
  resolveExternalComponent
} from '../../src/main/services/external-component-locator'

/** 组件发现必须 fail-closed：指针/目录/哈希任一不对都当没装。 */

let tmpRoot = ''
let localAppData = ''

function writeFile(filePath: string, content: Buffer | string): Buffer {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
  fs.writeFileSync(filePath, buf)
  return buf
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function buildBundle(options: { dirty?: boolean; corruptHash?: boolean } = {}): string {
  const versionDir = path.join(localAppData, 'TraceMemo', 'Pro', 'windows-x64', '1.0.0')
  const wcdbApi = writeFile(path.join(versionDir, 'wcdb_api.dll'), Buffer.alloc(2048, 0x11))
  const wcdb = writeFile(path.join(versionDir, 'WCDB.dll'), Buffer.alloc(4096, 0x22))
  const helper = writeFile(path.join(versionDir, 'tm-wcdb-config-helper.exe'), Buffer.alloc(1024, 0x33))

  const manifest = {
    schemaVersion: 1,
    componentVersion: '1.0.0',
    worktreeDirty: options.dirty === true,
    files: [
      { path: 'wcdb_api.dll', size: wcdbApi.length, sha256: sha256(wcdbApi) },
      { path: 'WCDB.dll', size: wcdb.length, sha256: sha256(wcdb) },
      {
        path: 'tm-wcdb-config-helper.exe',
        size: helper.length,
        sha256: options.corruptHash ? 'a'.repeat(64) : sha256(helper)
      }
    ]
  }
  writeFile(path.join(versionDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFile(
    path.join(localAppData, 'TraceMemo', 'Pro', 'windows-x64', 'current.json'),
    JSON.stringify({ version: '1.0.0', dir: versionDir }, null, 2)
  )
  return versionDir
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-locator-'))
  localAppData = path.join(tmpRoot, 'LocalAppData')
  fs.mkdirSync(localAppData, { recursive: true })
  resetComponentCache()
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  resetComponentCache()
})

const env = (): NodeJS.ProcessEnv => ({ LOCALAPPDATA: localAppData })

describe('resolveExternalComponent', () => {
  it('没有 current.json 时返回 null（= 组件没装）', () => {
    expect(resolveExternalComponent(env(), 'win32')).toBeNull()
  })

  it('非 Windows 直接返回 null', () => {
    buildBundle()
    expect(resolveExternalComponent(env(), 'darwin')).toBeNull()
  })

  it('校验通过时返回 helper 路径与版本', () => {
    const dir = buildBundle()
    const found = resolveExternalComponent(env(), 'win32')
    expect(found).not.toBeNull()
    expect(found?.helperPath).toBe(path.join(dir, 'tm-wcdb-config-helper.exe'))
    expect(found?.version).toBe('1.0.0')
    expect(found?.dirty).toBe(false)
  })

  it('dirty 标记透传（内部调试构建）', () => {
    buildBundle({ dirty: true })
    expect(resolveExternalComponent(env(), 'win32')?.dirty).toBe(true)
  })

  it('哈希不符时当作没装（不能返回可疑路径）', () => {
    buildBundle({ corruptHash: true })
    expect(resolveExternalComponent(env(), 'win32')).toBeNull()
  })

  it('指针指向的目录不存在时返回 null', () => {
    writeFile(
      path.join(localAppData, 'TraceMemo', 'Pro', 'windows-x64', 'current.json'),
      JSON.stringify({ version: '1.0.0', dir: path.join(tmpRoot, 'gone') })
    )
    expect(resolveExternalComponent(env(), 'win32')).toBeNull()
  })

  it('manifest 缺失时返回 null', () => {
    const dir = buildBundle()
    fs.rmSync(path.join(dir, 'manifest.json'))
    expect(resolveExternalComponent(env(), 'win32')).toBeNull()
  })

  it('helper 缺失时返回 null', () => {
    const dir = buildBundle()
    fs.rmSync(path.join(dir, 'tm-wcdb-config-helper.exe'))
    resetComponentCache()
    expect(resolveExternalComponent(env(), 'win32')).toBeNull()
  })

  it('文件被替换后校验会重新计算（不吃旧缓存）', () => {
    const dir = buildBundle()
    expect(resolveExternalComponent(env(), 'win32')).not.toBeNull()

    /* 篡改 WCDB.dll 内容但不改 mtime 之外的东西：manifest mtime 变了就要重算 */
    const target = path.join(dir, 'WCDB.dll')
    fs.writeFileSync(target, Buffer.alloc(4096, 0x99))
    const manifestPath = path.join(dir, 'manifest.json')
    const stat = fs.statSync(manifestPath)
    fs.utimesSync(manifestPath, stat.atime, new Date(stat.mtimeMs + 5000))

    expect(resolveExternalComponent(env(), 'win32')).toBeNull()
  })
})
