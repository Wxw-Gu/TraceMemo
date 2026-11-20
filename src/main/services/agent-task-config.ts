import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * WorkBuddy Agent 接入配置。
 *
 * **默认禁用**：`enabled` 为 false 时 dispatcher 不读任何消息，也不会做在线检测。
 *
 * 配置来源（只认这两种）：
 * 1. `<userData>/workbuddy-agent.json` —— 非敏感开关；
 * 2. 环境变量 —— **只放凭证**，不落盘、不进 Git、不进日志。
 *
 * 配置文件里出现的 `accessToken` / `clientSecret` 等字段会被忽略：
 * 凭证的唯一合法入口是环境变量，避免用户把 secret 写进可同步的目录。
 */

export interface WorkBuddyAgentSettings {
  enabled: boolean
  /** 允许触发 `/ai` 的会话 md5 白名单；为空 = 不触发任何会话。 */
  allowedConversations: string[]
  /** 命令前缀，默认 `/ai`。只接受「前缀 + 空白」或整条等于前缀。 */
  commandPrefix: string
  baseUrl: string
  timeoutMs: number
  pollIntervalMs: number
  /** 单任务最长等待回复时间（毫秒）。超时后状态置 `timeout`，不再轮询。 */
  maxPollDurationMs: number
}

export interface WorkBuddyCredentials {
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
}

export const WORKBUDDY_AGENT_CONFIG_FILE = 'workbuddy-agent.json'

export const DEFAULT_WORKBUDDY_AGENT_SETTINGS: WorkBuddyAgentSettings = Object.freeze({
  enabled: false,
  allowedConversations: [],
  commandPrefix: '/ai',
  baseUrl: 'https://www.workbuddy.cn',
  timeoutMs: 15_000,
  pollIntervalMs: 3_000,
  maxPollDurationMs: 120_000
})

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function asPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

function asConversationList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || ids.includes(trimmed)) continue
    ids.push(trimmed)
  }
  return ids
}

export function resolveWorkBuddyAgentConfigPath(userDataDir?: string): string {
  const root = userDataDir || app.getPath('userData')
  return path.join(root, WORKBUDDY_AGENT_CONFIG_FILE)
}

/**
 * 读取配置。文件不存在 / JSON 损坏 / 字段类型不对，一律回落到默认值（**禁用**），
 * 不抛错 —— 一个坏配置文件不应该让主进程启动失败。
 */
export function loadWorkBuddyAgentSettings(
  userDataDir?: string,
  defaults: WorkBuddyAgentSettings = DEFAULT_WORKBUDDY_AGENT_SETTINGS
): WorkBuddyAgentSettings {
  let parsed: Record<string, unknown> = {}
  try {
    const filePath = resolveWorkBuddyAgentConfigPath(userDataDir)
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      const value = JSON.parse(raw) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>
      }
    }
  } catch {
    parsed = {}
  }

  return {
    enabled: parsed.enabled === true,
    allowedConversations: asConversationList(parsed.allowedConversations),
    commandPrefix: asString(parsed.commandPrefix, defaults.commandPrefix),
    baseUrl: asString(parsed.baseUrl, defaults.baseUrl).replace(/\/+$/, ''),
    timeoutMs: asPositiveInt(parsed.timeoutMs, defaults.timeoutMs, 60_000),
    pollIntervalMs: asPositiveInt(parsed.pollIntervalMs, defaults.pollIntervalMs, 60_000),
    maxPollDurationMs: asPositiveInt(
      parsed.maxPollDurationMs,
      defaults.maxPollDurationMs,
      30 * 60_000
    )
  }
}

/**
 * 只从环境变量读取凭证。
 *
 * 返回值可能全部为空 —— 调用方必须把这种情况当作 `auth_missing` 处理，
 * 而不是回落到某个内置默认值。
 */
export function loadWorkBuddyCredentials(
  env: NodeJS.ProcessEnv = process.env
): WorkBuddyCredentials {
  const pick = (key: string): string | undefined => {
    const value = env[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  return {
    accessToken: pick('TRACEMEMO_WORKBUDDY_ACCESS_TOKEN'),
    refreshToken: pick('TRACEMEMO_WORKBUDDY_REFRESH_TOKEN'),
    clientId: pick('TRACEMEMO_WORKBUDDY_CLIENT_ID'),
    clientSecret: pick('TRACEMEMO_WORKBUDDY_CLIENT_SECRET')
  }
}

/** 是否具备可用的凭证组合（无需真的请求成功）。 */
export function hasWorkBuddyCredentials(credentials: WorkBuddyCredentials): boolean {
  if (credentials.accessToken) return true
  return Boolean(credentials.refreshToken && credentials.clientId && credentials.clientSecret)
}
