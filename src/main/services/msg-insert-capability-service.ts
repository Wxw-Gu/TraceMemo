import fs from 'node:fs'
import http from 'node:http'

import type { CapabilityReasonCode } from '../../shared/msg-insert-switch'
import { hasMacNativeBundle, isMacNativeRuntimeUnavailable } from '../native-runtime-paths'
import { resolveHelperPath } from './msg-insert-switch-service'

/**
 * 发送能力的唯一判定入口：授权、原生组件、库连接分开算，任一项不确定都不许开启。
 * 4290 的 JSON 本机可伪造，这里只是应用层门禁，真正的校验在原生 helper。
 */

export type { CapabilityReasonCode }

export type EntitlementState = 'valid' | 'invalid' | 'pending' | 'unavailable' | 'unsupported'

export type NativeComponentState = 'ready' | 'missing' | 'invalid' | 'incompatible'

export interface MessageInsertCapability {
  /** 授权 */
  entitlementState: EntitlementState
  /** 发送能力组件 */
  nativeComponentState: NativeComponentState
  /** 微信数据库是否已连接（不代表发送能力） */
  databaseReady: boolean
  /** 是否允许「开启」发送能力 */
  canEnable: boolean
  /** 关闭永远不因授权被拒，否则用户没法把自己开过的功能关掉。 */
  canDisable: boolean
  reasonCode: CapabilityReasonCode
  /** 给人看的一句话 */
  message: string
  /** Hook 原始状态名，仅用于诊断展示 */
  licenseStatus?: string
  /** 判定时间戳 */
  checkedAt: number
}

export interface CapabilityInput {
  /** 微信库是否已连接（由主进程按 chat 状态传入） */
  databaseReady: boolean
}

export interface LicenseProbeResult {
  ok: boolean
  status?: string
  error?: string
}

export interface CapabilityDeps {
  platform: NodeJS.Platform
  /** mac：是否 native 包 */
  hasMacNativeBundle: () => boolean
  /** mac：是否 public 包（拿不到 native 运行时） */
  isMacRuntimeUnavailable: () => boolean
  /** 发送能力组件路径；null = 缺失 */
  resolveNativeComponent: () => string | null
  /** 授权探测（Windows） */
  probeLicense: (timeoutMs: number) => Promise<LicenseProbeResult>
  /** 组件文件探测（便于测试注入） */
  statFile?: (filePath: string) => { size: number } | null
  now?: () => number
}

const DEFAULT_TTL_MS = 30_000
const PROBE_TIMEOUT_MS = 1_200

/** Hook 的 LicenseStatus → 授权状态。只有明确可接受的结果才算 valid。 */
export function mapLicenseStatus(status: string | undefined): {
  entitlement: EntitlementState
  reasonCode: CapabilityReasonCode
  message: string
} {
  switch (status) {
    case 'LICENSE_OK':
      return { entitlement: 'valid', reasonCode: 'CAPABILITY_READY', message: '授权有效' }
    case 'LICENSE_CHECKING':
      return {
        entitlement: 'pending',
        reasonCode: 'LICENSE_PENDING',
        message: '授权正在验证，请稍候'
      }
    case 'LICENSE_EXPIRED':
      return {
        entitlement: 'invalid',
        reasonCode: 'LICENSE_EXPIRED',
        message: '授权已过期，请重新激活后再开启'
      }
    case 'LICENSE_MACHINE_MISMATCH':
      return {
        entitlement: 'invalid',
        reasonCode: 'LICENSE_MACHINE_MISMATCH',
        message: '这份授权不属于本机'
      }
    case 'LICENSE_REVOKED':
      return {
        entitlement: 'invalid',
        reasonCode: 'LICENSE_REVOKED',
        message: '授权已被吊销'
      }
    case 'LICENSE_INVALID':
    case 'LICENSE_TAMPERED':
      return {
        entitlement: 'invalid',
        reasonCode: 'LICENSE_INVALID',
        message: '授权无效，请重新激活'
      }
    case 'LICENSE_NOT_FOUND':
      return {
        entitlement: 'invalid',
        reasonCode: 'LICENSE_REQUIRED',
        message: '未检测到有效授权'
      }
    case 'LICENSE_NETWORK_ERROR':
    case 'LICENSE_SERVER_ERROR':
      return {
        entitlement: 'unavailable',
        reasonCode: 'LICENSE_UNAVAILABLE',
        message: '授权服务暂时不可用，稍后再试'
      }
    default:
      // 未知状态一律 fail-closed，但要说清「是未知」而不是「你没买」
      return {
        entitlement: 'unavailable',
        reasonCode: 'LICENSE_UNAVAILABLE',
        message: '暂时无法确认授权状态'
      }
  }
}

