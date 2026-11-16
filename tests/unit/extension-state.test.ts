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

  it('文件不存在是合法空状态，可以直接写入', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    const registry = new ExtensionRegistry({ registryFile })
    expect(registry.getHealth().state).toBe('ok')
    registry.upsert({
      id: 'com.example.a',
      version: '1.0.0',
      apiVersion: '1',
      enabled: false,
      grantedPermissions: [],
      installedAt: 1,
      updatedAt: 1,
      source: 'directory'
    })
    expect(fs.existsSync(registryFile)).toBe(true)
  })

  it('主文件损坏时从备份恢复，并把损坏现场另存', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    const seed = new ExtensionRegistry({ registryFile })
    seed.upsert(record('com.example.a', { enabled: true, grantedPermissions: ['storage'] }))
    // 再写一次，让上一版内容进入备份；备份天然落后一版。
    seed.upsert(record('com.example.b'))
    expect(
      JSON.parse(fs.readFileSync(`${registryFile}.bak`, 'utf8')).extensions.map(
        (item: { id: string }) => item.id
      )
    ).toEqual(['com.example.a'])

    fs.writeFileSync(registryFile, '{"version":1,"extensions":[{"id":"com.example.a"', 'utf8')

    const recovered = new ExtensionRegistry({ registryFile })
    const health = recovered.getHealth()
    expect(health.state).toBe('recovered-from-backup')
    expect(health.corruptFile).toBeTruthy()
    // 恢复到备份那一版：最后一次写入丢失；启用状态与授权按安全策略收回。
    expect(recovered.list().map((item) => item.id)).toEqual(['com.example.a'])
    expect(recovered.get('com.example.a')?.enabled).toBe(false)
    expect(recovered.get('com.example.a')?.grantedPermissions).toEqual([])
    // 主文件应已被备份内容修好。
    expect(() => JSON.parse(fs.readFileSync(registryFile, 'utf8'))).not.toThrow()
    const corruptFiles = fs.readdirSync(root).filter((name) => name.includes('.corrupt-'))
    expect(corruptFiles).toHaveLength(1)
    expect(fs.readFileSync(path.join(root, corruptFiles[0]), 'utf8')).toContain('com.example.a')
  })

  it('恢复后继续写入，备份里不会出现损坏内容', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    const seed = new ExtensionRegistry({ registryFile })
    seed.upsert(record('com.example.a', { enabled: true }))
    seed.upsert(record('com.example.b'))

    fs.writeFileSync(registryFile, 'not-json', 'utf8')
    const recovered = new ExtensionRegistry({ registryFile })
    recovered.upsert(record('com.example.c'))

    const backupText = fs.readFileSync(`${registryFile}.bak`, 'utf8')
    expect(backupText).not.toContain('not-json')
    expect(() => JSON.parse(backupText)).not.toThrow()
    expect(JSON.parse(backupText).extensions.map((item: { id: string }) => item.id)).not.toContain(
      'com.example.c'
    )
  })

  it('主文件与备份都损坏时按目录扫描重建，且全部为未启用无授权', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    fs.ensureDirSync(root)
    fs.writeFileSync(registryFile, 'broken', 'utf8')
    fs.writeFileSync(`${registryFile}.bak`, 'also-broken', 'utf8')

    const recoveryCalls: number[] = []
    const registry = new ExtensionRegistry({
      registryFile,
      recover: () => {
        recoveryCalls.push(1)
        return [
          record('com.example.a', { enabled: true, grantedPermissions: ['wechat.send.text'] }),
          record('com.example.b', { enabled: true, grantedPermissions: ['storage'] })
        ]
      }
    })

    const list = registry.list()
    expect(recoveryCalls).toHaveLength(1)
    expect(registry.getHealth().state).toBe('recovered-by-scan')
    expect(list).toHaveLength(2)
    for (const item of list) {
      expect(item.enabled).toBe(false)
      expect(item.grantedPermissions).toEqual([])
    }
  })

  it('主文件与备份都损坏且没有重建来源时拒绝写入，保留现场', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    fs.ensureDirSync(root)
    fs.writeFileSync(registryFile, 'broken', 'utf8')
    fs.writeFileSync(`${registryFile}.bak`, 'also-broken', 'utf8')

    const registry = new ExtensionRegistry({ registryFile })
    expect(registry.getHealth().state).toBe('unreadable')
    expect(registry.list()).toEqual([])
    expect(() => registry.upsert(record('com.example.a'))).toThrowError(/损坏/)

    // 现场必须还在：损坏原文不能被空状态覆盖。
    expect(fs.readFileSync(registryFile, 'utf8')).toBe('broken')
    expect(
      fs.readdirSync(root).filter((name) => name.includes('.corrupt-')).length
    ).toBeGreaterThanOrEqual(1)
  })

  it('结构合法但记录不合法的文件按损坏处理', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    fs.ensureDirSync(root)
    fs.writeJsonSync(registryFile, {
      version: 1,
      extensions: [{ id: 'not a valid id', version: '1.0.0' }]
    })
    const registry = new ExtensionRegistry({ registryFile })
    expect(registry.list()).toEqual([])
    expect(registry.getHealth().state).toBe('unreadable')
  })

  it('写入失败时内存状态回滚，不留下半写的主文件', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    const seed = new ExtensionRegistry({ registryFile })
    seed.upsert(record('com.example.a'))

    const before = fs.readFileSync(registryFile, 'utf8')
    // 用同名的目录占住临时文件路径，让 writeFileSync 必然失败。
    fs.mkdirSync(`${registryFile}.tmp`)

    const broken = new ExtensionRegistry({ registryFile })
    expect(() => broken.upsert(record('com.example.b'))).toThrow()
    expect(broken.list().map((item) => item.id)).toEqual(['com.example.a'])
    expect(fs.readFileSync(registryFile, 'utf8')).toBe(before)
  })

  it('从旧备份恢复时一律降级为未启用、无授权', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    const seed = new ExtensionRegistry({ registryFile })
    seed.upsert(
      record('com.example.a', { enabled: true, grantedPermissions: ['wechat.send.text'] })
    )
    seed.upsert(record('com.example.b', { enabled: true, grantedPermissions: ['storage'] }))

    fs.writeFileSync(registryFile, '{broken', 'utf8')

    const recovered = new ExtensionRegistry({ registryFile })
    expect(recovered.getHealth().state).toBe('recovered-from-backup')
    // 备份里是 enabled=true + 发送权限，恢复后必须全部收回。
    for (const item of recovered.list()) {
      expect(item.enabled).toBe(false)
      expect(item.grantedPermissions).toEqual([])
      // 身份与版本保留，配置目录不受影响。
      expect(item.version).toBe('1.0.0')
    }
  })

  it('恢复标记持久化，重启后仍然提示', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    const seed = new ExtensionRegistry({ registryFile })
    seed.upsert(record('com.example.a', { enabled: true }))
    seed.upsert(record('com.example.b'))
    fs.writeFileSync(registryFile, '{broken', 'utf8')

    const first = new ExtensionRegistry({ registryFile })
    expect(first.getHealth().state).toBe('recovered-from-backup')

    // 重新构造实例等价于重启软件：提示不能消失。
    const second = new ExtensionRegistry({ registryFile })
    expect(second.getHealth().state).toBe('recovered-from-backup')
    expect(second.get('com.example.a')?.enabled).toBe(false)

    expect(second.acknowledgeRecovery()).toBe(true)
    expect(second.getHealth().state).toBe('ok')
    const third = new ExtensionRegistry({ registryFile })
    expect(third.getHealth().state).toBe('ok')
  })

  it('恢复后用户重新启用的扩展不会被下一次重启自动恢复成启用', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    const seed = new ExtensionRegistry({ registryFile })
    seed.upsert(record('com.example.a', { enabled: true }))
    seed.upsert(record('com.example.b'))
    // 再写一次，让备份里同时包含 a 与 b（备份天然落后一版）。
    seed.upsert(record('com.example.c'))
    fs.writeFileSync(registryFile, '{broken', 'utf8')

    const recovered = new ExtensionRegistry({ registryFile })
    recovered.setEnabled('com.example.a', true)
    // 用户只启用了 a，b 保持停用；恢复提示仍在。
    expect(recovered.getHealth().state).toBe('recovered-from-backup')

    const restarted = new ExtensionRegistry({ registryFile })
    expect(restarted.get('com.example.a')?.enabled).toBe(true)
    expect(restarted.get('com.example.b')?.enabled).toBe(false)
  })

  it('未发生损坏时旧用户的启用状态与授权原样保留', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    const seed = new ExtensionRegistry({ registryFile })
    seed.upsert(
      record('com.example.a', { enabled: true, grantedPermissions: ['wechat.send.text'] })
    )

    const restarted = new ExtensionRegistry({ registryFile })
    expect(restarted.getHealth().state).toBe('ok')
    expect(restarted.get('com.example.a')?.enabled).toBe(true)
    expect(restarted.get('com.example.a')?.grantedPermissions).toEqual(['wechat.send.text'])
  })

  it('来源字段按白名单解析，未知值归为 directory', () => {
    const root = tempRoot()
    const registryFile = path.join(root, 'registry.json')
    fs.ensureDirSync(root)
    fs.writeJsonSync(registryFile, {
      version: 1,
      extensions: [
        {
          id: 'com.example.a',
          version: '1.0.0',
          apiVersion: '1',
          enabled: false,
          grantedPermissions: [],
          source: 'template',
          templateId: 'keyword-bot',
          templateVersion: '1.0.0'
        },
        {
          id: 'com.example.b',
          version: '1.0.0',
          apiVersion: '1',
          enabled: false,
          grantedPermissions: [],
          source: 'evil-source'
        }
      ]
    })
    const registry = new ExtensionRegistry({ registryFile })
    expect(registry.get('com.example.a')?.source).toBe('template')
    expect(registry.get('com.example.a')?.templateId).toBe('keyword-bot')
    expect(registry.get('com.example.b')?.source).toBe('directory')
  })
})

