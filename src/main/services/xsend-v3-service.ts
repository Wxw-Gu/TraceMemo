import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { promisify } from 'util'
import type {
  PersonalWechatXsendState,
  PersonalWechatXsendStatus
} from '../../shared/personal-wechat'
import { findResource } from '../resource-paths'

const execFileAsync = promisify(execFile)
const WECHAT_APP_PATH = '/Applications/WeChat.app'
const MANIFEST_PATH = 'xsend-v3/MANIFEST'
const RESIDENT_BINARY_PATH = 'xsend-v3/xsend-v3-resident'
const RESIDENT_SHA256_PATH = 'xsend-v3/xsend-v3-resident.sha256'
const MAX_COMMAND_OUTPUT = 1024 * 1024
const COMMAND_TIMEOUT_MS = 10_000
const EXPECTED_FORMAT = 'xsend-v3-resident'
const EXPECTED_VERSION = '0.1.0'
const EXPECTED_PLATFORM = 'darwin-arm64'
const EXPECTED_WECHAT_BUILD = '269631'
const EXPECTED_WECHAT_DYLIB_SHA256 =
  '964f653977f7e6d00400804eb492e230528c8e8e0653db6300e9b913e49973a9'
const EXPECTED_RESIDENT_SHA256 = '04ba738b27da9d07c48610226f115fc1b93359e3459427b4c7fe7fa241d12c1c'
const MAX_TARGET_BYTES = 255
const MAX_CONTENT_BYTES = 4095

export interface XsendV3Manifest {
  format: string
  version: string
  platform: string
  wechat_build: string
  wechat_dylib_sha256: string
  payload: string
  resident_binary: string
  resident_sha256: string
  onebot_dependency: string
  python_runtime_dependency: string
  [key: string]: string
}

export interface XsendV3Receipt {
  requestId?: string
  state: 0 | 1 | 2 | 3
  queue?: number
  retained?: number
  detail?: string
}

export interface XsendV3ServiceDependencies {
  platform?: () => string
  arch?: () => string
  findResource?: (relativePath: string) => string | null
  wechatAppPath?: string
  wechatDylibPath?: string
  readWechatPid?: () => Promise<number | undefined>
  readWechatBuild?: () => Promise<string>
  hashFile?: (filePath: string) => string
  execFile?: (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number }
  ) => Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>
}

export function parseXsendManifest(source: string): XsendV3Manifest {
  const values: Record<string, string> = {}
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error('xsend manifest 第 ' + (index + 1) + ' 行格式无效')
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (!key || !value) throw new Error('xsend manifest 第 ' + (index + 1) + ' 行为空')
    if (values[key] !== undefined) throw new Error('xsend manifest 包含重复字段：' + key)
    values[key] = value
  }
  return values as XsendV3Manifest
}

export function validateXsendManifest(manifest: XsendV3Manifest): void {
  const required = [
    'format',
    'version',
    'platform',
    'wechat_build',
    'wechat_dylib_sha256',
    'payload',
    'resident_binary',
    'resident_sha256',
    'onebot_dependency',
    'python_runtime_dependency'
  ]
  for (const key of required) {
    if (!String(manifest[key] || '').trim()) throw new Error('xsend manifest 缺少字段：' + key)
  }
  if (manifest.format !== EXPECTED_FORMAT) throw new Error('xsend manifest format 不受支持')
  if (manifest.version !== EXPECTED_VERSION) throw new Error('xsend manifest version 不受支持')
  if (manifest.platform !== EXPECTED_PLATFORM) throw new Error('xsend manifest platform 不受支持')
  if (manifest.wechat_build !== EXPECTED_WECHAT_BUILD) {
    throw new Error('xsend manifest 的微信 build 不受支持')
  }
  if (manifest.wechat_dylib_sha256 !== EXPECTED_WECHAT_DYLIB_SHA256) {
    throw new Error('xsend manifest 的微信 dylib 指纹不受支持')
  }
  if (manifest.payload !== 'embedded') throw new Error('xsend manifest payload 必须为 embedded')
  if (manifest.resident_binary !== 'xsend-v3-resident') {
    throw new Error('xsend manifest resident binary 不受支持')
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.resident_sha256)) {
    throw new Error('xsend manifest resident_sha256 格式无效')
  }
  if (manifest.resident_sha256.toLowerCase() !== EXPECTED_RESIDENT_SHA256) {
    throw new Error('xsend manifest 的 resident 指纹不受支持')
  }
  if (manifest.onebot_dependency !== 'none') {
    throw new Error('xsend manifest onebot_dependency 必须为 none')
  }
  if (manifest.python_runtime_dependency !== 'none') {
    throw new Error('xsend manifest python_runtime_dependency 必须为 none')
  }
}

