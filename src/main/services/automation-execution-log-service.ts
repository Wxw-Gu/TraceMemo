import path from 'node:path'
import { app } from 'electron'
import fs from 'fs-extra'
import type { AutomationExecution } from '../../shared/automation'

/**
 * AutomationExecutionLogService —— **用户层**执行日志。
 *
 * 与 debug 日志的区别：这份记录是给用户看「哪一步坏了」的，所以
 * - 只保留用户可读字段（规则名、来源显示名、步骤状态、耗时、错误）；
 * - **不含** wxid / localId / serverId / source XML / raw payload / 图片绝对路径；
 * - 必须落盘，重启后还能看到近期记录。
 *
 * 容量有界（`MAX_RECORDS`），否则长期运行会把文件撑到几十兆。
 */

const STORAGE_DIR = 'automation'
const EXECUTIONS_FILE = 'executions.json'
const MAX_RECORDS = 200

export interface AutomationExecutionLogDependencies {
  userDataPath?: () => string
}

const EXECUTION_STATUSES: AutomationExecution['status'][] = ['running', 'success', 'failed']

function normalizeExecution(value: unknown): AutomationExecution | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<AutomationExecution>
  const executionId = String(record.executionId || '').trim()
  if (!executionId) return null
  return {
    executionId,
    ruleId: String(record.ruleId || ''),
    ruleName: String(record.ruleName || ''),
    triggerTime: Number(record.triggerTime) || 0,
    sourceDisplayName: String(record.sourceDisplayName || ''),
    // 不认识的 status（含历史遗留值）一律降级成 `running`，绝不凭空造出成功/失败。
    status: EXECUTION_STATUSES.includes(record.status as AutomationExecution['status'])
      ? (record.status as AutomationExecution['status'])
      : 'running',
    durationMs: Number(record.durationMs) || 0,
    steps: Array.isArray(record.steps) ? record.steps : [],
    ...(record.errorSummary ? { errorSummary: String(record.errorSummary) } : {})
  }
}

export class AutomationExecutionLogService {
  private readonly userDataPath: () => string
  private records: AutomationExecution[] = []
  private loaded = false

  constructor(dependencies: AutomationExecutionLogDependencies = {}) {
    this.userDataPath = dependencies.userDataPath ?? (() => app.getPath('userData'))
  }

  list(query: { limit?: number } = {}): AutomationExecution[] {
    this.ensureLoaded()
    const requested = Number(query?.limit)
    const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : MAX_RECORDS
    return this.records.slice(0, Math.min(limit, MAX_RECORDS)).map((record) => structuredClone(record))
  }

  /**
   * 写入（或按 `executionId` 覆盖）一条执行记录。
   *
   * 覆盖语义是必需的：执行是「先建 running、跑完再回落终态」，
   * 中间态与终态共用同一个 `executionId`。
   */
  record(execution: AutomationExecution): void {
    this.ensureLoaded()
    const normalized = normalizeExecution(execution)
    if (!normalized) return
    const withoutSame = this.records.filter((item) => item.executionId !== normalized.executionId)
    this.records = [normalized, ...withoutSame].slice(0, MAX_RECORDS)
    this.persist()
  }

  clear(): boolean {
    this.ensureLoaded()
    this.records = []
    this.persist()
    return true
  }

  /**
   * 统计 `sinceMs` 之后（含）的记录数与成功数。用于顶部「今日执行」。
   *
   * 每条记录都对应一次**真正跑过**的执行（gate 拦下的消息不会产生记录），
   * 所以这里直接计数即可。
   */
  countSince(sinceMs: number): { total: number; success: number } {
    this.ensureLoaded()
    const from = Number(sinceMs) || 0
    let total = 0
    let success = 0
    for (const record of this.records) {
      if (record.triggerTime < from) continue
      total += 1
      if (record.status === 'success') success += 1
    }
    return { total, success }
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = fs.readJsonSync(this.executionsFilePath()) as unknown
      const values = Array.isArray(raw) ? raw : []
      this.records = values
        .map((value) => normalizeExecution(value))
        .filter((value): value is AutomationExecution => value !== null)
        .slice(0, MAX_RECORDS)
    } catch {
      this.records = []
    }
  }

  private executionsFilePath(): string {
    return path.join(this.userDataPath(), STORAGE_DIR, EXECUTIONS_FILE)
  }

  private persist(): void {
    try {
      const filePath = this.executionsFilePath()
      fs.ensureDirSync(path.dirname(filePath))
      fs.writeJsonSync(filePath, this.records, { spaces: 2 })
    } catch (error) {
      console.warn(
        `[Automation] 保存执行日志失败: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

export const automationExecutionLogService = new AutomationExecutionLogService()