function record(
  id: string,
  overrides: Partial<{
    enabled: boolean
    grantedPermissions: Array<'storage' | 'messages.subscribe' | 'wechat.send.text'>
  }> = {}
): {
  id: string
  version: string
  apiVersion: string
  enabled: boolean
  grantedPermissions: Array<'storage' | 'messages.subscribe' | 'wechat.send.text'>
  installedAt: number
  updatedAt: number
  source: 'directory'
} {
  return {
    id,
    version: '1.0.0',
    apiVersion: '1',
    enabled: overrides.enabled ?? false,
    grantedPermissions: overrides.grantedPermissions ?? [],
    installedAt: 1,
    updatedAt: 1,
    source: 'directory'
  }
}

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

  it('20 条规则写入后换实例仍完整读回', () => {
    const dataRoot = tempRoot()
    const rules = Array.from({ length: 20 }, (_, index) => ({
      id: `rule-${index}`,
      keyword: `关键词${index}`,
      reply: `回复${index}`
    }))
    const first = new ExtensionStorage({ dataRoot })
    first.set('com.example.keyword-bot', 'rules', rules)

    const second = new ExtensionStorage({ dataRoot })
    expect(second.get('com.example.keyword-bot', 'rules')).toEqual(rules)
    expect(second.health('com.example.keyword-bot').state).toBe('ok')
  })

  it('主文件损坏时从备份恢复，20 条规则不丢', () => {
    const dataRoot = tempRoot()
    const rules = Array.from({ length: 20 }, (_, index) => ({ id: `rule-${index}` }))
    const first = new ExtensionStorage({ dataRoot })
    first.set('com.example.keyword-bot', 'rules', rules)
    // 再写一次，让含 20 条规则的内容进入备份。
    first.set('com.example.keyword-bot', 'enabled', true)

    const filePath = first.filePath('com.example.keyword-bot')
    fs.writeFileSync(filePath, '{"version":1,"values":{"rules":[', 'utf8')

    const recovered = new ExtensionStorage({ dataRoot })
    // 恢复后未确认前不给读：否则运行中的机器人会拿着旧配置继续回复。
    expect(() => recovered.get('com.example.keyword-bot', 'rules')).toThrowError(/确认/)
    expect(recovered.health('com.example.keyword-bot').state).toBe('recovered-from-backup')

    recovered.acknowledge('com.example.keyword-bot')
    expect(recovered.get('com.example.keyword-bot', 'rules')).toEqual(rules)

    const corruptFiles = fs
      .readdirSync(path.dirname(filePath))
      .filter((name) => name.includes('.corrupt-'))
    expect(corruptFiles).toHaveLength(1)
  })

  it('主文件与备份都损坏时停止写入并保留现场', () => {
    const dataRoot = tempRoot()
    const storage = new ExtensionStorage({ dataRoot })
    storage.set('com.example.a', 'rules', [1, 2, 3])
    storage.set('com.example.a', 'enabled', true)

    const filePath = storage.filePath('com.example.a')
    fs.writeFileSync(filePath, 'broken', 'utf8')
    fs.writeFileSync(`${filePath}.bak`, 'also-broken', 'utf8')

    const broken = new ExtensionStorage({ dataRoot })
    expect(() => broken.get('com.example.a', 'rules')).toThrowError(/损坏/)
    expect(broken.health('com.example.a').state).toBe('unrecovered')
    // 未处理损坏状态时不允许写入，否则会把现场覆盖成空配置。
    expect(() => broken.set('com.example.a', 'enabled', false)).toThrowError(/损坏/)
    expect(fs.readFileSync(filePath, 'utf8')).toBe('broken')
  })

  it('重置后恢复可写，且损坏现场仍在', () => {
    const dataRoot = tempRoot()
    const storage = new ExtensionStorage({ dataRoot })
    storage.set('com.example.a', 'rules', [1])
    storage.set('com.example.a', 'enabled', true)

    const filePath = storage.filePath('com.example.a')
    fs.writeFileSync(filePath, 'broken', 'utf8')
    fs.writeFileSync(`${filePath}.bak`, 'also-broken', 'utf8')

    const broken = new ExtensionStorage({ dataRoot })
    expect(broken.health('com.example.a').state).toBe('unrecovered')
    broken.reset('com.example.a')
    expect(broken.health('com.example.a').state).toBe('ok')
    broken.set('com.example.a', 'enabled', true)
    expect(broken.get('com.example.a', 'enabled')).toBe(true)

    expect(
      fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes('.corrupt-'))
    ).not.toHaveLength(0)
  })

  it('一个扩展的损坏不影响另一个扩展', () => {
    const dataRoot = tempRoot()
    const storage = new ExtensionStorage({ dataRoot })
    storage.set('com.example.a', 'rules', ['a'])
    storage.set('com.example.b', 'rules', ['b'])

    fs.writeFileSync(storage.filePath('com.example.a'), 'broken', 'utf8')

    const next = new ExtensionStorage({ dataRoot })
    expect(next.health('com.example.a').state).toBe('unrecovered')
    expect(next.health('com.example.b').state).toBe('ok')
    expect(next.get('com.example.b', 'rules')).toEqual(['b'])
    expect(() => next.set('com.example.b', 'rules', ['b2'])).not.toThrow()
  })

  it('写入失败时旧配置保持完整', () => {
    const dataRoot = tempRoot()
    const storage = new ExtensionStorage({ dataRoot })
    storage.set('com.example.a', 'rules', ['原始规则'])

    const filePath = storage.filePath('com.example.a')
    const before = fs.readFileSync(filePath, 'utf8')
    // 同名目录占住临时文件路径。
    fs.mkdirSync(`${filePath}.tmp`)

    expect(() => storage.set('com.example.a', 'rules', ['新规则'])).toThrow()
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before)
    expect(new ExtensionStorage({ dataRoot }).get('com.example.a', 'rules')).toEqual(['原始规则'])
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