export function parseXsendReceipt(output: string): XsendV3Receipt {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith('v3:'))
  if (!line) throw new Error('xsend 未返回 v3 状态')

  const body = line.slice(3).trim()
  const fields: Record<string, string> = {}
  const fieldPattern = /(?:^|\s)(request_id|state|queue|retained|detail)=/g
  const matches: Array<{ key: string; valueStart: number; matchStart: number }> = []
  let match: RegExpExecArray | null
  while ((match = fieldPattern.exec(body))) {
    matches.push({ key: match[1], valueStart: fieldPattern.lastIndex, matchStart: match.index })
  }
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index]
    const next = matches[index + 1]
    const valueEnd = next ? next.matchStart : body.length
    fields[current.key] = body.slice(current.valueStart, valueEnd).trim()
  }

  const state = Number(fields.state)
  if (state !== 0 && state !== 1 && state !== 2 && state !== 3) {
    throw new Error('xsend 返回未知 state')
  }
  const numberField = (key: string): number | undefined => {
    if (fields[key] === undefined) return undefined
    const value = Number(fields[key])
    return Number.isFinite(value) && value >= 0 ? value : undefined
  }
  return {
    state: state as XsendV3Receipt['state'],
    ...(fields.request_id ? { requestId: fields.request_id } : {}),
    ...(numberField('queue') !== undefined ? { queue: numberField('queue') } : {}),
    ...(numberField('retained') !== undefined ? { retained: numberField('retained') } : {}),
    ...(fields.detail ? { detail: fields.detail } : {})
  }
}

export function validateXsendText(target: string, content: string): void {
  if (!target) throw new Error('微信发送目标不能为空')
  if (!content) throw new Error('微信文字内容不能为空')
  if (target.includes('\n') || target.includes('\r')) {
    throw new Error('微信发送目标不能包含换行')
  }
  if (content.includes('\n') || content.includes('\r')) {
    throw new Error('微信文字内容不能包含换行')
  }
  if (Buffer.byteLength(target, 'utf8') > MAX_TARGET_BYTES) {
    throw new Error('微信发送目标不能超过 255 字节')
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new Error('微信文字内容不能超过 4095 字节')
  }
}

interface PackageInfo {
  manifest: XsendV3Manifest
  binaryPath: string
  binarySha256: string
}

interface WechatContext {
  pid?: number
  build?: string
  dylibSha256?: string
}

interface XsendPreflight {
  packageInfo?: PackageInfo
  context?: WechatContext
  status: PersonalWechatXsendStatus
}

function toText(value: string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '')
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}

function defaultHashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

async function defaultReadWechatPid(): Promise<number | undefined> {
  try {
    const result = await execFileAsync('/usr/bin/pgrep', ['-x', 'WeChat'])
    const pid = Number(toText(result.stdout).trim().split(/\s+/)[0])
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

async function defaultReadWechatBuild(wechatAppPath = WECHAT_APP_PATH): Promise<string> {
  const result = await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleVersion',
    wechatAppPath + '/Contents/Info.plist'
  ])
  return toText(result.stdout).trim()
}

export class XsendV3Service {
  private readonly deps: Required<
    Pick<
      XsendV3ServiceDependencies,
      | 'platform'
      | 'arch'
      | 'findResource'
      | 'readWechatPid'
      | 'readWechatBuild'
      | 'hashFile'
      | 'execFile'
    >
  > &
    Pick<XsendV3ServiceDependencies, 'wechatAppPath' | 'wechatDylibPath'>

