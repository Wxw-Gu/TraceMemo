import { mapLicenseStatus, probeLicenseStatus } from '../services/msg-insert-capability-service'
import { macWechatRuntimeManager } from '../services/mac-wechat-runtime-manager'

export interface ExtensionEntitlementResult {
  ok: boolean
  message: string
  source: 'mac_license' | 'hook_license' | 'unsupported'
}

export interface ExtensionEntitlementDependencies {
  platform?: NodeJS.Platform
  getMacLicense?: () => Promise<{ authorized: boolean; message?: string }>
  probeLicense?: () => Promise<{ ok: boolean; status?: string }>
}

/**
 * 扩展发送的 授权校验。
 *
 * 只在主进程可信边界调用，且**不接受渲染层 / 扩展传入的任何布尔值**：
 * - macOS：读 Native Runtime 的 license 状态，要求 `authorized === true`；
 * - Windows：探测本机 Hook 的 `/license/status`，只接受 `LICENSE_OK`。
 *
 * 与「发送能力 ready」是两件事：能力 ready 只说明本机装好了 Runtime，
 * 不代表授权有效。
 */
export async function checkExtensionSendEntitlement(
  dependencies: ExtensionEntitlementDependencies = {}
): Promise<ExtensionEntitlementResult> {
  const platform = dependencies.platform ?? process.platform
  if (platform === 'darwin') {
    try {
      const status = dependencies.getMacLicense
        ? await dependencies.getMacLicense()
        : await macWechatRuntimeManager.getMacLicenseStatus()
      if (status.authorized) {
        return { ok: true, message: '授权有效', source: 'mac_license' }
      }
      return {
        ok: false,
        message: status.message || '需要有效授权才能由扩展发送消息',
        source: 'mac_license'
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '无法确认授权状态',
        source: 'mac_license'
      }
    }
  }
  if (platform === 'win32') {
    try {
      const probe = dependencies.probeLicense
        ? await dependencies.probeLicense()
        : await probeLicenseStatus()
      if (!probe.ok) {
        return { ok: false, message: '无法确认授权状态', source: 'hook_license' }
      }
      const mapped = mapLicenseStatus(probe.status)
      return {
        ok: mapped.entitlement === 'valid',
        message: mapped.message,
        source: 'hook_license'
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '无法确认授权状态',
        source: 'hook_license'
      }
    }
  }
  return { ok: false, message: '当前平台不支持微信发送', source: 'unsupported' }
}
