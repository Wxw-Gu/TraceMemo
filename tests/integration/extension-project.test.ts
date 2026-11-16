import { createRequire } from 'node:module'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionManager } from '../../src/main/extensions/extension-manager'
import { createExtensionPaths } from '../../src/main/extensions/extension-paths'
import { computeDirectoryDigest } from '../../src/main/extensions/extension-code-digest'
import type {
  ExtensionHostChild,
  ExtensionHostSpawnOptions
} from '../../src/main/extensions/extension-host'
import { EXTENSION_HOST_PROTOCOL_VERSION } from '../../src/shared/extensions/rpc'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'

const require = createRequire(import.meta.url)
const {
  buildTemplates
}: {
  buildTemplates: (options?: Record<string, unknown>) => unknown
} = require('../../scripts/build-extension-templates.cjs')

type Listener = (...args: unknown[]) => void

class FakeChild implements ExtensionHostChild {
  readonly sent: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Listener[]>()

  send(message: unknown): void {
    const payload = message as Record<string, unknown>
    this.sent.push(payload)
    if (payload.type === 'activate') {
      queueMicrotask(() =>
        this.emit('message', {
          type: 'activated',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          ok: true
        })
      )
    }
    if (payload.type === 'shutdown') {
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
let templateRoot: string

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-'))
  roots.push(root)
  return root
}

function createManager(): {
  manager: ExtensionManager
  paths: ReturnType<typeof createExtensionPaths>
  children: FakeChild[]
} {
  const paths = createExtensionPaths(userData)
  const children: FakeChild[] = []
  const manager = new ExtensionManager({
    paths,
    appVersion: '2.6.0',
    secretCipher: {
      isAvailable: () => true,
      encrypt: (plain: string) => Buffer.from(plain, 'utf8'),
      decrypt: (payload: Buffer) => payload.toString('utf8')
    },

    templatesRoot: templateRoot,
    spawn: (options: ExtensionHostSpawnOptions) => {
      void options
      const child = new FakeChild()
      children.push(child)
      return child
    },
    getCapability: async () => capability,
    checkEntitlement: async () => ({ ok: true, message: '授权有效', source: 'mac_license' }),
    executeAction: async () =>
      ({
        actionId: 'a',
        status: 'sent',
        decision: 'allow',
        startedAt: '',
        finishedAt: ''
      }) as never,
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

/** 用同一份 examples 生成 1.1.0 的模板，用于「有新版本」的场景。 */
function rebuildTemplates(version: string): void {
  const work = tempRoot()
  const sourceRoot = path.join(work, 'examples')
  fs.copySync(path.join(process.cwd(), 'examples/extensions'), sourceRoot)
  const manifestPath = path.join(sourceRoot, 'keyword-bot/manifest.json')
  const manifest = fs.readJsonSync(manifestPath)
  fs.writeJsonSync(manifestPath, { ...manifest, version })
  buildTemplates({
    sourceRoot,
    outputDir: templateRoot,
    lockFile: path.join(work, 'lock.json')
  })
}

beforeEach(() => {
  userData = tempRoot()
  const work = tempRoot()
  const sourceRoot = path.join(work, 'examples')
  fs.copySync(path.join(process.cwd(), 'examples/extensions'), sourceRoot)
  templateRoot = path.join(work, 'templates')
  buildTemplates({
    sourceRoot,
    outputDir: templateRoot,
    lockFile: path.join(work, 'lock.json')
  })
})

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
})

describe('从模板创建独立项目', { timeout: 20_000 }, () => {
  it('生成新 id 的项目，manifest 与页面桥保持一致', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const target = path.join(tempRoot(), 'persona-bot')

    const result = await manager.createProjectFromTemplate('keyword-bot', target, {
      extensionId: 'com.acme.persona-bot',
      name: '我的机器人'
    })
    expect(result.success).toBe(true)
    expect(result.projectPath).toBe(target)

    const manifest = fs.readJsonSync(path.join(target, 'manifest.json'))
    expect(manifest.id).toBe('com.acme.persona-bot')
    expect(manifest.name).toBe('我的机器人')

    const appJs = fs.readFileSync(path.join(target, 'ui', 'app.js'), 'utf8')
    expect(appJs).toContain("'com.acme.persona-bot'")
    expect(appJs).not.toContain('com.example.keyword-bot')
    expect(result.rewrittenFiles).toContain('ui/app.js')
    // 不复制任何用户数据。
    expect(fs.existsSync(path.join(target, 'storage.json'))).toBe(false)
  })

  it('目标目录非空时拒绝且不写入', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const target = path.join(tempRoot(), 'occupied')
    fs.ensureDirSync(target)
    fs.writeFileSync(path.join(target, 'keep.txt'), 'user data')

    const result = await manager.createProjectFromTemplate('keyword-bot', target, {
      extensionId: 'com.acme.blocked'
    })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('EXTENSION_PROJECT_EXISTS')
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('user data')
    expect(fs.existsSync(path.join(target, 'manifest.json'))).toBe(false)
  })

  it('沿用模板原 id 时拒绝', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const result = await manager.createProjectFromTemplate(
      'keyword-bot',
      path.join(tempRoot(), 'same-id'),
      { extensionId: 'com.example.keyword-bot' }
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_REQUEST')
  })

  it('抖音模板生成的项目保留外部依赖说明', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const target = path.join(tempRoot(), 'douyin-dev')
    const result = await manager.createProjectFromTemplate('douyin-sender', target, {
      extensionId: 'com.acme.douyin-dev'
    })
    expect(result.success).toBe(true)
    // 解析脚本不在项目里：这是设计，不是缺陷。
    expect(fs.existsSync(path.join(target, 'scripts', 'douyin.py'))).toBe(false)
    const appJs = fs.readFileSync(path.join(target, 'ui', 'app.js'), 'utf8')
    expect(appJs).not.toContain('com.example.douyin-sender')
  })
})