  constructor(deps: XsendV3ServiceDependencies = {}) {
    this.deps = {
      platform: deps.platform ?? (() => process.platform),
      arch: deps.arch ?? (() => process.arch),
      findResource: deps.findResource ?? findResource,
      readWechatPid: deps.readWechatPid ?? defaultReadWechatPid,
      readWechatBuild:
        deps.readWechatBuild ??
        (() => defaultReadWechatBuild(deps.wechatAppPath ?? WECHAT_APP_PATH)),
      hashFile: deps.hashFile ?? defaultHashFile,
      execFile:
        deps.execFile ??
        (async (file, args, options) => {
          const result = await execFileAsync(file, args, options)
          return { stdout: result.stdout, stderr: result.stderr }
        }),
      wechatAppPath: deps.wechatAppPath,
      wechatDylibPath: deps.wechatDylibPath
    }
  }

  isSupported(): boolean {
    return this.deps.platform() === 'darwin' && this.deps.arch() === 'arm64'
  }

  async getStatus(): Promise<PersonalWechatXsendStatus> {
    const preflight = await this.preflight()
    if (preflight.status.state !== 'ready') return preflight.status
    const packageInfo = preflight.packageInfo!
    const pid = preflight.context!.pid!
    try {
      const receipt = await this.invoke(packageInfo.binaryPath, ['--pid', String(pid), '--status'])
      return this.statusFromReceipt(preflight, receipt, true)
    } catch (error) {
      return {
        ...preflight.status,
        state: 'failed',
        ready: false,
        message: 'xsend resident 状态检查失败',
        error: errorText(error)
      }
    }
  }

  async install(): Promise<PersonalWechatXsendStatus> {
    const preflight = await this.preflight()
    if (preflight.status.state !== 'ready') return preflight.status
    const packageInfo = preflight.packageInfo!
    const pid = preflight.context!.pid!
    try {
      const receipt = await this.invoke(packageInfo.binaryPath, ['--pid', String(pid), '--install'])
      if (receipt.state === 0 || receipt.state === 3) {
        return this.statusFromReceipt(preflight, receipt, false)
      }
      return this.getStatus()
    } catch (error) {
      return {
        ...preflight.status,
        state: 'failed',
        ready: false,
        message: 'xsend resident 安装失败',
        error: errorText(error)
      }
    }
  }

  async stop(): Promise<PersonalWechatXsendStatus> {
    const preflight = await this.preflight()
    if (preflight.status.state === 'wechat_not_running') return preflight.status
    if (preflight.status.state !== 'ready') return preflight.status
    const packageInfo = preflight.packageInfo!
    const pid = preflight.context!.pid!
    try {
      const receipt = await this.invoke(packageInfo.binaryPath, ['--pid', String(pid), '--stop'])
      if (receipt.state === 2) {
        return {
          ...preflight.status,
          state: 'stopped',
          ready: false,
          message: 'xsend resident 已停止',
          ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
          ...(receipt.detail ? { detail: receipt.detail } : {})
        }
      }
      return this.statusFromReceipt(preflight, receipt, false)
    } catch (error) {
      return {
        ...preflight.status,
        state: 'failed',
        ready: false,
        message: 'xsend resident 停止失败',
        error: errorText(error)
      }
    }
  }

  async sendText(
    target: string,
    content: string
  ): Promise<{
    success: boolean
    status: PersonalWechatXsendStatus
    error?: string
  }> {
    const normalizedTarget = String(target || '').trim()
    const normalizedContent = String(content || '').trim()
    try {
      validateXsendText(normalizedTarget, normalizedContent)
    } catch (error) {
      const status = await this.getStatus()
      return { success: false, status, error: errorText(error) }
    }

    const preflight = await this.preflight()
    if (preflight.status.state !== 'ready') {
      return {
        success: false,
        status: preflight.status,
        error: preflight.status.error || preflight.status.message
      }
    }
    const packageInfo = preflight.packageInfo!
    const pid = preflight.context!.pid!
    try {
      const receipt = await this.invoke(packageInfo.binaryPath, [
        '--pid',
        String(pid),
        '--send',
        normalizedTarget,
        normalizedContent
      ])
      const status = this.statusFromReceipt(preflight, receipt, false)
      if (receipt.state !== 2) {
        return {
          success: false,
          status,
          error: receipt.detail || 'xsend 未确认文字发送完成'
        }
      }
      return { success: true, status }
    } catch (error) {
      return {
        success: false,
        status: {
          ...preflight.status,
          state: 'failed',
          ready: false,
          message: 'xsend 文字发送失败',
          error: errorText(error)
        },
        error: errorText(error)
      }
    }
  }

