import type {
  AutomationExecution,
  AutomationRule,
  AutomationRuleDraft,
  AutomationStatusSummary,
  ScheduledRuleRunOutcome
} from '../../../../../shared/automation'
import type {
  ScheduledReportExecution,
  ScheduledReportNotification,
  ScheduledReportNotificationCapability,
  ScheduledReportNotificationSettings,
  ScheduledReportNotificationSettingsResult,
  ScheduledReportResult
} from '../../../../../shared/scheduled-report'
import type { GroupExitMonitorState } from '../../../../../shared/group-exit-monitor'

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

  listGroups: (): Promise<AutomationGroupOption[]> => invoke('listAutomationGroups', []),

  /** 保存「退群通知」规则（singleton upsert，id 由 main 侧固定）。 */
  saveLeaveNotificationRule: (draft: AutomationRuleDraft): Promise<AutomationRule | null> =>
    invoke<AutomationRule | null>('saveLeaveNotificationRule', null, draft),

  /**
   * 「指定好友」的可选项。
   *
   * 过滤（群聊 / 公众号 / 文件传输助手 / 自己）在 main 侧完成 ——
   * 那里才知道当前登录账号是谁。渲染层不再筛一遍，避免两套规则漂移。
   */
  listSendableContacts: (): Promise<AutomationGroupOption[]> =>
    invoke('listSendableContacts', []),

  /**
   * 真实已监控群聊数量。
   *
   * 数据源是**退群监控**，自动化不维护副本（不做二次群过滤）。
   * 取数与退群监控页保持同一表达式，否则两个页面会对同一个数字给出不同答案。
   */
  async getMonitoredGroupCount(): Promise<number> {
    const state = await invoke<GroupExitMonitorState | null>('getGroupExitMonitorState', null)
    if (!state) return 0
    if (state.monitorSelectionConfigured) return (state.monitoredRoomIds || []).length
    return Number(state.monitoredGroupCount) || 0
  },

  /**
   * 真实已监控群聊清单（含显示名），供退群通知做**二次勾选**。
   *
   * 与 `getMonitoredGroupCount` **同一处取数**：清单和数字必须来自同一个快照，
   * 否则会出现"卡片说 5 个群、勾选列表只有 3 个"这种自相矛盾的界面。
   *
   * 名字从群列表里取（`listAutomationGroups`）。取不到的 roomId **保留原样**而不是丢掉 ——
   * 那个群仍然被监控着，丢掉它等于悄悄缩小用户的范围。
   *
   * 未显式设置监控范围时返回空数组：此时没有"被监控的群"这个集合，
   * 二次筛选无从谈起，由调用方退化成"全部"并如实说明。
   */
  async getMonitoredGroups(): Promise<AutomationGroupOption[]> {
    const [state, groups] = await Promise.all([
      invoke<GroupExitMonitorState | null>('getGroupExitMonitorState', null),
      invoke<AutomationGroupOption[]>('listAutomationGroups', [])
    ])
    if (!state?.monitorSelectionConfigured) return []
    const nameById = new Map(groups.map((group) => [group.id, group.name]))
    return (state.monitoredRoomIds || [])
      .map((roomId) => ({ id: roomId, name: nameById.get(roomId) || roomId }))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  },

  /** 定时日报「立即执行」：与 scheduler 走同一条执行链路（manual trigger）。 */
  runScheduledReportRule: (
    ruleId: string
  ): Promise<{ success: boolean; error?: string; data?: ScheduledRuleRunOutcome }> =>
    invoke<{ success: boolean; error?: string; data?: ScheduledRuleRunOutcome }>(
      'runScheduledReportRule',
      { success: false, error: '定时日报执行接口尚未就绪' },
      ruleId
    ),

  /**
   * 旧执行记录**只读存档**。
   *
   * 旧记录是 7 态 + stage 模型，新执行日志是 3 态 + 通用步骤 —— 两者无法无损互转，
   * 所以历史记录原样保留、只读展示，不迁进新日志。
   */
  listScheduledReportLegacyExecutions: (ruleId?: string): Promise<ScheduledReportExecution[]> =>
    invoke('listScheduledReportLegacyExecutions', [], ruleId),

  /** 微信异常通知（随定时日报功能保留的全局能力）。 */
  getScheduledReportNotificationSettings: (): Promise<ScheduledReportNotificationSettings> =>
    invoke('getScheduledReportNotificationSettings', { enabled: false }),

  getScheduledReportNotificationCapability: (): Promise<ScheduledReportNotificationCapability> =>
    invoke('getScheduledReportNotificationCapability', { ready: false }),

  setScheduledReportNotificationEnabled: (
    enabled: boolean
  ): Promise<ScheduledReportNotificationSettingsResult> =>
    invoke<ScheduledReportNotificationSettingsResult>(
      'setScheduledReportNotificationEnabled',
      { success: false, data: { enabled: false }, error: '异常通知设置接口尚未就绪' },
      enabled
    ),

  testScheduledReportErrorNotification: (
    ruleId: string
  ): Promise<ScheduledReportResult<ScheduledReportNotification>> =>
    invoke<ScheduledReportResult<ScheduledReportNotification>>(
      'testScheduledReportErrorNotification',
      { success: false, error: '调试接口尚未就绪' },
      ruleId
    )
}
