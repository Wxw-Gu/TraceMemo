export const CHATGPT_PLAN_PROVIDER_PREFIX = 'chatgpt-plan:'
export const CHATGPT_PLAN_USAGE_URL = 'https://chatgpt.com/settings/usage'

export interface ChatGPTPlanConnection {
  id: string
  label: string
  email?: string
  status: 'disconnected' | 'connecting' | 'connected' | 'reauth_required'
  sharing: boolean
  pending?: boolean
}

export interface ChatGPTPlanStatus {
  profileId?: string
  profiles: ChatGPTPlanConnection[]
  sharing: boolean
  error?: string
}
