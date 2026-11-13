import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExtensionPaths } from '../../src/main/extensions/extension-paths'
import { ExtensionRegistry } from '../../src/main/extensions/extension-registry'
import { ExtensionInstaller } from '../../src/main/extensions/extension-installer'

const MANIFEST = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  manifestVersion: 1,
  id: 'com.example.fixture',
  name: 'Fixture',
  version: '1.0.0',
  apiVersion: '1',
  minAppVersion: '2.6.0',
  permissions: ['storage'],
  entrypoints: { page: 'ui/index.html', background: 'background/index.js' },
  contributions: { pages: [{ id: 'settings', title: '设置' }] },
  ...overrides
})

const roots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-extension-installer-'))
  roots.push(root)
  return root
}

function createExtensionSource(root: string, overrides: Record<string, unknown> = {}): string {
  const parent = fs.mkdtempSync(path.join(root, 'source-'))
  const source = path.join(parent, 'extension')
  fs.ensureDirSync(path.join(source, 'ui'))
  fs.ensureDirSync(path.join(source, 'background'))
  fs.writeJsonSync(path.join(source, 'manifest.json'), MANIFEST(overrides))
  fs.writeFileSync(path.join(source, 'ui', 'index.html'), '<!doctype html><title>fixture</title>')
  fs.writeFileSync(path.join(source, 'background', 'index.js'), 'module.exports = function(){}')
  return source
}

function setup(): {
  paths: ReturnType<typeof createExtensionPaths>
  registry: ExtensionRegistry
  installer: ExtensionInstaller
} {
  const root = tempRoot()
  const paths = createExtensionPaths(root)
  const registry = new ExtensionRegistry({ registryFile: paths.registryFile })
  const installer = new ExtensionInstaller({ paths, registry })
  return { paths, registry, installer }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
})

