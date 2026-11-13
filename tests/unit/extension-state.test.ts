import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExtensionPaths, isPathInside } from '../../src/main/extensions/extension-paths'
import { ExtensionRegistry } from '../../src/main/extensions/extension-registry'
import { ExtensionStorage } from '../../src/main/extensions/extension-storage'
import { ExtensionLogStore } from '../../src/main/extensions/extension-log'

const roots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-extension-state-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
})

describe('extension paths', () => {
  it('三段目录彼此分离且都在 userData 下', () => {
    const paths = createExtensionPaths('/tmp/user-data')
    expect(paths.extensionsDir).toBe(path.join('/tmp/user-data', 'extensions'))
    expect(paths.extensionDataDir('com.example.a')).toBe(
      path.join('/tmp/user-data', 'extensions-data', 'com.example.a')
    )
    expect(paths.registryFile).toBe(
      path.join('/tmp/user-data', 'extensions-state', 'registry.json')
    )
    expect(isPathInside(paths.extensionsDir, path.join(paths.extensionsDir, 'a'))).toBe(true)
    expect(isPathInside(paths.extensionsDir, 'a/../../etc')).toBe(false)
  })
})

describe('extension registry', () => {
  it('持久化启用状态与授权，重启后仍可读', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    const first = new ExtensionRegistry({ registryFile })
    first.upsert({
      id: 'com.example.a',
      version: '1.0.0',
      apiVersion: '1',
      enabled: true,
      grantedPermissions: ['storage', 'messages.subscribe'],
      installedAt: 1,
      updatedAt: 2,
      source: 'directory'
    })
    const second = new ExtensionRegistry({ registryFile })
    const record = second.get('com.example.a')
    expect(record?.enabled).toBe(true)
    expect(record?.grantedPermissions).toEqual(['storage', 'messages.subscribe'])
  })

  it('文件损坏时按未安装处理，不抛异常', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    fs.ensureDirSync(root)
    fs.writeFileSync(registryFile, '{broken', 'utf8')
    const registry = new ExtensionRegistry({ registryFile })
    expect(registry.list()).toEqual([])
  })
})

describe('extension storage', () => {
  it('按扩展隔离键空间并支持删除', () => {
    const root = tempRoot()
    const storage = new ExtensionStorage({ dataRoot: root })
    storage.set('com.example.a', 'greeting', '你好')
    storage.set('com.example.b', 'greeting', 'hello')
    expect(storage.get('com.example.a', 'greeting')).toBe('你好')
    expect(storage.get('com.example.b', 'greeting')).toBe('hello')
    expect(storage.remove('com.example.a', 'greeting')).toBe(true)
    expect(storage.get('com.example.a', 'greeting')).toBeUndefined()
  })

  it('拒绝非法键与不可序列化的值', () => {
    const storage = new ExtensionStorage({ dataRoot: tempRoot() })
    expect(() => storage.set('com.example.a', '../escape', 1)).toThrowError(/存储键/)
    expect(() => storage.set('com.example.a', 'fn', () => undefined)).toThrowError(/JSON/)
  })

  it('单值超限时拒绝而不是截断', () => {
    const storage = new ExtensionStorage({ dataRoot: tempRoot(), maxValueBytes: 32 })
    expect(() => storage.set('com.example.a', 'big', 'x'.repeat(64))).toThrowError(/上限/)
  })
})

describe('extension log store', () => {
  it('落盘后可被新的实例读回，并按数量截断', () => {
    const root = tempRoot()
    const first = new ExtensionLogStore(root)
    for (let index = 0; index < 5; index += 1) {
      first.append('com.example.a', 'info', 'extension', `line-${index}`)
    }
    const second = new ExtensionLogStore(root)
    const entries = second.list('com.example.a', 10)
    expect(entries).toHaveLength(5)
    expect(entries[0].message).toBe('line-4')
  })

  it('清洗控制字符并截断超长日志', () => {
    const store = new ExtensionLogStore(tempRoot())
    const entry = store.append('com.example.a', 'warn', 'extension', `a\u0000b${'x'.repeat(800)}`)
    expect(entry.message).not.toContain('\u0000')
    expect(entry.message.length).toBeLessThanOrEqual(501)
  })
})
