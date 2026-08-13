export type AIProviderType =
  | 'openai-compatible'
  | 'anthropic-messages'
  | 'azure-openai'
  | 'ollama'
  | 'custom'

export type AIAuthType = 'bearer' | 'x-api-key' | 'custom-header' | 'none'

export interface AIProviderAuth {
  type: AIAuthType
  headerName?: string
}

export interface AIModelCapabilities {
  chat: boolean
  vision: boolean
  /**
   * OCR 是 vision 能力的派生(几乎所有 vision 模型都能 OCR)。
   * 不作为用户独立配置项,UI 上显示为"图片文字识别"标签。
   */
  ocr: boolean
  longContext: boolean
}

export interface AIModelDefinition {
  name: string
  id: string
  capabilities: AIModelCapabilities
  maxTokens?: number
}

export interface AIProviderAdvancedSettings {
  timeoutMs: number
  temperature?: number
  maxTokens?: number
  extraHeaders: Record<string, string>
}

export interface AIProviderConfig {
  id: string
  name: string
  type: AIProviderType
  baseUrl: string
  apiKey?: string
  auth: AIProviderAuth
  models: AIModelDefinition[]
  defaultModel: string
  advanced: AIProviderAdvancedSettings
}

export interface AIProviderSummary extends Omit<AIProviderConfig, 'apiKey'> {
  hasApiKey: boolean
  isDefault: boolean
  status: 'untested' | 'connected' | 'error'
  lastTestedAt?: number
  lastError?: string
}

export interface AIProviderListResult {
  success: boolean
  providers: AIProviderSummary[]
  defaultProviderId?: string
  error?: string
}

export interface AIRuntimeModelConfig {
  providerId?: string
  providerName: string
  model: string
  modelName: string
  configured: boolean
  status: AIProviderSummary['status']
  timeoutMs?: number
}

/** 日报工作区内可选择的模型，不会修改全局默认 Provider。 */
export interface ReportModelChoice extends AIRuntimeModelConfig {
  providerId: string
  configured: true
}

export interface AIVisionRuntimeConfig extends AIRuntimeModelConfig {
  /** 图片理解模型独立于文字总结模型，由已验证的 vision/ocr capability 自动选择。 */
  source: 'default-model' | 'vision-capability' | 'unavailable'
}

export interface AiSearchProviderStatus {
  configured: boolean
  requiresConsent: boolean
  providerId?: string
  providerName?: string
  recipient?: string
}

export interface AiSearchExternalAuthorizationRequest {
  requestId: string
  providerId: string
  recipient: string
}

export interface AiSearchExternalAuthorizationResult {
  success: boolean
  error?: string
}

export interface LegacyAIConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface AIChatRequestOptions {
  providerId?: string
  modelId?: string
  timeoutMs?: number
  // Legacy compatibility only. New callers must use providerId/modelId.
  apiKey?: string
  baseURL?: string
  model?: string
}

export interface AIConnectionTestResult {
  success: boolean
  error?: string
  latencyMs?: number
}

export interface AIVisionTestRequest {
  providerId?: string
  modelId?: string
  prompt: string
  imageDataUrl: string
}

export interface AIVisionTestResult {
  success: boolean
  providerName?: string
  modelId?: string
  modelName?: string
  latencyMs?: number
  usage?: {
    input?: number
    output?: number
    total?: number
    estimated?: boolean
  }
  answer?: string
  code?: 'INVALID_IMAGE' | 'VISION_UNSUPPORTED' | 'API_ERROR'
  error?: string
}
