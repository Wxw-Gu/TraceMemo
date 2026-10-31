/**
 * 微信内退群监控消息 —— 事件驱动的一次性插入。
 *
 * 为什么不再用 persistent trigger
 * ------------------------------
 * 退群提示以前是给每个监控群装一条 `_tm_msg_insert_queue` 规则，靠微信自己插消息时
 * 触发。问题：粒度是「群 × 分片」，监控群一多就要铺成百上千条规则；而退群这个事实
 * TraceMemo 本来就已经知道了（GroupExitMonitorService 是**唯一**退群事实源）。
 * 让数据库再算一遍，等于维护两套退群判断，迟早不一致。
 *
 * 现在改成：
 *   GroupExitMonitorService → GroupMemberExitedEvent → 本服务 → one-shot helper 插一条
 *
 * 三条硬约束（都不能违反）
 * ------------------------
 *   1. **不产生第二套退群事实**：本服务只消费事件、只插消息，从不自己判断谁退群。
 *   2. **失败不回滚、不阻塞**：插入失败绝不能让退群事件回滚、不能影响监控循环、
 *      不能影响自动化通知。所以 handleExitEvent **永不抛异常**，调用方也不必 await。
 *   3. **幂等**：以 eventId 为幂等键，同一事件最多插一次。幂等日志写在微信库里
 *      （不是内存），所以跨进程、跨重启都有效。
 *
 * 只插一个目标消息存储：写入分片由 native 侧按 MAX(sort_seq) 选出，不在历史分片
 * 重复插入。没有可插入的消息表时返回 NO_MESSAGE_STORE，TraceMemo 内部的退群记录
 * 照常保留。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import type { GroupMemberExitedEvent } from '../../shared/group-exit-event'
import { renderLeaveNotificationText } from '../../shared/group-exit-event'
import { GROUP_EXIT_NOTIFICATION_TEMPLATE } from '../../shared/group-exit-monitor'
import { findResource } from '../resource-paths'
import { isMacNativeRuntimeUnavailable, resolveWcdbConfigHelper } from '../native-runtime-paths'

export type LocalExitNoticeOutcome =
  | 'inserted'
  | 'duplicate'
  | 'disabled'
  | 'no_message_store'
  | 'failed'
  | 'helper_unavailable'

export interface LocalExitNoticeResult {
  outcome: LocalExitNoticeOutcome
  eventId: string
  conversationId: string
  shard?: string
  localId?: number
  /** 机器可读的原因，只进日志 */
  code?: string
}

interface StoredState {
  enabled?: boolean
}

const HELPER_NAME = 'tm-wcdb-config-helper'
const HELPER_TIMEOUT_MS = 20_000
/** 最近若干次插入结果，只用于诊断展示，不参与判定 */
const RECENT_LIMIT = 50

function helperPath(): string | null {
  if (process.platform === 'darwin') return resolveWcdbConfigHelper()
  /* 与 msg-insert-switch-service 的 resolveHelperPath 保持一致：
   * Windows 走 wcdb/win32/<arch>/ 且文件名带 .exe。 */
  const arch = process.arch === 'x64' ? 'x64' : 'arm64'
  const other = arch === 'arm64' ? 'x64' : 'arm64'
  const platformDir = process.platform === 'win32' ? 'win32' : 'macos'
  const suffix = process.platform === 'win32' ? '.exe' : ''
  for (const candidate of [
    `wcdb/${platformDir}/${arch}/${HELPER_NAME}${suffix}`,
    `wcdb/${platformDir}/${other}/${HELPER_NAME}${suffix}`,
    `wcdb/${platformDir}/${HELPER_NAME}${suffix}`
  ]) {
    const resolved = findResource(candidate)
    if (resolved) return resolved
  }
  return null
}

/**
 * 退群本地提示服务。
 *
 * 与 GroupExitMonitorService 是**消费**关系：它发事件，这里负责往微信里插一条。
 * 这里不持有任何群列表，也不判断退群 —— 避免第二套事实源。
 */
export class WechatLocalExitNoticeService {
  private enabled = false
  private loaded = false
  private recent: LocalExitNoticeResult[] = []

