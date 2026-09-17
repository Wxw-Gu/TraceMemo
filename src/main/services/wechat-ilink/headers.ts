import { randomBytes } from 'node:crypto'
import {
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  ILINK_CHANNEL_VERSION,
  ILINK_DEFAULT_BOT_AGENT,
  type ILinkBaseInfo
} from './types'

/** bot_agent 的官方约束：仅 ASCII、总分不超过 256 字节、非法 token 丢弃。 */
const BOT_AGENT_MAX_BYTES = 256
const BOT_AGENT_FALLBACK = 'OpenClaw'
const BOT_AGENT_TOKEN = /^[!-~]+(?:\/[!-~]+)?(?:\([!-~ ]*\))?$/

export interface ILinkHeaderOptions {
  /** 覆盖 bot_agent，用于多产品共用同一实现时做归因。仅进入 base_info，不额外造头。 */
  botAgent?: string
}

/**
 * 清洗 bot_agent。
 * 该字段只用于服务端观测聚合，不参与鉴权与路由，因此宁可回退也不抛错。
 */
export function sanitizeBotAgent(value: string | undefined): string {
  const tokens = String(value ?? '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && BOT_AGENT_TOKEN.test(token))
  let result = tokens.join(' ')
  if (!result) result = BOT_AGENT_FALLBACK
  while (Buffer.byteLength(result, 'utf8') > BOT_AGENT_MAX_BYTES && result.includes(' ')) {
    result = result.slice(0, result.lastIndexOf(' '))
  }
  if (Buffer.byteLength(result, 'utf8') > BOT_AGENT_MAX_BYTES) result = BOT_AGENT_FALLBACK
  return result
}

/**
 * X-WECHAT-UIN：随机 uint32 的十进制字符串再做 base64。
 * 官方要求**每次请求重新生成**以防重放，一个客户端只生成一次是不合规的。
 */
export function generateWechatUin(): string {
  const value = randomBytes(4).readUInt32LE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

/** 所有 POST 请求都会带的公共头（含登录前的二维码接口）。 */
export function buildCommonHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION
  }
}

/**
 * 二维码状态轮询使用未鉴权的最小头集合（官方 2.4.6 不再带 Content-Type）。
 * 注意：不自造 SKRouteTag，那是官方内部的路由/调试开关。
 */
export function buildQrStatusHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION
  }
}

/** 登录后的业务请求头；未登录时不得携带 Authorization。 */
export function buildAuthorizedHeaders(botToken: string): Record<string, string> {
  if (!botToken) throw new Error('buildAuthorizedHeaders 需要有效的 bot token')
  return {
    ...buildCommonHeaders(),
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${botToken}`,
    'X-WECHAT-UIN': generateWechatUin()
  }
}

/** 每个业务请求体都要带 base_info。 */
export function buildBaseInfo(options: ILinkHeaderOptions = {}): ILinkBaseInfo {
  return {
    channel_version: ILINK_CHANNEL_VERSION,
    bot_agent: sanitizeBotAgent(options.botAgent ?? ILINK_DEFAULT_BOT_AGENT)
  }
}