describe('本地改动检测', { timeout: 20_000 }, () => {
  it('未修改的模板允许更新，并刷新指纹', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installTemplate('keyword-bot')
    const before = manager.get('com.example.keyword-bot')
    expect(before?.version).toBe('1.0.1')

    rebuildTemplates('1.2.0')
    const restarted = createManager()
    await restarted.manager.initialize()
    const upgraded = await restarted.manager.installTemplate('keyword-bot')
    expect(upgraded.success).toBe(true)
    expect(restarted.manager.get('com.example.keyword-bot')?.version).toBe('1.2.0')
  })

  it('改过后台 JS 后阻止更新，并给出导出建议', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installTemplate('keyword-bot')

    const target = path.join(paths.installDir('com.example.keyword-bot'), 'background', 'index.js')
    fs.appendFileSync(target, '\n// 用户自己的改动\n')

    rebuildTemplates('1.2.0')
    const restarted = createManager()
    await restarted.manager.initialize()
    const upgraded = await restarted.manager.installTemplate('keyword-bot')

    expect(upgraded.success).toBe(false)
    expect(upgraded.error?.code).toBe('EXTENSION_MODIFIED_LOCALLY')
    expect(upgraded.error?.message).toContain('导出为开发项目')
    // 代码保持用户改动后的样子。
    expect(
      fs.readFileSync(
        path.join(paths.installDir('com.example.keyword-bot'), 'background', 'index.js'),
        'utf8'
      )
    ).toContain('用户自己的改动')
  })

  it('新增或删除文件同样被判为已修改', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installTemplate('keyword-bot')
    fs.writeFileSync(path.join(paths.installDir('com.example.keyword-bot'), 'extra.js'), '// x')

    rebuildTemplates('1.2.0')
    const restarted = createManager()
    await restarted.manager.initialize()
    const added = await restarted.manager.installTemplate('keyword-bot')
    expect(added.error?.code).toBe('EXTENSION_MODIFIED_LOCALLY')

    fs.removeSync(path.join(paths.installDir('com.example.keyword-bot'), 'extra.js'))
    fs.removeSync(path.join(paths.installDir('com.example.keyword-bot'), 'lib', 'matcher.js'))
    const removed = await restarted.manager.installTemplate('keyword-bot')
    expect(removed.error?.code).toBe('EXTENSION_MODIFIED_LOCALLY')
  })

  it('只改扩展配置不影响更新', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installTemplate('keyword-bot')
    await manager.pageRequest('com.example.keyword-bot', 'storage.set', {
      key: 'rules',
      value: [{ id: 'r1' }]
    })

    rebuildTemplates('1.2.0')
    const restarted = createManager()
    await restarted.manager.initialize()
    const upgraded = await restarted.manager.installTemplate('keyword-bot')
    expect(upgraded.success).toBe(true)
    expect(
      (
        await restarted.manager.pageRequest('com.example.keyword-bot', 'storage.get', {
          key: 'rules'
        })
      ).result
    ).toEqual([{ id: 'r1' }])
  })

  it('缺少指纹的历史记录保守拒绝更新', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installTemplate('keyword-bot')
    // 模拟 M2 时代装下的记录：没有指纹字段。
    const registry = fs.readJsonSync(paths.registryFile)
    delete registry.extensions[0].installedCodeDigest
    fs.writeJsonSync(paths.registryFile, registry)

    rebuildTemplates('1.2.0')
    const restarted = createManager()
    await restarted.manager.initialize()
    const upgraded = await restarted.manager.installTemplate('keyword-bot')
    expect(upgraded.success).toBe(false)
    expect(upgraded.error?.code).toBe('EXTENSION_MODIFIED_LOCALLY')
    expect(upgraded.error?.message).toContain('无法确认')
  })
})

