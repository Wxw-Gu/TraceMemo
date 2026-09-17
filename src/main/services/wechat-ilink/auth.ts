import { ILinkError } from './errors'
import { ILinkClient, type FetchLike } from './client'
import { loadAllCredentials, saveCredentials, type HomeDirectoryResolver } from './account-store'
import {
  ILINK_DEFAULT_BASE_URL,
  ILINK_QR_STATUS_TIMEOUT_MS,
  type ILinkCredentials,
  type ILinkQrCodeResponse,
  type ILinkQrStatusResponse,
  type WechatLoginEvent
} from './types'

const QR_CODE_PATH = '/ilink/bot/get_bot_qrcode?bot_type=3'
const QR_STATUS_PATH = '/ilink/bot/get_qrcode_status'

/** 官方客户端策略（非协议常量）：本地二维码 TTL 约 5 分钟，整体等待约 480 秒。 */
const QR_SESSION_TTL_MS = 5 * 60_000
const LOGIN_DEADLINE_MS = 480_000
const MAX_QR_REFRESHES = 3
/** 等待用户输入数字配对码的上限。 */
const VERIFY_CODE_WAIT_MS = 60_000

export type QrEncoder = (content: string) => Promise<string>

export interface QrLoginDependencies {
  fetchImpl?: FetchLike
  home?: HomeDirectoryResolver
  baseUrl?: string
  signal?: AbortSignal
  onEvent?: (event: WechatLoginEvent) => void
  /** 把二维码内容渲染成可直接给 <img src> 的 data URL。 */
  qrEncoder?: QrEncoder
  /** 手机端要求数字配对码时，由宿主提供；返回 undefined 表示放弃这次登录。 */
  verifyCodeProvider?: () => Promise<string | undefined>
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  maxQrRefreshes?: number
  deadlineMs?: number
}

/**
 * 默认二维码渲染器：把服务端返回的内容编码成二维码 PNG。
 * 服务端返回的是二维码页面 URL，因此这里必须自己编码，而不是当作图片直传。
 */
const defaultQrEncoder: QrEncoder = async (content) => {
  if (/^data:image\//i.test(content)) return content
  const { toDataURL } = await import('qrcode')
  return toDataURL(content, { errorCorrectionLevel: 'L', margin: 1, width: 320 })
}

interface LoginState {
  host: string
  verifyCode?: string
  pendingVerifyCode?: boolean
}

/** 等待用户输入配对码；超时视为放弃本次尝试，改为刷新二维码而不是无限等待。 */
function awaitVerifyCode(
  provider: () => Promise<string | undefined>,
  waitMs: number
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), waitMs)
    provider().then(
      (value) => finish(value),
      () => finish(undefined)
    )
  })
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

interface QrStatusPollResult {
  outcome: 'continue' | 'refresh' | 'done'
  credentials?: ILinkCredentials
}

async function pollOnce(
  client: ILinkClient,
  qrcode: string,
  state: LoginState,
  deps: Required<Pick<QrLoginDependencies, 'onEvent' | 'now'>> & QrLoginDependencies
): Promise<QrStatusPollResult> {
  const query = new URLSearchParams({ qrcode })
  if (state.verifyCode) query.set('verify_code', state.verifyCode)
  const url = `${state.host}${QR_STATUS_PATH}?${query.toString()}`

  let response: ILinkQrStatusResponse
  try {
    response = await client.getAnonymous<ILinkQrStatusResponse>(url, '二维码状态轮询', {
      timeoutMs: ILINK_QR_STATUS_TIMEOUT_MS,
      ...(deps.signal ? { signal: deps.signal } : {})
    })
  } catch (error) {
    if (isCancelled(deps.signal)) throw error
    // 网络超时 / 网关 524 属于长轮询正常控制流：保持当前二维码继续轮询。
    return { outcome: 'continue' }
  }

  const status = String(response.status || '').trim()
  switch (status) {
    case 'wait':
      deps.onEvent({ status: 'wait' })
      return { outcome: 'continue' }

    case 'scaned':
      // 已扫码：若上一次轮询携带过配对码，说明已被接受，清除暂存值。
      state.verifyCode = undefined
      deps.onEvent({ status: 'scaned' })
      return { outcome: 'continue' }

    case 'need_verifycode': {
      deps.onEvent({ status: 'need_verifycode' })
      state.verifyCode = undefined
      if (state.pendingVerifyCode) return { outcome: 'continue' }
      state.pendingVerifyCode = true
      const provider = deps.verifyCodeProvider
      if (!provider) return { outcome: 'refresh' }
      const code = await awaitVerifyCode(provider, VERIFY_CODE_WAIT_MS)
      state.pendingVerifyCode = false
      const normalized = String(code ?? '').trim()
      if (!normalized) return { outcome: 'refresh' }
      state.verifyCode = normalized
      return { outcome: 'continue' }
    }

    case 'verify_code_blocked':
      // 多次输入错误被限制：清除配对码并刷新二维码，由调用方计数。
      deps.onEvent({ status: 'verify_code_blocked' })
      state.verifyCode = undefined
      state.pendingVerifyCode = false
      return { outcome: 'refresh' }

    case 'scaned_but_redirect': {
      // 状态轮询需要切换 IDC 节点；只切换状态轮询主机，不影响已保存的 baseurl。
      const redirectHost = String(response.redirect_host || '').trim()
      if (redirectHost) {
        state.host = /^https?:\/\//.test(redirectHost)
          ? redirectHost.replace(/\/+$/, '')
          : `https://${redirectHost.replace(/\/+$/, '')}`
      }
      return { outcome: 'continue' }
    }

    case 'binded_redirect': {
      // 账号已绑定到本客户端：只有本地确实仍有可用凭据时才能视为成功。
      const existing = loadAllCredentials(deps.home)
      const reusable = existing[existing.length - 1]
      if (!reusable) return { outcome: 'refresh' }
      deps.onEvent({ status: 'confirmed' })
      return { outcome: 'done', credentials: reusable }
    }

    case 'expired':
      deps.onEvent({ status: 'expired' })
      return { outcome: 'refresh' }

    case 'confirmed': {
      const accountId = String(response.ilink_bot_id || '').trim()
      if (!accountId) {
        throw new ILinkError({
          kind: 'protocol',
          message: '登录已确认，但服务端未返回 ilink_bot_id'
        })
      }
      const credentials: ILinkCredentials = {
        bot_token: String(response.bot_token || ''),
        ilink_bot_id: accountId,
        baseurl: String(response.baseurl || deps.baseUrl || ILINK_DEFAULT_BASE_URL),
        ilink_user_id: String(response.ilink_user_id || '')
      }
      if (!credentials.bot_token) {
        throw new ILinkError({ kind: 'protocol', message: '登录已确认，但服务端未返回 bot_token' })
      }
      deps.onEvent({ status: 'confirmed' })
      return { outcome: 'done', credentials }
    }

    default:
      // 未知状态按 wait 处理，避免因为服务端新增状态直接打断登录。
      return { outcome: 'continue' }
  }
}

