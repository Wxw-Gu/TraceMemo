import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MessageInsertCapabilityService,
  mapLicenseStatus
} from '../../src/main/services/msg-insert-capability-service'
import {
  resetComponentCache,
  resolveExternalComponent
} from '../../src/main/services/external-component-locator'

/**
 * 组件发现与能力判定的验收：真实文件与 PE 头，只替换 4290 探测。
 */

const HELPER = 'tm-wcdb-config-helper.exe'
const API = 'wcdb_api.dll'
const CORE = 'WCDB.dll'

/** 造一个「PE 头合法、体积够大」的假组件，专门喂给 inspectNativeComponent。 */
function fakePe(machine = 0x8664, total = 2048): Buffer {
  const buf = Buffer.alloc(total)
  buf.write('MZ', 0, 'latin1')
  buf.writeUInt32LE(0x80, 0x3c)
  buf.write('PE\0\0', 0x80, 'latin1')
  buf.writeUInt16LE(machine, 0x84)
  return buf
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

interface Fixture {
  root: string
  versionDir: string
  localAppData: string
  pointerPath: string
}

function buildFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cap-'))
  const localAppData = path.join(root, 'LocalAppData')
  const versionDir = path.join(localAppData, 'TraceMemo', 'Pro', 'windows-x64', '1.0.0')
  fs.mkdirSync(versionDir, { recursive: true })

  const files: Array<{ path: string; size: number; sha256: string }> = []
  for (const name of [API, CORE, HELPER]) {
    const buf = fakePe()
    fs.writeFileSync(path.join(versionDir, name), buf)
    files.push({ path: name, size: buf.length, sha256: sha256(buf) })
  }

  fs.writeFileSync(
    path.join(versionDir, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        product: 'TraceMemo',
        edition: 'oss',
        platform: 'windows-x64',
        componentVersion: '1.0.0',
        wchookCommit: 'test',
        dllCommit: 'test',
        worktreeDirty: false,
        installedAt: new Date().toISOString(),
        files
      },
      null,
      2
    )
  )
  const pointerPath = path.join(localAppData, 'TraceMemo', 'Pro', 'windows-x64', 'current.json')
  fs.writeFileSync(pointerPath, JSON.stringify({ version: '1.0.0', dir: versionDir }))
  return { root, versionDir, localAppData, pointerPath }
}

/**
 * 组一个和生产同构的服务实例。
 * 定位器显式传 LOCALAPPDATA（不去改 process.env，避免用例之间互相污染），
 * 其余依赖保持生产实现。
 */
function makeService(
  localAppData: string | null,
  probe: { ok: true; status: string } | { ok: false; error: string }
): MessageInsertCapabilityService {
  return new MessageInsertCapabilityService({
    platform: 'win32',
    hasMacNativeBundle: () => true,
    isMacRuntimeUnavailable: () => false,
    resolveNativeComponent: () =>
      localAppData
        ? (resolveExternalComponent({ LOCALAPPDATA: localAppData } as never, 'win32')?.helperPath ??
          null)
        : null,
    probeLicense: async () => probe
  })
}

const located = (localAppData: string): ReturnType<typeof resolveExternalComponent> =>
  resolveExternalComponent({ LOCALAPPDATA: localAppData } as never, 'win32')

