import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionManager } from '../../src/main/extensions/extension-manager'
import { createExtensionPaths } from '../../src/main/extensions/extension-paths'
import type {
  ExtensionHostChild,
  ExtensionHostSpawnOptions
} from '../../src/main/extensions/extension-host'
import { EXTENSION_HOST_PROTOCOL_VERSION } from '../../src/shared/extensions/rpc'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'

type Listener = (...args: unknown[]) => void

class FakeChild implements ExtensionHostChild {
  readonly sent: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Listener[]>()
  activationOk = true
  /** 收到 shutdown 的瞬间触发，用于断言「停进程时磁盘还是旧版本」。 */
  onShutdown?: () => void

  send(message: unknown): void {
    const payload = message as Record<string, unknown>
    this.sent.push(payload)
    if (payload.type === 'activate') {
      queueMicrotask(() =>
        this.emit('message', {
          type: 'activated',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          ok: this.activationOk,
          ...(this.activationOk ? {} : { error: { code: 'ACTION_FAILED', message: 'boom' } })
        })
      )
    }
    if (payload.type === 'shutdown') {
      this.onShutdown?.()
      queueMicrotask(() => this.emit('exit', 0, null))
    }
  }

  kill(): void {
    this.emit('exit', 1, null)
  }

  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener as unknown as Listener)
    this.listeners.set(event, list)
  }

  once(event: string, listener: Listener): void {
    this.on(event as 'message', listener as (message: unknown) => void)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

const capability = {
  supported: true,
  ready: true,
  status: 'ready',
  capabilities: { text: true, image: true, video: true },
  senderStatus: {},
  message: '已就绪'
} as unknown as PersonalWechatSendCapability

const roots: string[] = []
let userData: string

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'com.example.tx-bot',
    name: '事务测试扩展',
    version: '1.0.0',
    apiVersion: '1',
    minAppVersion: '2.6.0',
    permissions: ['storage', 'contacts.list'],
    entrypoints: { page: 'ui/index.html', background: 'background/index.js' },
    contributions: { pages: [{ id: 'settings', title: '配置' }] },
    ...overrides
  }
}

function createSource(overrides: Record<string, unknown> = {}): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-extension-tx-src-'))
  roots.push(parent)
  const source = path.join(parent, 'extension')
  fs.ensureDirSync(path.join(source, 'ui'))
  fs.ensureDirSync(path.join(source, 'background'))
  fs.writeJsonSync(path.join(source, 'manifest.json'), manifest(overrides))
  fs.writeFileSync(path.join(source, 'ui', 'index.html'), '<!doctype html><title>tx</title>')
  fs.writeFileSync(path.join(source, 'background', 'index.js'), 'module.exports = () => {}')
  return source
}

function createManager(options: { failActivationAt?: number; failSpawnAt?: number } = {}): {
  manager: ExtensionManager
  paths: ReturnType<typeof createExtensionPaths>
  children: FakeChild[]
} {
  const paths = createExtensionPaths(userData)
  const children: FakeChild[] = []
  let attempts = 0
  const manager = new ExtensionManager({
    paths,
    appVersion: '2.6.0',
    secretCipher: {
      isAvailable: () => true,
      encrypt: (plain: string) => Buffer.from(plain, 'utf8'),
      decrypt: (payload: Buffer) => payload.toString('utf8')
    },

    spawn: (spawnOptions: ExtensionHostSpawnOptions) => {
      void spawnOptions
      attempts += 1
      if (options.failSpawnAt === attempts) throw new Error('spawn failed')
      const child = new FakeChild()
      if (options.failActivationAt === attempts) child.activationOk = false
      children.push(child)
      return child
    },
    getCapability: async () => capability,
    checkEntitlement: async () => ({ ok: true, message: '授权有效', source: 'mac_license' }),
    executeAction: async () => ({
      actionId: 'action-1',
      status: 'sent',
      decision: 'allow',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z'
    }),
    queryMessages: async () => [],
    listGroups: async () => [],
    aiChat: async () => ({ text: '' }),
    getAccountId: () => 'wxid_self',
    getSelfUsernames: () => ['wxid_self'],
    isDatabaseReady: () => true,
    now: () => 1_000
  })
  return { manager, paths, children }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-extension-tx-'))
  roots.push(userData)
})

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
})

