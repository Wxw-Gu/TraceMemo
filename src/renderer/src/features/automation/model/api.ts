import type {
  AutomationExecution,
  AutomationRule,
  AutomationRuleDraft,
  AutomationStatusSummary
} from '../../../../../shared/automation'

/**
 * `window.api` 的薄封装。
 *
 * 存在的理由：preload 暴露的方法在「数据库还没解锁」「preload 与渲染层版本不一致」
 * 等情况下可能缺失。直接 `window.api.getAutomationStatus()` 会抛
 * `not a function`，整个页面白屏 —— 用户看到的就是一个坏掉的菜单。
 * 这里统一降级，让页面始终能渲染出一个**如实说明自己不可用**的状态。
 *
 * 只读查询失败 → 返回安全默认值；写操作失败 → 返回 `null` / `false`，
 * 由调用方决定提示文案（**绝不**假装成功）。
 */

export interface AutomationGroupOption {
  id: string
  name: string
}

export const UNAVAILABLE_STATUS: AutomationStatusSummary = {
  listening: false,
  listeningDegraded: true,
  todayExecutions: 0,
  todaySuccesses: 0,
  sendCapability: {
    supported: false,
    ready: false,
    canSendText: false,
    canSendImage: false,
    message: '自动化能力尚未就绪'
  }
}

function apiTarget(): Record<string, unknown> | undefined {
  if (typeof window === 'undefined') return undefined
  const target = window.api as unknown as Record<string, unknown> | undefined
  return target ?? undefined
}

/**
 * 调用一个可能不存在的 preload 方法。
 *
 * - 方法缺失 / 抛异常 / reject / 返回空值 → 一律返回 `fallback`。
 * - 刻意不区分「方法不存在」与「调用失败」：对界面而言，两者都只是「暂时拿不到」。
 */
function invoke<T>(name: string, fallback: T, ...args: unknown[]): Promise<T> {
  const target = apiTarget()
  const fn = target?.[name]
  if (typeof fn !== 'function') return Promise.resolve(fallback)
  try {
    const result = (fn as (...input: unknown[]) => Promise<T>).apply(target, args)
    if (!result || typeof result.then !== 'function') return Promise.resolve(fallback)
    return result.then(
      (value) => (value === undefined || value === null ? fallback : value),
      () => fallback
    )
  } catch {
    return Promise.resolve(fallback)
  }
}

/** 自动化接口是否可用（preload 未更新时为 false）。 */
export function isAutomationApiAvailable(): boolean {
  return typeof apiTarget()?.getAutomationStatus === 'function'
}

export const automationApi = {
  getStatus: (): Promise<AutomationStatusSummary> =>
    invoke('getAutomationStatus', UNAVAILABLE_STATUS),

  listRules: (): Promise<AutomationRule[]> => invoke('listAutomationRules', []),

  createRule: (draft: AutomationRuleDraft): Promise<AutomationRule | null> =>
    invoke<AutomationRule | null>('createAutomationRule', null, draft),

  updateRule: (id: string, draft: AutomationRuleDraft): Promise<AutomationRule | null> =>
    invoke<AutomationRule | null>('updateAutomationRule', null, id, draft),

  deleteRule: (id: string): Promise<boolean> => invoke('deleteAutomationRule', false, id),

  setRuleEnabled: (id: string, enabled: boolean): Promise<AutomationRule | null> =>
    invoke<AutomationRule | null>('setAutomationRuleEnabled', null, id, enabled),

  listExecutions: (limit = 100): Promise<AutomationExecution[]> =>
    invoke('listAutomationExecutions', [], { limit }),

  clearExecutions: (): Promise<boolean> => invoke('clearAutomationExecutions', false),

  listGroups: (): Promise<AutomationGroupOption[]> => invoke('listAutomationGroups', [])
}