  private async preflight(): Promise<XsendPreflight> {
    const base = (
      state: PersonalWechatXsendState,
      message: string,
      extra: Partial<PersonalWechatXsendStatus> = {}
    ): PersonalWechatXsendStatus => ({
      supported: this.isSupported(),
      ready: state === 'ready',
      state,
      platform: this.deps.platform(),
      arch: this.deps.arch(),
      installed: false,
      wechatRunning: false,
      message,
      ...extra
    })

    if (!this.isSupported()) {
      return { status: base('unsupported_platform', 'xsend 仅支持 Apple Silicon Mac') }
    }

    let manifest: XsendV3Manifest
    let binaryPath: string | null
    let residentShaPath: string | null
    try {
      const manifestPath = this.deps.findResource(MANIFEST_PATH)
      binaryPath = this.deps.findResource(RESIDENT_BINARY_PATH)
      residentShaPath = this.deps.findResource(RESIDENT_SHA256_PATH)
      if (!manifestPath || !binaryPath || !existsSync(manifestPath) || !existsSync(binaryPath)) {
        return { status: base('unavailable', 'xsend 资源未随应用安装') }
      }
      manifest = parseXsendManifest(readFileSync(manifestPath, 'utf8'))
      validateXsendManifest(manifest)
      const actualHash = this.deps.hashFile(binaryPath).toLowerCase()
      if (actualHash !== manifest.resident_sha256.toLowerCase()) {
        return {
          status: base('integrity_error', 'xsend resident 二进制校验失败', {
            installed: false,
            residentBinaryPath: binaryPath,
            residentSha256: actualHash,
            error: 'resident_sha256 与 MANIFEST 不一致'
          })
        }
      }
      if (!residentShaPath || !existsSync(residentShaPath)) {
        return {
          status: base('integrity_error', 'xsend resident 校验文件缺失', {
            installed: false,
            residentBinaryPath: binaryPath,
            residentSha256: actualHash,
            error: '找不到 resident.sha256 校验文件'
          })
        }
      }
      const checksumParts = readFileSync(residentShaPath, 'utf8').trim().split(/\s+/)
      const checksum = checksumParts[0] || ''
      const checksumName = checksumParts[1] || ''
      if (
        !/^[a-f0-9]{64}$/i.test(checksum) ||
        checksum.toLowerCase() !== actualHash ||
        checksumName !== manifest.resident_binary
      ) {
        return {
          status: base('integrity_error', 'xsend resident 校验文件不一致', {
            installed: false,
            residentBinaryPath: binaryPath,
            residentSha256: actualHash,
            error: 'resident.sha256 与实际二进制不一致'
          })
        }
      }
    } catch (error) {
      return { status: base('integrity_error', 'xsend 资源校验失败', { error: errorText(error) }) }
    }

    const context: WechatContext = {}
    try {
      context.pid = await this.deps.readWechatPid()
    } catch {
      context.pid = undefined
    }
    const installedStatus = base('ready', 'xsend 资源已校验', {
      installed: true,
      residentBinaryPath: binaryPath!,
      residentSha256: manifest!.resident_sha256.toLowerCase(),
      wechatRunning: Boolean(context.pid),
      ...(context.pid ? { wechatPid: context.pid } : {})
    })
    if (context.pid !== undefined && (!Number.isInteger(context.pid) || context.pid <= 0)) {
      return {
        packageInfo: {
          manifest: manifest!,
          binaryPath: binaryPath!,
          binarySha256: manifest!.resident_sha256
        },
        context: {},
        status: {
          ...installedStatus,
          state: 'unavailable',
          ready: false,
          message: '微信进程 PID 无效',
          error: 'PID=' + String(context.pid)
        }
      }
    }
    if (!context.pid) {
      return {
        packageInfo: {
          manifest: manifest!,
          binaryPath: binaryPath!,
          binarySha256: manifest!.resident_sha256
        },
        context,
        status: {
          ...installedStatus,
          state: 'wechat_not_running',
          ready: false,
          message: '请先启动并登录 macOS 微信'
        }
      }
    }

    try {
      context.build = String(await this.deps.readWechatBuild()).trim()
    } catch (error) {
      return {
        packageInfo: {
          manifest: manifest!,
          binaryPath: binaryPath!,
          binarySha256: manifest!.resident_sha256
        },
        context,
        status: {
          ...installedStatus,
          state: 'unavailable',
          ready: false,
          error: errorText(error),
          message: '无法读取微信 CFBundleVersion'
        }
      }
    }
    if (context.build !== manifest!.wechat_build) {
      return {
        packageInfo: {
          manifest: manifest!,
          binaryPath: binaryPath!,
          binarySha256: manifest!.resident_sha256
        },
        context,
        status: {
          ...installedStatus,
          state: 'unsupported_version',
          ready: false,
          wechatBuild: context.build,
          message: '当前微信 build 不匹配 xsend resident',
          error: '需要 CFBundleVersion=' + manifest!.wechat_build
        }
      }
    }

    const dylibPath =
      this.deps.wechatDylibPath ||
      (this.deps.wechatAppPath || WECHAT_APP_PATH) + '/Contents/Resources/wechat.dylib'
    if (!existsSync(dylibPath)) {
      return {
        packageInfo: {
          manifest: manifest!,
          binaryPath: binaryPath!,
          binarySha256: manifest!.resident_sha256
        },
        context,
        status: {
          ...installedStatus,
          state: 'unavailable',
          ready: false,
          wechatBuild: context.build,
          message: '找不到微信核心 dylib',
          error: dylibPath
        }
      }
    }
    try {
      context.dylibSha256 = this.deps.hashFile(dylibPath).toLowerCase()
    } catch (error) {
      return {
        packageInfo: {
          manifest: manifest!,
          binaryPath: binaryPath!,
          binarySha256: manifest!.resident_sha256
        },
        context,
        status: {
          ...installedStatus,
          state: 'integrity_error',
          ready: false,
          wechatBuild: context.build,
          message: '无法校验微信核心 dylib',
          error: errorText(error)
        }
      }
    }
    if (context.dylibSha256 !== manifest!.wechat_dylib_sha256.toLowerCase()) {
      return {
        packageInfo: {
          manifest: manifest!,
          binaryPath: binaryPath!,
          binarySha256: manifest!.resident_sha256
        },
        context,
        status: {
          ...installedStatus,
          state: 'integrity_error',
          ready: false,
          wechatBuild: context.build,
          message: '当前微信核心 dylib 与 xsend resident 不匹配',
          error: 'wechat.dylib 指纹不匹配'
        }
      }
    }

    return {
      packageInfo: {
        manifest: manifest!,
        binaryPath: binaryPath!,
        binarySha256: manifest!.resident_sha256
      },
      context,
      status: {
        ...installedStatus,
        wechatBuild: context.build,
        message: 'xsend 资源与当前微信版本匹配'
      }
    }
  }