// 全量并发时文件级调度会拖慢每个用例；这里只放宽超时，断言不变。
describe('扩展升级事务', { timeout: 20_000 }, () => {
  it('升级时先停旧 Host 再替换代码，随后启动新 Host', async () => {
    const { manager, paths, children } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.tx-bot', true)
    await tick()

    expect(children).toHaveLength(1)
    const previous = children[0]
    // 旧进程收到 shutdown 的那一刻，磁盘上必须还是旧版本：
    // 先换代码再停进程会在 Windows 上直接失败，在 POSIX 上让旧代码继续跑。
    let versionAtShutdown = ''
    previous.onShutdown = (): void => {
      versionAtShutdown = fs.readJsonSync(
        path.join(paths.installDir('com.example.tx-bot'), 'manifest.json')
      ).version as string
    }

    const upgraded = await manager.installFromDirectory(createSource({ version: '1.1.0' }))
    expect(upgraded.success).toBe(true)
    await tick()

    expect(versionAtShutdown).toBe('1.0.0')
    // 旧进程收到 shutdown，新进程重新拉起。
    expect(previous.sent.some((message) => message.type === 'shutdown')).toBe(true)
    expect(children).toHaveLength(2)
    expect(manager.get('com.example.tx-bot')?.version).toBe('1.1.0')
    expect(manager.get('com.example.tx-bot')?.runtime.state).toBe('active')
    expect(
      fs.readJsonSync(path.join(paths.installDir('com.example.tx-bot'), 'manifest.json')).version
    ).toBe('1.1.0')
  })

  it('新版本启动失败时回滚代码与状态，并恢复旧版本', async () => {
    const { manager, paths, children } = createManager({ failActivationAt: 2 })
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.tx-bot', true)
    await tick()
    expect(children).toHaveLength(1)

    const upgraded = await manager.installFromDirectory(createSource({ version: '1.1.0' }))
    await tick()

    expect(upgraded.success).toBe(false)
    expect(upgraded.error?.code).toBe('EXTENSION_INSTALL_FAILED')
    // 磁盘与 Registry 都回到 1.0.0。
    expect(
      fs.readJsonSync(path.join(paths.installDir('com.example.tx-bot'), 'manifest.json')).version
    ).toBe('1.0.0')
    expect(manager.get('com.example.tx-bot')?.version).toBe('1.0.0')
    expect(manager.get('com.example.tx-bot')?.enabled).toBe(true)
    // 回滚后旧版本被重新拉起（第三次 spawn）。
    expect(children.length).toBeGreaterThanOrEqual(3)
    expect(manager.get('com.example.tx-bot')?.runtime.state).toBe('active')
    // 不留下过渡备份。
    expect(fs.readdirSync(paths.extensionsDir).filter((name) => name.includes('.backup-'))).toEqual(
      []
    )
  })

  it('升级保留用户配置与启用状态', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.tx-bot', true)
    await manager.pageRequest('com.example.tx-bot', 'storage.set', {
      key: 'rules',
      value: [{ id: 'r1' }]
    })

    await manager.installFromDirectory(createSource({ version: '1.1.0' }))
    await tick()

    expect(
      (await manager.pageRequest('com.example.tx-bot', 'storage.get', { key: 'rules' })).result
    ).toEqual([{ id: 'r1' }])
    expect(manager.get('com.example.tx-bot')?.enabled).toBe(true)
    expect(
      fs.existsSync(path.join(paths.extensionDataDir('com.example.tx-bot'), 'storage.json'))
    ).toBe(true)
  })

  it('新版本新增的权限保持待授权，不会自动生效', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource({ permissions: ['storage', 'contacts.list'] }))
    await manager.setEnabled('com.example.tx-bot', true)

    await manager.installFromDirectory(
      createSource({
        version: '1.1.0',
        permissions: ['storage', 'contacts.list', 'wechat.send.text']
      })
    )
    await tick()

    const extension = manager.get('com.example.tx-bot')
    expect(extension?.grantedPermissions).not.toContain('wechat.send.text')
    expect(extension?.pendingPermissions).toContain('wechat.send.text')
  })

  it('显式授权后待授权列表清空，已启用扩展会重启后台', async () => {
    const { manager, children } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource({ permissions: ['storage'] }))
    await manager.setEnabled('com.example.tx-bot', true)
    await tick()
    expect(children).toHaveLength(1)

    await manager.installFromDirectory(
      createSource({ version: '1.1.0', permissions: ['storage', 'wechat.send.text'] })
    )
    await tick()
    expect(manager.get('com.example.tx-bot')?.pendingPermissions).toContain('wechat.send.text')

    const before = children.length
    const granted = await manager.grantPermissions('com.example.tx-bot', ['wechat.send.text'])
    await tick()
    expect(granted.success).toBe(true)
    expect(manager.get('com.example.tx-bot')?.grantedPermissions).toContain('wechat.send.text')
    expect(manager.get('com.example.tx-bot')?.pendingPermissions).toEqual([])
    // 权限在进程启动时快照，授权后必须重启后台。
    expect(children.length).toBe(before + 1)
  })

  it('后台进程启动失败时显示 error，而不是假装运行中', async () => {
    const { manager } = createManager({ failSpawnAt: 1 })
    await manager.initialize()
    await manager.installFromDirectory(createSource())

    const enabled = await manager.setEnabled('com.example.tx-bot', true)
    expect(enabled.success).toBe(true)

    const extension = manager.get('com.example.tx-bot')
    expect(extension?.enabled).toBe(true)
    expect(extension?.runtime.state).toBe('error')
    expect(extension?.runtime.lastError).toBeTruthy()
  })

  it('只有页面入口的扩展显示为未运行，而不是崩溃', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const source = createSource()
    fs.writeJsonSync(path.join(source, 'manifest.json'), {
      ...manifest(),
      entrypoints: { page: 'ui/index.html' }
    })
    await manager.installFromDirectory(source)
    await manager.setEnabled('com.example.tx-bot', true)

    const extension = manager.get('com.example.tx-bot')
    expect(extension?.runtime.state).toBe('inactive')
    expect(extension?.runtime.note).toContain('仅提供页面')
  })

  it('Registry 损坏后从目录扫描恢复，扩展回到未启用无授权', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.tx-bot', true)

    // 模拟主文件与备份同时损坏后重启。
    fs.writeFileSync(paths.registryFile, 'broken', 'utf8')
    fs.writeFileSync(`${paths.registryFile}.bak`, 'also-broken', 'utf8')

    const restarted = createManager()
    await restarted.manager.initialize()

    const health = restarted.manager.getHealth()
    expect(health.registry.state).toBe('recovered-by-scan')
    const extension = restarted.manager.get('com.example.tx-bot')
    expect(extension).toBeTruthy()
    expect(extension?.enabled).toBe(false)
    expect(extension?.grantedPermissions).toEqual([])
  })

  it('配置损坏时在启动阶段就停用扩展，旧规则不会继续跑', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.tx-bot', true)
    await manager.pageRequest('com.example.tx-bot', 'storage.set', {
      key: 'enabled',
      value: true
    })
    await tick()

    const storageFile = path.join(paths.extensionDataDir('com.example.tx-bot'), 'storage.json')
    fs.writeFileSync(storageFile, 'broken', 'utf8')
    fs.writeFileSync(`${storageFile}.bak`, 'also-broken', 'utf8')

    const restarted = createManager()
    await restarted.manager.initialize()

    const extension = restarted.manager.get('com.example.tx-bot')
    expect(extension?.enabled).toBe(false)
    expect(extension?.storage.state).toBe('unrecovered')
    // 没有后台进程被拉起。
    expect(restarted.children).toHaveLength(0)

    // 未确认前不允许启用：否则会带着旧规则直接发消息。
    const enable = await restarted.manager.setEnabled('com.example.tx-bot', true)
    expect(enable.success).toBe(false)
    expect(enable.error?.code).toBe('EXTENSION_STORAGE_CORRUPTED')
  })

  it('配置从备份恢复后需用户确认才允许启用', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.tx-bot', true)
    await manager.pageRequest('com.example.tx-bot', 'storage.set', {
      key: 'enabled',
      value: true
    })
    await manager.pageRequest('com.example.tx-bot', 'storage.set', {
      key: 'rules',
      value: ['r1']
    })
    await tick()

    const storageFile = path.join(paths.extensionDataDir('com.example.tx-bot'), 'storage.json')
    fs.writeFileSync(storageFile, 'broken', 'utf8')

    const restarted = createManager()
    await restarted.manager.initialize()

    const extension = restarted.manager.get('com.example.tx-bot')
    expect(extension?.enabled).toBe(false)
    expect(extension?.storage.state).toBe('recovered-from-backup')
    expect(restarted.children).toHaveLength(0)

    const blocked = await restarted.manager.setEnabled('com.example.tx-bot', true)
    expect(blocked.success).toBe(false)

    const acknowledged = restarted.manager.acknowledgeStorageRecovery('com.example.tx-bot')
    expect(acknowledged.success).toBe(true)
    expect(restarted.manager.get('com.example.tx-bot')?.storage.state).toBe('ok')

    const enabled = await restarted.manager.setEnabled('com.example.tx-bot', true)
    expect(enabled.success).toBe(true)
    await tick()
    expect(restarted.children.length).toBeGreaterThan(0)
  })

  it('代码版本与状态记录不一致时不启动，用户可对齐到磁盘版本', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.tx-bot', true)
    await tick()

    // 模拟「代码已替换、Registry 尚未写入」时进程被杀。
    fs.writeJsonSync(
      path.join(paths.installDir('com.example.tx-bot'), 'manifest.json'),
      manifest({ version: '1.1.0' })
    )

    const restarted = createManager()
    await restarted.manager.initialize()

    const extension = restarted.manager.get('com.example.tx-bot')
    expect(extension?.runtime.state).toBe('error')
    expect(extension?.runtime.lastError).toContain('升级可能中断')
    expect(restarted.children).toHaveLength(0)

    const adopt = restarted.manager.adoptInstalledCode('com.example.tx-bot')
    expect(adopt.success).toBe(true)
    expect(restarted.manager.get('com.example.tx-bot')?.version).toBe('1.1.0')
    // 版本已对齐；扩展仍是「启用但未运行」，需要用户重新启用后才会拉起后台。
    expect(restarted.manager.get('com.example.tx-bot')?.runtime.lastError).not.toContain(
      '升级可能中断'
    )
    const enabled = await restarted.manager.setEnabled('com.example.tx-bot', true)
    expect(enabled.success).toBe(true)
    await tick()
    expect(restarted.manager.get('com.example.tx-bot')?.runtime.state).toBe('active')
  })

  it('存在升级备份时可回滚到备份版本', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.tx-bot', true)
    await tick()

    const installDir = paths.installDir('com.example.tx-bot')
    const backupDir = path.join(paths.extensionsDir, 'com.example.tx-bot.backup-1')
    fs.copySync(installDir, backupDir)
    fs.writeJsonSync(path.join(backupDir, 'manifest.json'), manifest({ version: '0.9.0' }))
    // 磁盘换成"可疑的新代码"，Registry 仍停在 1.0.0。
    fs.writeJsonSync(path.join(installDir, 'manifest.json'), manifest({ version: '1.1.0' }))

    const restarted = createManager()
    await restarted.manager.initialize()
    expect(restarted.manager.get('com.example.tx-bot')?.runtime.state).toBe('error')

    const rolled = await restarted.manager.rollbackInterruptedUpgrade('com.example.tx-bot')
    expect(rolled.success).toBe(true)
    expect(restarted.manager.get('com.example.tx-bot')?.version).toBe('0.9.0')
    expect(
      fs.readJsonSync(path.join(installDir, 'manifest.json')).version
    ).toBe('0.9.0')
  })
})