describe('extension installer', () => {
  it('安装目录后登记为未启用，代码位于 extensions/<id>', async () => {
    const { paths, registry, installer } = setup()
    const source = createExtensionSource(path.dirname(paths.userData))
    const outcome = await installer.installFromDirectory(source, { appVersion: '2.6.0' })
    expect(outcome.upgraded).toBe(false)
    expect(fs.existsSync(path.join(paths.installDir('com.example.fixture'), 'manifest.json'))).toBe(
      true
    )
    const record = registry.get('com.example.fixture')
    expect(record?.enabled).toBe(false)
    expect(record?.grantedPermissions).toEqual([])
  })

  it('升级保留启用状态与授权，不改动数据目录', async () => {
    const { paths, registry, installer } = setup()
    const root = path.dirname(paths.userData)
    const first = createExtensionSource(root)
    await installer.installFromDirectory(first, { appVersion: '2.6.0' })
    registry.setEnabled('com.example.fixture', true)
    registry.setGrantedPermissions('com.example.fixture', ['storage', 'messages.subscribe'])
    fs.ensureDirSync(paths.extensionDataDir('com.example.fixture'))
    fs.writeJsonSync(path.join(paths.extensionDataDir('com.example.fixture'), 'storage.json'), {
      version: 1,
      values: { greeting: '保留我' }
    })

    const second = path.join(root, 'source-v2')
    fs.copySync(first, second)
    fs.writeJsonSync(path.join(second, 'manifest.json'), MANIFEST({ version: '1.2.0' }))
    const outcome = await installer.installFromDirectory(second, { appVersion: '2.6.0' })
    expect(outcome.upgraded).toBe(true)
    expect(outcome.previousVersion).toBe('1.0.0')
    const record = registry.get('com.example.fixture')
    expect(record?.version).toBe('1.2.0')
    expect(record?.enabled).toBe(true)
    expect(record?.grantedPermissions).toEqual(['storage', 'messages.subscribe'])
    expect(
      fs.readJsonSync(path.join(paths.extensionDataDir('com.example.fixture'), 'storage.json'))
        .values.greeting
    ).toBe('保留我')
  })

  it('卸载默认保留数据，选择清除时一并删除', async () => {
    const { paths, registry, installer } = setup()
    const source = createExtensionSource(path.dirname(paths.userData))
    await installer.installFromDirectory(source, { appVersion: '2.6.0' })
    fs.ensureDirSync(paths.extensionDataDir('com.example.fixture'))
    fs.writeFileSync(path.join(paths.extensionDataDir('com.example.fixture'), 'keep.txt'), 'x')

    await installer.uninstall('com.example.fixture', { keepData: true })
    expect(fs.existsSync(paths.installDir('com.example.fixture'))).toBe(false)
    expect(fs.existsSync(paths.extensionDataDir('com.example.fixture'))).toBe(true)
    expect(registry.get('com.example.fixture')).toBeUndefined()

    await installer.uninstall('com.example.fixture', { keepData: false })
    expect(fs.existsSync(paths.extensionDataDir('com.example.fixture'))).toBe(false)
  })

  it('拒绝符号链接，且不留下半装目录', async () => {
    const { paths, installer } = setup()
    const source = createExtensionSource(path.dirname(paths.userData))
    fs.symlinkSync('/etc/hosts', path.join(source, 'ui', 'link.html'))
    await expect(
      installer.installFromDirectory(source, { appVersion: '2.6.0' })
    ).rejects.toMatchObject({
      code: 'EXTENSION_INVALID_PATH'
    })
    expect(fs.existsSync(paths.installDir('com.example.fixture'))).toBe(false)
    expect(fs.existsSync(paths.stagingDir) ? fs.readdirSync(paths.stagingDir) : []).toEqual([])
  })

  it('入口文件缺失时拒绝安装', async () => {
    const { installer } = setup()
    const root = tempRoot()
    const source = createExtensionSource(root)
    fs.removeSync(path.join(source, 'background', 'index.js'))
    await expect(
      installer.installFromDirectory(source, { appVersion: '2.6.0' })
    ).rejects.toMatchObject({
      code: 'EXTENSION_INVALID_MANIFEST'
    })
  })

  it('ZIP 条目穿越时拒绝，且不会写到扩展目录之外', async () => {
    const { paths, installer } = setup()
    const zipPath = path.join(tempRoot(), 'evil.zip')
    fs.writeFileSync(
      zipPath,
      buildZip([
        { name: 'manifest.json', data: JSON.stringify(MANIFEST()) },
        { name: 'ui/index.html', data: '<!doctype html>' },
        { name: 'background/index.js', data: 'module.exports=()=>{}' },
        { name: '../escaped.txt', data: 'escaped' }
      ])
    )
    await expect(
      installer.installFromPackage(zipPath, { appVersion: '2.6.0' })
    ).rejects.toMatchObject({
      code: 'EXTENSION_INVALID_PATH'
    })
    expect(fs.existsSync(path.join(paths.userData, 'escaped.txt'))).toBe(false)
    expect(fs.existsSync(paths.installDir('com.example.fixture'))).toBe(false)
  })

  it('合法 ZIP 可安装', async () => {
    const { paths, installer } = setup()
    const zipPath = path.join(tempRoot(), 'fixture.zip')
    fs.writeFileSync(
      zipPath,
      buildZip([
        { name: 'manifest.json', data: JSON.stringify(MANIFEST()) },
        { name: 'ui/index.html', data: '<!doctype html>' },
        { name: 'background/index.js', data: 'module.exports=()=>{}' }
      ])
    )
    const outcome = await installer.installFromPackage(zipPath, { appVersion: '2.6.0' })
    expect(outcome.manifest.id).toBe('com.example.fixture')
    expect(
      fs.existsSync(path.join(paths.installDir('com.example.fixture'), 'ui', 'index.html'))
    ).toBe(true)
  })
})

/* 最小 ZIP 写入器：只支持 stored（无压缩）条目，用于构造非法路径样本。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(entries: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, end])
}