  private async invoke(binaryPath: string, args: string[]): Promise<XsendV3Receipt> {
    const result = await this.deps.execFile(binaryPath, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT
    })
    return parseXsendReceipt(toText(result.stdout) + '\n' + toText(result.stderr))
  }

  private statusFromReceipt(
    preflight: XsendPreflight,
    receipt: XsendV3Receipt,
    statusCommand: boolean
  ): PersonalWechatXsendStatus {
    const base = preflight.status
    const common = {
      ...base,
      requestId: receipt.requestId,
      ...(receipt.queue !== undefined ? { queue: receipt.queue } : {}),
      ...(receipt.retained !== undefined ? { retained: receipt.retained } : {}),
      ...(receipt.detail ? { detail: receipt.detail } : {})
    }
    if (receipt.state === 2) {
      return {
        ...common,
        state: 'ready',
        ready: true,
        message: statusCommand ? 'xsend resident 已就绪，可发送文字' : 'xsend 文字发送已完成'
      }
    }
    if (receipt.state === 1) {
      return {
        ...common,
        state: 'accepted',
        ready: false,
        message: 'xsend 已接受请求，尚未确认完成'
      }
    }
    if (receipt.state === 3) {
      return { ...common, state: 'unknown', ready: false, message: 'xsend 未能确认 resident 状态' }
    }
    if (/not[_ -]?installed|未安装/i.test(receipt.detail || '')) {
      return { ...common, state: 'not_installed', ready: false, message: 'xsend resident 尚未安装' }
    }
    return {
      ...common,
      state: 'failed',
      ready: false,
      message: 'xsend resident 请求失败',
      error: receipt.detail || 'xsend 返回 state=0'
    }
  }
}

export const xsendV3Service = new XsendV3Service()