/** 探测本机 Hook 的授权接口。失败只报失败，不臆测状态。 */
export function probeLicenseStatus(timeoutMs = PROBE_TIMEOUT_MS): Promise<LicenseProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    const done = (result: LicenseProbeResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let req: http.ClientRequest
    try {
      req = http.get(
        { host: '127.0.0.1', port: 4290, path: '/license/status', timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                status?: unknown
              }
              done({ ok: true, status: typeof body.status === 'string' ? body.status : '' })
            } catch {
              done({ ok: false, error: 'BAD_JSON' })
            }
          })
          res.on('error', () => done({ ok: false, error: 'RESPONSE_ERROR' }))
        }
      )
    } catch (error) {
      done({ ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    req.on('timeout', () => {
      req.destroy()
      done({ ok: false, error: 'TIMEOUT' })
    })
    req.on('error', (error: Error) => done({ ok: false, error: error.message }))
  })
}
/**
 * 检查原生组件的文件格式及 CPU 架构兼容性。
 * 支持 macOS Mach-O 和 Windows PE。
 */
export function inspectNativeComponent(
  filePath: string | null,
  arch: string,
  statFile: (p: string) => { size: number } | null
): NativeComponentState {
  if (!filePath) return 'missing'
  const stat = statFile(filePath)
  if (!stat || stat.size < 1024) return 'missing'
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const head = Buffer.alloc(0x40)
      fs.readSync(fd, head, 0, 0x40, 0)

      const magicLE = head.readUInt32LE(0)
      if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
        const cpuType = head.readUInt32LE(4)
        const expected = arch === 'arm64' ? 0x0100000c : 0x01000007
        return cpuType === expected ? 'ready' : 'incompatible'
      }
      if (magicLE === 0xbebafeca || magicLE === 0xcafebabe) {
        const count = head.readUInt32BE(4)
        if (count === 0 || count > 16) return 'invalid'
        const expected = arch === 'arm64' ? 0x0100000c : 0x01000007
        const slice = Buffer.alloc(20)
        for (let index = 0; index < count; index += 1) {
          fs.readSync(fd, slice, 0, 20, 8 + index * 20)
          if (slice.readUInt32BE(0) === expected) return 'ready'
        }
        return 'incompatible'
      }

      if (head[0] !== 0x4d || head[1] !== 0x5a) return 'invalid' // "MZ"
      const peOffset = head.readUInt32LE(0x3c)
      const pe = Buffer.alloc(6)
      fs.readSync(fd, pe, 0, 6, peOffset)
      if (pe[0] !== 0x50 || pe[1] !== 0x45) return 'invalid' // "PE"
      const machine = pe.readUInt16LE(4)
      const expected = arch === 'arm64' ? 0xaa64 : 0x8664
      return machine === expected ? 'ready' : 'incompatible'
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return 'invalid'
  }
}

export class MessageInsertCapabilityService {
  private cached: MessageInsertCapability | null = null
  private inflight: Promise<MessageInsertCapability> | null = null
  private readonly now: () => number

  constructor(private readonly deps: CapabilityDeps) {
    this.now = deps.now || (() => Date.now())
  }

  /** 读缓存（页面刷新用）；过期或从未算过就重新评估。 */
  async getCapability(input: CapabilityInput): Promise<MessageInsertCapability> {
    const now = this.now()
    if (this.cached && now - this.cached.checkedAt < DEFAULT_TTL_MS) {
      /* 数据库连接状态可能瞬间变化，缓存命中时也要用最新入参重算这一项 */
      const merged = this.compose(input, this.cached.entitlementState, this.cached.licenseStatus)
      this.cached = merged
      return merged
    }
    return this.refresh(input)
  }

  /** 强制重新评估（写库前必须调用，不能相信页面上那份缓存）。 */
  async refresh(input: CapabilityInput): Promise<MessageInsertCapability> {
    if (this.inflight) return this.inflight
    this.inflight = this.evaluate(input).finally(() => {
      this.inflight = null
    })
    const result = await this.inflight
    this.cached = result
    return result
  }

  /** 供主进程做「开启」前的最终裁决。 */
  async ensureCanEnable(input: CapabilityInput): Promise<MessageInsertCapability> {
    return this.refresh(input)
  }

  /** 测试与设置变化时清缓存。 */
  invalidate(): void {
    this.cached = null
  }

