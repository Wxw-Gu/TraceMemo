import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MessageInsertCapabilityService,
  inspectNativeComponent,
  mapLicenseStatus,
  type CapabilityInput,
  type LicenseProbeResult,
  type CapabilityDeps
} from '../../src/main/services/msg-insert-capability-service'

/** 判定矩阵：不确定即拒、三种原因可区分、关闭不受授权影响。 */

const tmpDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cap-'))
  tmpDirs.push(dir)
  return dir
}

/** 造一个最小的合法 PE：MZ + e_lfanew + PE 签名 + machine */
function writeFakePe(
  machine = process.arch === 'arm64' ? 0xaa64 : 0x8664,
  size = 4096
): string {
  const dir = makeTempDir()
  const file = path.join(dir, 'tm-wcdb-config-helper.exe')
  const buf = Buffer.alloc(size)
  buf.write('MZ', 0, 'ascii')
  buf.writeUInt32LE(0x80, 0x3c)
  buf.write('PE\0\0', 0x80, 'ascii')
  buf.writeUInt16LE(machine, 0x80 + 4)
  fs.writeFileSync(file, buf)
  return file
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeService(options: {
  platform?: NodeJS.Platform
  probe?: () => Promise<LicenseProbeResult>
  component?: string | null
  macBundle?: boolean
  now?: () => number
}): { service: MessageInsertCapabilityService; probeCalls: () => number } {
  let calls = 0
  const deps: CapabilityDeps = {
    platform: options.platform ?? 'win32',
    hasMacNativeBundle: () => options.macBundle === true,
    isMacRuntimeUnavailable: () => options.macBundle !== true,
    resolveNativeComponent: () => (options.component === undefined ? null : options.component),
    probeLicense: async () => {
      calls += 1
      if (options.probe) return options.probe()
      return { ok: true, status: 'LICENSE_OK' }
    },
    now: options.now
  }
  return { service: new MessageInsertCapabilityService(deps), probeCalls: () => calls }
}

const dbReady: CapabilityInput = { databaseReady: true }
const dbDown: CapabilityInput = { databaseReady: false }

describe('mapLicenseStatus', () => {
  it('只有 LICENSE_OK 算有效', () => {
    expect(mapLicenseStatus('LICENSE_OK').entitlement).toBe('valid')
    for (const status of [
      'LICENSE_EXPIRED',
      'LICENSE_MACHINE_MISMATCH',
      'LICENSE_REVOKED',
      'LICENSE_INVALID',
      'LICENSE_TAMPERED',
      'LICENSE_NOT_FOUND'
    ]) {
      expect(mapLicenseStatus(status).entitlement).toBe('invalid')
    }
  })

  it('校验中与网络错误都不算有效，也不能算「没买」', () => {
    expect(mapLicenseStatus('LICENSE_CHECKING').entitlement).toBe('pending')
    expect(mapLicenseStatus('LICENSE_NETWORK_ERROR').entitlement).toBe('unavailable')
    expect(mapLicenseStatus('LICENSE_SERVER_ERROR').entitlement).toBe('unavailable')
    expect(mapLicenseStatus(undefined).entitlement).toBe('unavailable')
    expect(mapLicenseStatus('SOMETHING_NEW').entitlement).toBe('unavailable')
  })
})

describe('inspectNativeComponent', () => {
  it('缺失与空文件都算 missing', () => {
    expect(inspectNativeComponent(null, 'x64', () => null)).toBe('missing')
    const dir = makeTempDir()
    const empty = path.join(dir, 'empty.exe')
    fs.writeFileSync(empty, Buffer.alloc(16))
    expect(inspectNativeComponent(empty, 'x64', (p) => ({ size: fs.statSync(p).size }))).toBe('missing')
  })

  it('不是 PE 的算 invalid', () => {
    const dir = makeTempDir()
    const junk = path.join(dir, 'junk.exe')
    fs.writeFileSync(junk, Buffer.alloc(4096, 0x41))
    expect(inspectNativeComponent(junk, 'x64', (p) => ({ size: fs.statSync(p).size }))).toBe('invalid')
  })

  it('架构不符算 incompatible', () => {
    const arm = writeFakePe(0xaa64)
    expect(inspectNativeComponent(arm, 'x64', (p) => ({ size: fs.statSync(p).size }))).toBe('incompatible')
    const x64 = writeFakePe(0x8664)
    expect(inspectNativeComponent(x64, 'x64', (p) => ({ size: fs.statSync(p).size }))).toBe('ready')
  })
})

describe('Windows 能力判定', () => {
  it('Hook 无响应：不可开启，原因是有界失败而不是「未授权」', async () => {
    const { service } = makeService({ probe: async () => ({ ok: false, error: 'ECONNREFUSED' }) })
    const cap = await service.refresh(dbReady)
    expect(cap.canEnable).toBe(false)
    expect(cap.entitlementState).toBe('unavailable')
    expect(cap.reasonCode).toBe('LICENSE_UNAVAILABLE')
  })

  it('没有授权文件：要求先激活', async () => {
    const { service } = makeService({ probe: async () => ({ ok: true, status: 'LICENSE_NOT_FOUND' }) })
    const cap = await service.refresh(dbReady)
    expect(cap.reasonCode).toBe('LICENSE_REQUIRED')
    expect(cap.canEnable).toBe(false)
  })

  it('LICENSE_CHECKING 不能当有效', async () => {
    const { service } = makeService({ probe: async () => ({ ok: true, status: 'LICENSE_CHECKING' }) })
    const cap = await service.refresh(dbReady)
    expect(cap.entitlementState).toBe('pending')
    expect(cap.reasonCode).toBe('LICENSE_PENDING')
    expect(cap.canEnable).toBe(false)
  })

  it('过期 / 设备不匹配 / 吊销 各自有专属原因', async () => {
    const cases: Array<[string, string]> = [
      ['LICENSE_EXPIRED', 'LICENSE_EXPIRED'],
      ['LICENSE_MACHINE_MISMATCH', 'LICENSE_MACHINE_MISMATCH'],
      ['LICENSE_REVOKED', 'LICENSE_REVOKED'],
      ['LICENSE_INVALID', 'LICENSE_INVALID']
    ]
    for (const [status, reason] of cases) {
      const { service } = makeService({ probe: async () => ({ ok: true, status }) })
      const cap = await service.refresh(dbReady)
      expect(cap.reasonCode).toBe(reason)
      expect(cap.canEnable).toBe(false)
    }
  })

  it('有授权但缺组件：不能开，且原因不是授权问题', async () => {
    const { service } = makeService({ component: null })
    const cap = await service.refresh(dbReady)
    expect(cap.entitlementState).toBe('valid')
    expect(cap.nativeComponentState).toBe('missing')
    expect(cap.reasonCode).toBe('COMPONENT_MISSING')
    expect(cap.canEnable).toBe(false)
  })

  it('组件损坏：不能开', async () => {
    const dir = makeTempDir()
    const junk = path.join(dir, 'broken.exe')
    fs.writeFileSync(junk, Buffer.alloc(4096, 0x00))
    const { service } = makeService({ component: junk })
    const cap = await service.refresh(dbReady)
    expect(cap.nativeComponentState).toBe('invalid')
    expect(cap.reasonCode).toBe('COMPONENT_INVALID')
    expect(cap.canEnable).toBe(false)
  })

  it('数据库没连：不能开', async () => {
    const { service } = makeService({ component: writeFakePe() })
    const cap = await service.refresh(dbDown)
    expect(cap.reasonCode).toBe('DATABASE_UNAVAILABLE')
    expect(cap.canEnable).toBe(false)
  })

  it('授权 + 组件 + 数据库齐了才允许开', async () => {
    const { service } = makeService({ component: writeFakePe() })
    const cap = await service.refresh(dbReady)
    expect(cap.canEnable).toBe(true)
    expect(cap.reasonCode).toBe('CAPABILITY_READY')
  })

  it('关闭永远不受授权限制', async () => {
    const { service } = makeService({
      probe: async () => ({ ok: true, status: 'LICENSE_EXPIRED' }),
      component: null
    })
    const cap = await service.refresh(dbReady)
    expect(cap.canEnable).toBe(false)
    expect(cap.canDisable).toBe(true)
  })
})

describe('macOS 双版本策略', () => {
  it('OSS 包：不支持，且不能说成「未授权」', async () => {
    const { service } = makeService({ platform: 'darwin', macBundle: false })
    const cap = await service.refresh(dbReady)
    expect(cap.entitlementState).toBe('unsupported')
    expect(cap.reasonCode).toBe('UNSUPPORTED_PLATFORM')
    expect(cap.canEnable).toBe(false)
  })

  it('Native 包：组件与数据库就绪即可开，不看发送 ready', async () => {
    const { service } = makeService({ platform: 'darwin', macBundle: true, component: writeFakePe() })
    const cap = await service.refresh(dbReady)
    expect(cap.canEnable).toBe(true)
    expect(cap.entitlementState).toBe('valid')
  })

  it('Native 包但缺组件：仍然不能开', async () => {
    const { service } = makeService({ platform: 'darwin', macBundle: true, component: null })
    const cap = await service.refresh(dbReady)
    expect(cap.canEnable).toBe(false)
    expect(cap.reasonCode).toBe('COMPONENT_MISSING')
  })
})

describe('缓存与并发', () => {
  it('TTL 内复用结果，refresh 强制重查', async () => {
    let now = 1_000
    let status = 'LICENSE_REQUIRED'
    const { service, probeCalls } = makeService({
      component: writeFakePe(),
      now: () => now,
      probe: async () => ({ ok: true, status: status === 'LICENSE_REQUIRED' ? 'LICENSE_NOT_FOUND' : status })
    })

    await service.getCapability(dbReady)
    const first = probeCalls()
    await service.getCapability(dbReady)
    expect(probeCalls()).toBe(first)

    status = 'LICENSE_OK'
    const cached = await service.getCapability(dbReady)
    expect(cached.canEnable).toBe(false)

    const fresh = await service.refresh(dbReady)
    expect(fresh.canEnable).toBe(true)
    expect(probeCalls()).toBeGreaterThan(first)

    now += 31_000
    await service.getCapability(dbReady)
    expect(probeCalls()).toBeGreaterThan(first + 1)
  })

  it('并发刷新只探一次', async () => {
    const { service, probeCalls } = makeService({ component: writeFakePe() })
    await Promise.all([service.refresh(dbReady), service.refresh(dbReady), service.refresh(dbReady)])
    expect(probeCalls()).toBe(1)
  })

  it('数据库状态变化不受授权缓存影响', async () => {
    const { service } = makeService({ component: writeFakePe() })
    expect((await service.getCapability(dbReady)).canEnable).toBe(true)
    expect((await service.getCapability(dbDown)).canEnable).toBe(false)
    expect((await service.getCapability(dbReady)).canEnable).toBe(true)
  })
})
