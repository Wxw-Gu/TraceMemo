import type {
  PersonalWechatSendCapability,
  PersonalWechatSendCapabilityState,
  PersonalWechatSenderStatus
} from '../../shared/personal-wechat'
import {
  personalWechatSendService,
  type PersonalWechatSendService
} from './personal-wechat-send-service'
import { macWechatRuntimeManager } from './mac-wechat-runtime-manager'

/**
 * Converts the detailed sender diagnostics into a small contract that other
 * features can consume without knowing about the macOS native runtime, the
 * Windows hook transport, or platform details.
 *
 * On macOS the capability is derived only from MacWechatRuntimeManager and its
 * validated runtime manifest. Windows continues to use the existing sender.
 */
export class PersonalWechatCapabilityService {
  constructor(
    private readonly sender: Pick<PersonalWechatSendService, 'getStatus'>,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly getMacStatus: () => Promise<PersonalWechatSenderStatus> = () =>
      macWechatRuntimeManager.buildSenderStatus()
  ) {}

  async getPersonalWechatSendCapability(): Promise<PersonalWechatSendCapability> {
    if (this.platform === 'darwin') {
      return this.fromMacRuntime()
    }
    const senderStatus = await this.sender.getStatus()
    return this.fromSenderStatus(senderStatus)
  }

  fromSenderStatus(senderStatus: PersonalWechatSenderStatus): PersonalWechatSendCapability {
    const capabilities = {
      text: Boolean(senderStatus.canSendText),
      image: Boolean(senderStatus.canSendImage),
      voice: Boolean(senderStatus.canSendVoice)
    }
    const status = this.mapState(senderStatus)
    const ready = status === 'ready'
    return {
      supported: status !== 'unsupported',
      ready,
      status,
      capabilities,
      senderStatus,
      message:
        status === 'unsupported'
          ? '微信消息发送目前仅支持 macOS 和 Windows'
          : senderStatus.message ||
            (status === 'needs_binding' || status === 'unconfigured'
              ? '请先绑定个人微信'
              : status === 'initializing'
                ? '正在初始化微信发送能力'
                : status === 'ready'
                  ? '个人微信已准备好发送日报'
                  : senderStatus.error || '个人微信发送能力异常'),
      ...(senderStatus.error ? { error: senderStatus.error } : {})
    }
  }

  /*
   * macOS capability from the native runtime. Builds a senderStatus snapshot
   * aligned with the mac binding state and reuses the shared mapping, so the
   * settings header and the binding card can never disagree.
   */
  private async fromMacRuntime(): Promise<PersonalWechatSendCapability> {
    const senderStatus = await this.getMacStatus()
    return this.fromSenderStatus(senderStatus)
  }

  private mapState(senderStatus: PersonalWechatSenderStatus): PersonalWechatSendCapabilityState {
    if (senderStatus.platform === 'win32') {
      if (senderStatus.canSend) return 'ready'
      if (!senderStatus.endpoint) return 'unconfigured'
      if (senderStatus.state === 'error' && senderStatus.endpointReady) return 'error'
      return 'initializing'
    }
    if (senderStatus.platform !== 'darwin' || senderStatus.state === 'unsupported_platform') {
      return 'unsupported'
    }
    if (senderStatus.state === 'error') return 'error'
    if (senderStatus.state === 'runtime_missing') return 'unconfigured'
    const hasCurrentBinding = Boolean(
      senderStatus.endpointReady &&
      senderStatus.attachReady &&
      senderStatus.wechatPid &&
      senderStatus.boundWechatPid === senderStatus.wechatPid
    )
    if (!hasCurrentBinding) {
      return senderStatus.runtimeReady ? 'needs_binding' : 'unconfigured'
    }
    if (senderStatus.canSend) return 'ready'
    if (
      senderStatus.state === 'hook_not_ready' ||
      senderStatus.state === 'online' ||
      senderStatus.state === 'starting' ||
      senderStatus.state === 'stopped'
    ) {
      return 'initializing'
    }
    return 'error'
  }
}

export const personalWechatCapabilityService = new PersonalWechatCapabilityService(
  personalWechatSendService
)

export const getPersonalWechatSendCapability = (): Promise<PersonalWechatSendCapability> =>
  personalWechatCapabilityService.getPersonalWechatSendCapability()
