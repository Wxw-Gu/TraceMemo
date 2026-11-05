import type { MessageInsertCapability } from './msg-insert-capability-service'

/** 退群内提示开关的判定：授权或组件不成立时必须显示关闭；库没连只压 effective。 */

export interface ExitNoticeGateDecision {
  /** 界面开关值 */
  desiredEnabled: boolean
  /** 是否真的在生效 */
  effectiveEnabled: boolean
  /** 只在明确否定时落盘；探测失败不落盘，避免误关正常用户的开关。 */
  persistDisable: boolean
}

/** 授权维度是否成立（不含微信库连接）。 */
export function isEntitlementBlocked(capability: MessageInsertCapability): boolean {
  return capability.entitlementState !== 'valid' || capability.nativeComponentState !== 'ready'
}

  /** 明确否定（不含 unavailable：那是「不知道」，不是「不行」）。 */
export function isDefinitelyBlocked(capability: MessageInsertCapability): boolean {
  return (
    capability.entitlementState === 'invalid' ||
    capability.entitlementState === 'unsupported' ||
    capability.nativeComponentState === 'missing' ||
    capability.nativeComponentState === 'invalid' ||
    capability.nativeComponentState === 'incompatible'
  )
}

export function resolveExitNoticeGate(
  capability: MessageInsertCapability,
  runtimeEnabled: boolean
): ExitNoticeGateDecision {
  if (isEntitlementBlocked(capability)) {
    return {
      desiredEnabled: false,
      effectiveEnabled: false,
      persistDisable: isDefinitelyBlocked(capability) && runtimeEnabled
    }
  }
  /*
   * 授权与组件都就绪，只是微信库没连：用户意愿保留（连上自动恢复），
   * 但此刻没有真的在跑。
   */
  if (runtimeEnabled && !capability.canEnable) {
    return { desiredEnabled: true, effectiveEnabled: false, persistDisable: false }
  }
  return {
    desiredEnabled: runtimeEnabled,
    effectiveEnabled: runtimeEnabled && capability.canEnable,
    persistDisable: false
  }
}

/** 界面呈现结果（只有开关的两个布尔值，不含落盘决策）。 */
export interface SwitchPresentation {
  desiredEnabled: boolean
  effectiveEnabled: boolean
}

/** 两个开关共用这套呈现判定：授权不成立时都显示关闭，但关闭操作永远放行。 */
export function resolveSwitchPresentation(
  kind: 'recall_notice' | 'group_exit_notice',
  currentDesired: boolean,
  capability: MessageInsertCapability
): SwitchPresentation {
  if (kind === 'group_exit_notice') {
    const gate = resolveExitNoticeGate(capability, currentDesired)
    return { desiredEnabled: gate.desiredEnabled, effectiveEnabled: gate.effectiveEnabled }
  }
  if (isEntitlementBlocked(capability)) {
    return { desiredEnabled: false, effectiveEnabled: false }
  }
  return {
    desiredEnabled: currentDesired,
    effectiveEnabled: currentDesired && capability.canEnable
  }
}