  private async evaluate(input: CapabilityInput): Promise<MessageInsertCapability> {
    const platform = this.deps.platform

    if (platform !== 'win32' && platform !== 'darwin') {
      return this.build({
        input,
        entitlement: 'unsupported',
        licenseStatus: undefined,
        reasonCode: 'UNSUPPORTED_PLATFORM',
        message: '微信内消息写入目前仅支持 Windows 与 macOS'
      })
    }

    if (platform === 'darwin') {
      if (!this.deps.hasMacNativeBundle()) {
        // OSS 包：如实说不提供，不假装「未授权」
        return this.build({
          input,
          entitlement: 'unsupported',
          licenseStatus: undefined,
          reasonCode: 'UNSUPPORTED_PLATFORM',
          message: '当前版本不包含微信内消息发送能力'
        })
      }
      return this.build({
        input,
        entitlement: 'valid',
        licenseStatus: undefined,
        reasonCode: 'CAPABILITY_READY',
        message: '授权有效'
      })
    }

    const probe = await this.deps.probeLicense(PROBE_TIMEOUT_MS)
    if (!probe.ok) {
      return this.build({
        input,
        entitlement: 'unavailable',
        licenseStatus: undefined,
        reasonCode: 'LICENSE_UNAVAILABLE',
        message: '暂时无法确认授权状态'
      })
    }
    const mapped = mapLicenseStatus(probe.status)
    return this.build({
      input,
      entitlement: mapped.entitlement,
      licenseStatus: probe.status,
      reasonCode: mapped.reasonCode,
      message: mapped.message
    })
  }

  private build(args: {
    input: CapabilityInput
    entitlement: EntitlementState
    licenseStatus?: string
    reasonCode: CapabilityReasonCode
    message: string
  }): MessageInsertCapability {
    return this.compose(
      args.input,
      args.entitlement,
      args.licenseStatus,
      args.reasonCode,
      args.message
    )
  }

  private compose(
    input: CapabilityInput,
    entitlement: EntitlementState,
    licenseStatus: string | undefined,
    reasonCode?: CapabilityReasonCode,
    message?: string
  ): MessageInsertCapability {
    const platform = this.deps.platform
    const supportedPlatform = platform === 'win32' || platform === 'darwin'
    const component = supportedPlatform
      ? inspectNativeComponent(
          this.deps.resolveNativeComponent(),
          process.arch,
          this.deps.statFile || defaultStat
        )
      : 'missing'
    const databaseReady = input.databaseReady === true

    let code: CapabilityReasonCode = reasonCode || 'CAPABILITY_READY'
    let text = message || ''
    if (!code || code === 'CAPABILITY_READY') {
      if (entitlement === 'unsupported') {
        code = 'UNSUPPORTED_PLATFORM'
        text = text || '当前版本不包含微信内消息发送能力'
      } else if (entitlement === 'unavailable') {
        code = 'LICENSE_UNAVAILABLE'
        text = text || '暂时无法确认授权状态'
      } else if (entitlement === 'pending') {
        code = 'LICENSE_PENDING'
        text = text || '授权正在验证，请稍候'
      } else if (entitlement === 'invalid') {
        code = 'LICENSE_REQUIRED'
        text = text || '未检测到有效授权'
      } else if (component !== 'ready') {
        code = component === 'missing' ? 'COMPONENT_MISSING' : 'COMPONENT_INVALID'
        text = component === 'missing' ? '未安装发送能力组件' : '发送能力组件不完整或版本不匹配'
      } else if (!databaseReady) {
        code = 'DATABASE_UNAVAILABLE'
        text = '微信数据库尚未连接'
      } else {
        code = 'CAPABILITY_READY'
        text = '授权与组件均已就绪'
      }
    }

    const canEnable =
      supportedPlatform &&
      entitlement === 'valid' &&
      component === 'ready' &&
      databaseReady &&
      code === 'CAPABILITY_READY'
    /* 关闭不受授权限制：用户丢了授权也必须能把已有规则关掉 */
    const canDisable = supportedPlatform

    return {
      entitlementState: entitlement,
      nativeComponentState: component,
      databaseReady,
      canEnable,
      canDisable,
      reasonCode: code,
      message: text,
      ...(licenseStatus ? { licenseStatus } : {}),
      checkedAt: this.now()
    }
  }
}

function defaultStat(filePath: string): { size: number } | null {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() ? { size: stat.size } : null
  } catch {
    return null
  }
}

export const msgInsertCapabilityService = new MessageInsertCapabilityService({
  platform: process.platform,
  hasMacNativeBundle,
  isMacRuntimeUnavailable: isMacNativeRuntimeUnavailable,
  resolveNativeComponent: resolveHelperPath,
  probeLicense: probeLicenseStatus
})