describe('能力验收矩阵（真实文件 + 真实 PE 嗅探）', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = buildFixture()
    resetComponentCache()
  })

  afterEach(() => {
    resetComponentCache()
    fs.rmSync(fixture.root, { recursive: true, force: true })
  })

  it('定位到外置 bundle 时返回 helper 绝对路径与版本', () => {
    const found = located(fixture.localAppData)
    expect(found).not.toBeNull()
    expect(found!.version).toBe('1.0.0')
    expect(found!.helperPath).toBe(path.join(fixture.versionDir, HELPER))
    expect(fs.existsSync(found!.helperPath)).toBe(true)
  })

  it('1. 未安装组件：没有 current.json → 组件缺失，不支持开启', async () => {
    fs.rmSync(fixture.pointerPath)
    resetComponentCache()
    const cap = await makeService(fixture.localAppData, {
      ok: true,
      status: 'LICENSE_OK'
    }).refresh({ databaseReady: true })
    expect(cap.nativeComponentState).toBe('missing')
    expect(cap.canEnable).toBe(false)
    expect(cap.reasonCode).toBe('COMPONENT_MISSING')
  })

  it('2. 装了组件但授权不可达 → 不许开启，原因指向授权', async () => {
    const cap = await makeService(fixture.localAppData, {
      ok: false,
      error: 'ECONNREFUSED'
    }).refresh({ databaseReady: true })
    expect(cap.nativeComponentState).toBe('ready')
    expect(cap.entitlementState).toBe('unavailable')
    expect(cap.canEnable).toBe(false)
    expect(cap.reasonCode).toBe('LICENSE_UNAVAILABLE')
  })

  it('3. 授权有效 + 组件就绪 + 库已连接 → 允许开启', async () => {
    const cap = await makeService(fixture.localAppData, {
      ok: true,
      status: 'LICENSE_OK'
    }).refresh({ databaseReady: true })
    expect(cap.entitlementState).toBe('valid')
    expect(cap.nativeComponentState).toBe('ready')
    expect(cap.canEnable).toBe(true)
    expect(cap.reasonCode).toBe('CAPABILITY_READY')
  })

  it('4. 授权过期 → 不许开启', async () => {
    const cap = await makeService(fixture.localAppData, {
      ok: true,
      status: 'LICENSE_EXPIRED'
    }).refresh({ databaseReady: true })
    expect(cap.entitlementState).toBe('invalid')
    expect(cap.canEnable).toBe(false)
    expect(cap.reasonCode).toBe('LICENSE_EXPIRED')
  })

  it('5. 组件文件缺失 → 定位失败，按未安装处理', () => {
    fs.rmSync(path.join(fixture.versionDir, HELPER))
    resetComponentCache()
    expect(located(fixture.localAppData)).toBeNull()
  })

  it('6. 组件被篡改（大小不同）→ manifest 校验失败，按未安装处理', () => {
    fs.writeFileSync(path.join(fixture.versionDir, API), fakePe(0x8664, 4096))
    resetComponentCache()
    expect(located(fixture.localAppData)).toBeNull()
  })

  it('7. 关闭永远不被授权拦住（授权过期 + 组件缺失也能关）', async () => {
    const svc = new MessageInsertCapabilityService({
      platform: 'win32',
      hasMacNativeBundle: () => true,
      isMacRuntimeUnavailable: () => false,
      resolveNativeComponent: () => null,
      probeLicense: async () => ({ ok: true, status: 'LICENSE_EXPIRED' })
    })
    const cap = await svc.refresh({ databaseReady: false })
    expect(cap.canEnable).toBe(false)
    expect(cap.canDisable).toBe(true)
  })

  it('8. 微信库未连接 → 不许开启', async () => {
    const cap = await makeService(fixture.localAppData, {
      ok: true,
      status: 'LICENSE_OK'
    }).refresh({ databaseReady: false })
    expect(cap.canEnable).toBe(false)
    expect(cap.reasonCode).toBe('DATABASE_UNAVAILABLE')
  })

  it('9. 授权状态映射：只有 LICENSE_OK 算 valid', () => {
    for (const status of [
      'LICENSE_EXPIRED',
      'LICENSE_MACHINE_MISMATCH',
      'LICENSE_REVOKED',
      'LICENSE_INVALID',
      'LICENSE_SERVICE_DOWN',
      'LICENSE_CHECKING',
      ''
    ]) {
      expect(mapLicenseStatus(status).entitlement).not.toBe('valid')
    }
    expect(mapLicenseStatus('LICENSE_OK').entitlement).toBe('valid')
  })
})