/**
 * 扫码登录。
 *
 * 状态机与官方客户端对齐：wait / scaned / need_verifycode / verify_code_blocked /
 * scaned_but_redirect / binded_redirect / expired / confirmed。
 * 成功后立即原子落盘，且先写新凭据再清理旧账号，失败登录不会摧毁可用凭据。
 */
export async function runQrLogin(deps: QrLoginDependencies = {}): Promise<ILinkCredentials> {
  const baseUrl = (deps.baseUrl || ILINK_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ?? ((milliseconds: number) => new Promise<void>((r) => setTimeout(r, milliseconds)))
  const onEvent = deps.onEvent ?? ((): void => undefined)
  const maxRefreshes = deps.maxQrRefreshes ?? MAX_QR_REFRESHES
  const deadline = deps.deadlineMs ?? LOGIN_DEADLINE_MS
  const qrEncoder = deps.qrEncoder ?? defaultQrEncoder

  const client = new ILinkClient({
    baseUrl,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
  })

  const startedAt = now()
  let refreshes = 0

  while (true) {
    if (isCancelled(deps.signal)) {
      throw new ILinkError({ kind: 'aborted', message: '登录已取消' })
    }
    if (now() - startedAt > deadline) {
      throw new ILinkError({ kind: 'timeout', message: '登录超时，请重新获取二维码' })
    }

    // local_token_list 只在取二维码时上报，便于服务端判断是否已绑定。
    const localTokenList = loadAllCredentials(deps.home)
      .map((item) => item.bot_token)
      .filter(Boolean)
      .slice(-10)

    const qrResponse = await client.postAnonymous<ILinkQrCodeResponse>(
      QR_CODE_PATH,
      { local_token_list: localTokenList },
      '获取登录二维码',
      { timeoutMs: 20_000, ...(deps.signal ? { signal: deps.signal } : {}) }
    )
    const qrcode = String(qrResponse.qrcode || '').trim()
    const qrcodeContent = String(qrResponse.qrcode_img_content || '').trim()
    if (!qrcode || !qrcodeContent) {
      throw new ILinkError({ kind: 'protocol', message: '服务端未返回有效的登录二维码' })
    }

    const qrCodeDataUrl = await qrEncoder(qrcodeContent)
    onEvent({ status: 'qrcode', qrCodeDataUrl })

    const state: LoginState = { host: baseUrl }
    const sessionDeadline = now() + QR_SESSION_TTL_MS
    let refresh = false

    while (!refresh) {
      if (isCancelled(deps.signal)) {
        throw new ILinkError({ kind: 'aborted', message: '登录已取消' })
      }
      if (now() > sessionDeadline || now() - startedAt > deadline) {
        throw new ILinkError({ kind: 'timeout', message: '二维码已过期，请重新获取' })
      }

      const result = await pollOnce(client, qrcode, state, {
        ...deps,
        onEvent,
        now
      })

      if (result.outcome === 'done') {
        const credentials = result.credentials!
        saveCredentials(credentials, deps.home)
        onEvent({
          status: 'active',
          accountId: credentials.ilink_bot_id,
          wechatUserId: credentials.ilink_user_id
        })
        return credentials
      }

      if (result.outcome === 'refresh') {
        refreshes += 1
        if (refreshes > maxRefreshes) {
          throw new ILinkError({
            kind: 'protocol',
            message: '二维码多次刷新后仍未完成登录，请稍后重试'
          })
        }
        refresh = true
        continue
      }

      // 避免空转打满接口。
      await sleep(300)
    }
  }
}