  private statePath(): string {
    return path.join(app.getPath('userData'), 'wechat-local-exit-notice.json')
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = fs.readFileSync(this.statePath(), 'utf8')
      const stored = JSON.parse(raw) as StoredState
      this.enabled = stored.enabled === true
    } catch {
      this.enabled = false
    }
  }

  isEnabled(): boolean {
    this.ensureLoaded()
    return this.enabled
  }

  setEnabled(enabled: boolean): { enabled: boolean; error?: string } {
    this.ensureLoaded()
    this.enabled = enabled === true
    try {
      fs.mkdirSync(path.dirname(this.statePath()), { recursive: true })
      fs.writeFileSync(this.statePath(), JSON.stringify({ enabled: this.enabled }, null, 2), 'utf8')
      return { enabled: this.enabled }
    } catch (error) {
      return {
        enabled: this.enabled,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  getRecent(): LocalExitNoticeResult[] {
    return [...this.recent]
  }

  private remember(result: LocalExitNoticeResult): void {
    this.recent = [result, ...this.recent].slice(0, RECENT_LIMIT)
  }

  /**
   * 处理一次退群事件。
   *
   * ⚠️ 本方法**永不抛异常**：它挂在退群监控的事件回调上，抛出去会污染监控循环。
   * 返回值只用于日志与诊断，调用方不需要（也不应该）等它。
   */
  async handleExitEvent(event: GroupMemberExitedEvent): Promise<LocalExitNoticeResult> {
    const base: LocalExitNoticeResult = {
      outcome: 'failed',
      eventId: event.eventId,
      conversationId: event.conversationId
    }
    try {
      this.ensureLoaded()
      if (isMacNativeRuntimeUnavailable()) {
        return this.finish({ ...base, outcome: 'disabled', code: 'SEND_CAPABILITY_UNAVAILABLE' })
      }
      if (!this.enabled) return this.finish({ ...base, outcome: 'disabled', code: 'DISABLED' })
      if (!event.eventId || !event.conversationId) {
        return this.finish({ ...base, outcome: 'failed', code: 'EVENT_INCOMPLETE' })
      }

      const resolved = helperPath()
      if (!resolved) {
        return this.finish({ ...base, outcome: 'helper_unavailable', code: 'HELPER_NOT_FOUND' })
      }

      const key = resolveDatabaseKey()
      const myWxid = resolveMyWxid()
      if (!key || !myWxid) {
        return this.finish({ ...base, outcome: 'failed', code: 'DATABASE_UNAVAILABLE' })
      }

      const accountRoot = resolveAccountRoot()
      if (!accountRoot) {
        return this.finish({ ...base, outcome: 'failed', code: 'ACCOUNT_ROOT_UNRESOLVED' })
      }

      const text = renderLeaveNotificationText(event, GROUP_EXIT_NOTIFICATION_TEMPLATE)
      const payload = JSON.stringify({
        key,
        myWxid,
        roomId: event.conversationId,
        text,
        dedupeKey: event.eventId
      })

      const parsed = await runInsertHelper(resolved, accountRoot, payload)
      if (!parsed) {
        return this.finish({ ...base, outcome: 'failed', code: 'HELPER_BAD_OUTPUT' })
      }

      const code = String(parsed.code || '')
      const shard = typeof parsed.shard === 'string' && parsed.shard ? parsed.shard : undefined
      const localId = Number(parsed.localId) || undefined
      if (parsed.ok === true) {
        return this.finish({
          ...base,
          outcome: code === 'ALREADY_INSERTED' ? 'duplicate' : 'inserted',
          shard,
          localId,
          code
        })
      }
      if (code === 'NO_MESSAGE_STORE') {
        return this.finish({ ...base, outcome: 'no_message_store', code })
      }
      return this.finish({ ...base, outcome: 'failed', shard, localId, code })
    } catch (error) {
      /* 兜底：任何意外都不许冒到监控循环里去。 */
      return this.finish({
        ...base,
        outcome: 'failed',
        code: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private finish(result: LocalExitNoticeResult): LocalExitNoticeResult {
    this.remember(result)
    if (result.outcome === 'failed' || result.outcome === 'helper_unavailable') {
      console.warn(
        `[LocalExitNotice] 插入未成功 outcome=${result.outcome} code=${result.code || 'UNKNOWN'}`
      )
    }
    return result
  }
}

export const wechatLocalExitNoticeService = new WechatLocalExitNoticeService()

/* --------------------------------------------------------------- 依赖注入 */

interface LocalExitRuntime {
  resolveDatabaseKey: () => string
  resolveMyWxid: () => string
  resolveAccountRoot: () => string
}

let runtime: LocalExitRuntime | null = null

/** 由主进程在启动时注入；这样服务本身不依赖 chat-service 的具体形态。 */
export function configureWechatLocalExitNotice(next: LocalExitRuntime): void {
  runtime = next
}

function resolveDatabaseKey(): string {
  try {
    return runtime?.resolveDatabaseKey() || ''
  } catch {
    return ''
  }
}

function resolveMyWxid(): string {
  try {
    return runtime?.resolveMyWxid() || ''
  } catch {
    return ''
  }
}

function resolveAccountRoot(): string {
  try {
    return runtime?.resolveAccountRoot() || ''
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ 执行 */

function runInsertHelper(
  executable: string,
  accountRoot: string,
  payload: string
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable, ['--account-root', accountRoot, '--action', 'insert-notice'], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      resolve(null)
      return
    }

    let stdout = ''
    let settled = false
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
      finish(null)
    }, HELPER_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', () => {
      /* 人类日志直接丢弃：里面不该有密钥，也没必要留 */
    })
    child.on('error', () => finish(null))
    child.on('close', () => {
      try {
        const lines = stdout.trim().split('\n').filter(Boolean)
        finish(JSON.parse(lines[lines.length - 1] || '') as Record<string, unknown>)
      } catch {
        finish(null)
      }
    })
    try {
      child.stdin?.write(`${payload}\n`)
      child.stdin?.end()
    } catch {
      finish(null)
    }
  })
}