describe('导出为开发项目', { timeout: 20_000 }, () => {
  it('导出带用户改动的安装副本，并切换来源', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installTemplate('keyword-bot')
    await manager.setEnabled('com.example.keyword-bot', true)
    await manager.pageRequest('com.example.keyword-bot', 'storage.set', {
      key: 'rules',
      value: ['r1']
    })
    await tick()

    const installedFile = path.join(paths.installDir('com.example.keyword-bot'), 'ui', 'app.js')
    fs.appendFileSync(installedFile, '\n// 用户的二开改动\n')

    const target = path.join(tempRoot(), 'exported-bot')
    const exported = await manager.exportInstalledAsProject('com.example.keyword-bot', target)
    expect(exported.success).toBe(true)
    // 导出的是改过的副本，不是官方原版。
    expect(fs.readFileSync(path.join(target, 'ui', 'app.js'), 'utf8')).toContain('用户的二开改动')

    const extension = manager.get('com.example.keyword-bot')
    expect(extension?.source).toBe('development')
    expect(extension?.enabled).toBe(false)
    expect(extension?.development?.sourcePath).toBe(fs.realpathSync(target))
    // 配置保留。
    expect(
      (await manager.pageRequest('com.example.keyword-bot', 'storage.get', { key: 'rules' })).result
    ).toEqual(['r1'])
    // 原安装副本还在，作为显式恢复来源。
    expect(
      fs.existsSync(path.join(paths.installDir('com.example.keyword-bot'), 'manifest.json'))
    ).toBe(true)
  })

  it('导出后不再提供模板自动更新', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installTemplate('keyword-bot')
    const target = path.join(tempRoot(), 'exported')
    await manager.exportInstalledAsProject('com.example.keyword-bot', target)

    rebuildTemplates('1.2.0')
    const restarted = createManager()
    await restarted.manager.initialize()
    const result = await restarted.manager.installTemplate('keyword-bot')
    // 同 id 已被开发模式占用：安装被拒绝，不会覆盖开发源码。
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('EXTENSION_ALREADY_INSTALLED')
  })

  it('移除开发链接后回到安装副本，外部项目不被删除', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installTemplate('keyword-bot')
    const target = path.join(tempRoot(), 'exported')
    await manager.exportInstalledAsProject('com.example.keyword-bot', target)

    const unlinked = await manager.unlinkDevelopment('com.example.keyword-bot', { keepData: true })
    expect(unlinked.success).toBe(true)
    expect(fs.existsSync(target)).toBe(true)
    const extension = manager.get('com.example.keyword-bot')
    expect(extension?.source).toBe('directory')
    expect(extension?.development).toBeUndefined()
    expect(
      fs.existsSync(path.join(paths.installDir('com.example.keyword-bot'), 'manifest.json'))
    ).toBe(true)
  })
})

describe('代码指纹', { timeout: 20_000 }, () => {
  it('忽略缓存与依赖目录，只对代码内容敏感', () => {
    const root = tempRoot()
    fs.ensureDirSync(path.join(root, 'ui'))
    fs.writeFileSync(path.join(root, 'ui', 'app.js'), 'a')
    const first = computeDirectoryDigest(root)

    fs.ensureDirSync(path.join(root, 'node_modules', 'x'))
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'x')
    fs.writeFileSync(path.join(root, '.DS_Store'), 'x')
    expect(computeDirectoryDigest(root)).toBe(first)

    fs.writeFileSync(path.join(root, 'ui', 'app.js'), 'b')
    expect(computeDirectoryDigest(root)).not.toBe(first)
  })
})
