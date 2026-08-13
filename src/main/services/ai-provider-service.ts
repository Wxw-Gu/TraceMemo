import { app } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import type {
  AIChatRequestOptions,
  AIConnectionTestResult,
  AIProviderConfig,
  AIProviderListResult,
  AIProviderSummary,
  AiSearchProviderStatus,
  AIRuntimeModelConfig,
  AIVisionRuntimeConfig,
  AIVisionTestRequest,
  AIVisionTestResult,
  LegacyAIConfig
} from '../../shared/ai-provider'
import { AIProviderKeyStore } from '../ai-provider-key-store'

interface AIProviderMetadataFile {
  version: 1
  defaultProviderId?: string
  providers: Array<Omit<AIProviderSummary, 'hasApiKey' | 'isDefault'>>
}

type AIMessagePart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string }
type AIMessage = { role: string; content: string | AIMessagePart[] }
type AIRequestResult = {
  data: string
  usage?: { input?: number; output?: number; total?: number; estimated?: boolean }
}
interface OpenAIResponsePayload {
  error?: { message?: string }
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}
interface AnthropicResponsePayload {
  error?: { message?: string }
  content?: Array<{ type?: string; text?: string }>
  usage?: { input_tokens?: number; output_tokens?: number }
}

export class AIProviderService {
  constructor(private readonly keyStore = new AIProviderKeyStore()) {}

  list(): AIProviderListResult {
    try {
      const data = this.readMetadata()
      return {
        success: true,
        defaultProviderId: data.defaultProviderId,
        providers: data.providers.map((provider) =>
          this.toSummary(provider, data.defaultProviderId)
        )
      }
    } catch {
      return { success: false, providers: [], error: 'AI Provider 配置无法读取' }
    }
  }

  getRuntimeConfig(): AIRuntimeModelConfig {
    const result = this.list()
    const provider =
      result.providers.find((item) => item.id === result.defaultProviderId) || result.providers[0]
    const model = provider?.models.find((item) => item.id === provider.defaultModel)
    return {
      providerId: provider?.id,
      providerName: provider?.name || '尚未配置',
      model: provider?.defaultModel || '',
      modelName: model?.name || provider?.defaultModel || '尚未选择模型',
      configured: Boolean(
        provider && provider.models.length && (provider.hasApiKey || !needsApiKey(provider))
      ),
      status: provider?.status || 'untested',
      timeoutMs: provider?.advanced.timeoutMs
    }
  }

  getVisionRuntimeConfig(): AIVisionRuntimeConfig {
    const result = this.list()
    const defaultProvider = result.providers.find((item) => item.id === result.defaultProviderId)
    const defaultModel = defaultProvider?.models.find(
      (item) => item.id === defaultProvider.defaultModel
    )
    if (
      defaultProvider &&
      defaultModel &&
      (defaultProvider.hasApiKey || !needsApiKey(defaultProvider)) &&
      (defaultModel.capabilities.vision || defaultModel.capabilities.ocr)
    ) {
      return {
        providerId: defaultProvider.id,
        providerName: defaultProvider.name,
        model: defaultModel.id,
        modelName: defaultModel.name || defaultModel.id,
        configured: true,
        status: defaultProvider.status,
        timeoutMs: defaultProvider.advanced.timeoutMs,
        source: 'default-model'
      }
    }

    for (const provider of result.providers) {
      if (!provider.hasApiKey && needsApiKey(provider)) continue
      const model =
        provider.models.find(
          (item) =>
            item.id === provider.defaultModel && (item.capabilities.vision || item.capabilities.ocr)
        ) || provider.models.find((item) => item.capabilities.vision || item.capabilities.ocr)
      if (!model) continue
      return {
        providerId: provider.id,
        providerName: provider.name,
        model: model.id,
        modelName: model.name || model.id,
        configured: true,
        status: provider.status,
        timeoutMs: provider.advanced.timeoutMs,
        source: 'vision-capability'
      }
    }

    return {
      providerName: '尚未配置',
      model: '',
      modelName: '尚未验证图片理解模型',
      configured: false,
      status: 'untested',
      source: 'unavailable'
    }
  }

  getAiSearchProviderStatus(providerId?: string): AiSearchProviderStatus {
    const result = this.list()
    const provider =
      result.providers.find((item) => item.id === providerId) ||
      result.providers.find((item) => item.id === result.defaultProviderId) ||
      result.providers[0]
    if (!provider) return { configured: false, requiresConsent: false }
    const configured = Boolean(
      provider.models.length && (provider.hasApiKey || !needsApiKey(provider))
    )
    return {
      configured,
      requiresConsent: configured && !isLocalProvider(provider),
      providerId: provider.id,
      providerName: provider.name,
      recipient: normalizeProviderRecipient(provider.baseUrl)
    }
  }

  save(input: AIProviderConfig): AIProviderListResult {
    const validationError = validateProvider(input)
    if (validationError) return { success: false, providers: [], error: validationError }
    const data = this.readMetadata()
    const existing = data.providers.find((provider) => provider.id === input.id)
    if (input.apiKey?.trim()) {
      const saved = this.keyStore.save(input.id, input.apiKey.trim())
      if (!saved.success) return { success: false, providers: [], error: saved.error }
    } else if (needsApiKey(input) && !this.keyStore.get(input.id).key) {
      return { success: false, providers: [], error: '请填写 API Key' }
    }

    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
    const metadata: Omit<AIProviderSummary, 'hasApiKey' | 'isDefault'> = {
      id: input.id,
      name: input.name.trim(),
      type: input.type,
      baseUrl,
      auth: input.auth,
      models: input.models,
      defaultModel: input.defaultModel,
      advanced: input.advanced,
      status: existing?.status || 'untested',
      lastTestedAt: existing?.lastTestedAt,
      lastError: existing?.lastError
    }
    const index = data.providers.findIndex((provider) => provider.id === input.id)
    if (index >= 0) data.providers[index] = metadata
    else data.providers.push(metadata)
    if (!data.defaultProviderId) data.defaultProviderId = input.id
    this.writeMetadata(data)
    return this.list()
  }

  delete(providerId: string): AIProviderListResult {
    const data = this.readMetadata()
    data.providers = data.providers.filter((provider) => provider.id !== providerId)
    if (data.defaultProviderId === providerId) data.defaultProviderId = data.providers[0]?.id
    const cleared = this.keyStore.clear(providerId)
    if (!cleared.success) return { success: false, providers: [], error: cleared.error }
    this.writeMetadata(data)
    return this.list()
  }

  setDefault(providerId: string): AIProviderListResult {
    const data = this.readMetadata()
    if (!data.providers.some((provider) => provider.id === providerId)) {
      return { success: false, providers: [], error: '供应商不存在' }
    }
    data.defaultProviderId = providerId
    this.writeMetadata(data)
    return this.list()
  }

  migrateLegacy(config: LegacyAIConfig): AIProviderListResult {
    const data = this.readMetadata()
    if (data.providers.length) return this.list()
    const provider = deepSeekProvider(config.baseUrl, config.model)
    if (config.apiKey?.trim()) {
      const saved = this.keyStore.save(provider.id, config.apiKey.trim())
      if (!saved.success) return { success: false, providers: [], error: saved.error }
    }
    data.providers = [stripRuntimeFields(provider)]
    data.defaultProviderId = provider.id
    this.writeMetadata(data)
    return this.list()
  }

  async test(providerId: string): Promise<AIConnectionTestResult> {
    const startedAt = Date.now()
    try {
      await this.request([{ role: 'user', content: 'Reply with OK.' }], { providerId }, true)
      this.updateTestStatus(providerId, 'connected')
      return { success: true, latencyMs: Date.now() - startedAt }
    } catch (error) {
      const message = safeAIError(error)
      this.updateTestStatus(providerId, 'error', message)
      return { success: false, error: message, latencyMs: Date.now() - startedAt }
    }
  }

  async chat(
    messages: Array<{ role: string; content: string }>,
    options?: AIChatRequestOptions,
    signal?: AbortSignal
  ): Promise<{
    success: boolean
    data?: string
    usage?: { input?: number; output?: number; total?: number; estimated?: boolean }
    error?: string
  }> {
    try {
      return { success: true, ...(await this.request(messages, options, false, signal)) }
    } catch (error) {
      if (signal?.aborted) throw error
      return { success: false, error: safeAIError(error) }
    }
  }

  /**
   * 多模态图片理解。
   * 输入:text + image parts 的 messages,返回 AI 文本响应。
   * 与 testVision 区别:不校验 prompt,不写入 capability marker(供 ImageInsightService 复用)。
   */
  async analyzeImage(
    messages: Array<{
      role: string
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }>
    }>,
    options?: AIChatRequestOptions
  ): Promise<{
    success: boolean
    data?: string
    usage?: { input?: number; output?: number; total?: number; estimated?: boolean }
    error?: string
  }> {
    try {
      const imagePart = messages
        .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
        .find((part) => part.type === 'image')
      if (!imagePart || imagePart.type !== 'image') throw new Error('图片识别请求缺少图片数据')
      const imageError = validateVisionImage(imagePart.dataUrl)
      if (imageError) throw new Error(imageError)
      const result = await this.request(messages as AIMessage[], options)
      if (options?.providerId && options.modelId) {
        this.markCapabilities(options.providerId, options.modelId, { vision: true, ocr: true })
      }
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: safeAIError(error) }
    }
  }

  async testVision(request: AIVisionTestRequest): Promise<AIVisionTestResult> {
    const startedAt = Date.now()
    const imageError = validateVisionImage(request.imageDataUrl)
    if (imageError) return { success: false, code: 'INVALID_IMAGE', error: imageError }
    if (!request.prompt.trim()) {
      return { success: false, code: 'INVALID_IMAGE', error: '请填写图片识别提示词' }
    }
    try {
      const resolved = this.resolveProvider(request)
      const result = await requestProvider(resolved.provider, resolved.key, resolved.model, [
        {
          role: 'user',
          content: [
            { type: 'text', text: request.prompt.trim() },
            { type: 'image', dataUrl: request.imageDataUrl }
          ]
        }
      ])
      if (!result.data.trim()) throw new Error('API 未返回识别内容')
      this.markVisionCapability(resolved.provider.id, resolved.model)
      const model = resolved.provider.models.find((item) => item.id === resolved.model)
      return {
        success: true,
        providerName: resolved.provider.name,
        modelId: resolved.model,
        modelName: model?.name || resolved.model,
        latencyMs: Date.now() - startedAt,
        usage: result.usage,
        answer: result.data
      }
    } catch (error) {
      const failure = visionFailure(error)
      return { success: false, ...failure, latencyMs: Date.now() - startedAt }
    }
  }

  private async request(
    messages: AIMessage[],
    options?: AIChatRequestOptions,
    testing = false,
    signal?: AbortSignal
  ): Promise<{
    data: string
    usage?: { input?: number; output?: number; total?: number; estimated?: boolean }
  }> {
    if (options?.apiKey) return this.requestLegacy(messages, options, signal)
    const resolved = this.resolveProvider(options)
    const provider = options?.timeoutMs
      ? {
          ...resolved.provider,
          advanced: { ...resolved.provider.advanced, timeoutMs: options.timeoutMs }
        }
      : resolved.provider
    return requestProvider(provider, resolved.key, resolved.model, messages, testing, signal)
  }

  private resolveProvider(options?: { providerId?: string; modelId?: string }): {
    provider: AIProviderSummary
    model: string
    key: string
  } {
    const list = this.list()
    const provider =
      list.providers.find((item) => item.id === options?.providerId) ||
      list.providers.find((item) => item.id === list.defaultProviderId)
    if (!provider) throw new Error('尚未配置 AI Provider')
    const model = options?.modelId || provider.defaultModel
    if (!provider.models.some((item) => item.id === model)) throw new Error('当前模型不存在')
    const key = this.keyStore.get(provider.id).key || ''
    if (needsApiKey(provider) && !key) throw new Error('当前供应商尚未配置 API Key')
    return { provider, model, key }
  }

  private async requestLegacy(
    messages: AIMessage[],
    options: AIChatRequestOptions,
    signal?: AbortSignal
  ): Promise<AIRequestResult> {
    const provider = deepSeekProvider(options.baseURL, options.model)
    return requestOpenAICompatible(
      provider,
      options.apiKey || '',
      options.model || provider.defaultModel,
      messages,
      false,
      signal
    )
  }

  private updateTestStatus(
    providerId: string,
    status: 'connected' | 'error',
    lastError?: string
  ): void {
    const data = this.readMetadata()
    const provider = data.providers.find((item) => item.id === providerId)
    if (!provider) return
    provider.status = status
    provider.lastTestedAt = Date.now()
    provider.lastError = lastError
    this.writeMetadata(data)
  }

  private markVisionCapability(providerId: string, modelId: string): void {
    this.markCapabilities(providerId, modelId, { vision: true, ocr: true })
  }

  /**
   * 标记模型已验证的 capabilities(已存在则跳过)。
   * OCR 跟随 vision:几乎所有 vision 模型都能 OCR,标记 vision 时同步标记 ocr。
   */
  private markCapabilities(
    providerId: string,
    modelId: string,
    caps: { vision?: boolean; ocr?: boolean }
  ): void {
    const data = this.readMetadata()
    const provider = data.providers.find((item) => item.id === providerId)
    const model = provider?.models.find((item) => item.id === modelId)
    if (!provider || !model) return
    // 老配置可能没有 ocr 字段,补默认 false
    if (typeof model.capabilities.ocr !== 'boolean') model.capabilities.ocr = false
    let changed = false
    if (caps.vision === true && !model.capabilities.vision) {
      model.capabilities.vision = true
      // vision 开启默认带 ocr(派生能力)
      if (!model.capabilities.ocr) {
        model.capabilities.ocr = true
      }
      changed = true
    }
    if (caps.ocr === true && !model.capabilities.ocr) {
      model.capabilities.ocr = true
      changed = true
    }
    if (changed) this.writeMetadata(data)
  }

  private toSummary(
    provider: Omit<AIProviderSummary, 'hasApiKey' | 'isDefault'>,
    defaultProviderId?: string
  ): AIProviderSummary {
    return {
      ...provider,
      hasApiKey: Boolean(this.keyStore.get(provider.id).key),
      isDefault: provider.id === defaultProviderId
    }
  }

  private readMetadata(): AIProviderMetadataFile {
    const filePath = this.metadataPath
    if (!fs.existsSync(filePath)) return { version: 1, providers: [] }
    const data = fs.readJsonSync(filePath) as AIProviderMetadataFile
    if (data.version !== 1 || !Array.isArray(data.providers))
      throw new Error('invalid provider metadata')
    let removedLegacySearchConsent = false
    // 老配置兼容:补 capabilities.ocr 默认值(vision 派生 OCR)
    for (const provider of data.providers) {
      const stored = provider as Record<string, unknown>
      if ('aiSearchDataConsent' in stored) {
        delete stored.aiSearchDataConsent
        removedLegacySearchConsent = true
      }
      for (const model of provider.models) {
        if (typeof model.capabilities.ocr !== 'boolean') {
          model.capabilities.ocr = model.capabilities.vision === true
        }
      }
    }
    if (removedLegacySearchConsent) this.writeMetadata(data)
    return data
  }

  private writeMetadata(data: AIProviderMetadataFile): void {
    fs.ensureDirSync(path.dirname(this.metadataPath))
    fs.writeJsonSync(this.metadataPath, data, { spaces: 2 })
  }

  private get metadataPath(): string {
    return path.join(app.getPath('userData'), 'ai-providers.json')
  }
}

function deepSeekProvider(baseUrl?: string, model?: string): AIProviderSummary {
  const modelId = model?.trim() || 'deepseek-chat'
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai-compatible',
    baseUrl: baseUrl?.trim() || 'https://api.deepseek.com',
    auth: { type: 'bearer' },
    models: [
      {
        name: modelId === 'deepseek-chat' ? 'DeepSeek Chat' : modelId,
        id: modelId,
        capabilities: { chat: true, vision: false, ocr: false, longContext: true }
      }
    ],
    defaultModel: modelId,
    advanced: { timeoutMs: 120_000, temperature: 0.7, maxTokens: 4096, extraHeaders: {} },
    hasApiKey: false,
    isDefault: true,
    status: 'untested'
  }
}

function stripRuntimeFields(
  provider: AIProviderSummary
): Omit<AIProviderSummary, 'hasApiKey' | 'isDefault'> {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    auth: provider.auth,
    models: provider.models,
    defaultModel: provider.defaultModel,
    advanced: provider.advanced,
    status: provider.status,
    lastTestedAt: provider.lastTestedAt,
    lastError: provider.lastError
  }
}

function isLocalProvider(provider: Pick<AIProviderSummary, 'type' | 'baseUrl'>): boolean {
  try {
    const hostname = new URL(provider.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return false
  }
}

function normalizeProviderRecipient(baseUrl: string): string {
  try {
    const url = new URL(baseUrl.trim())
    const pathname = url.pathname.replace(/\/+$/, '')
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`
  } catch {
    return baseUrl.trim().replace(/\/+$/, '')
  }
}

function needsApiKey(provider: Pick<AIProviderConfig, 'type' | 'auth'>): boolean {
  return provider.type !== 'ollama' && provider.auth.type !== 'none'
}

function validateProvider(provider: AIProviderConfig): string | undefined {
  if (!provider.id.trim() || !/^[a-z0-9][a-z0-9-_]*$/i.test(provider.id))
    return '供应商 ID 格式不正确'
  if (!provider.name.trim()) return '供应商名称不能为空'
  if (!provider.baseUrl.trim()) return 'Base URL 不能为空'
  if (!provider.models.length) return '请至少添加一个模型'
  if (provider.models.some((model) => !model.name.trim() || !model.id.trim()))
    return '模型名称和 ID 不能为空'
  if (!provider.models.some((model) => model.id === provider.defaultModel))
    return '默认模型不在模型列表中'
  if (provider.auth.type === 'custom-header' && !provider.auth.headerName?.trim())
    return '请填写自定义认证字段'
  return undefined
}

function buildHeaders(provider: AIProviderSummary, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...provider.advanced.extraHeaders
  }
  if (!apiKey || provider.auth.type === 'none') return headers
  if (provider.auth.type === 'bearer') headers.authorization = `Bearer ${apiKey}`
  else if (provider.auth.type === 'x-api-key') headers['x-api-key'] = apiKey
  else headers[provider.auth.headerName || 'authorization'] = apiKey
  return headers
}

function requestProvider(
  provider: AIProviderSummary,
  apiKey: string,
  model: string,
  messages: AIMessage[],
  testing = false,
  signal?: AbortSignal
): Promise<AIRequestResult> {
  return provider.type === 'anthropic-messages'
    ? requestAnthropic(provider, apiKey, model, messages, testing, signal)
    : requestOpenAICompatible(provider, apiKey, model, messages, testing, signal)
}

function toOpenAIMessages(messages: AIMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : { type: 'image_url', image_url: { url: part.dataUrl } }
          )
  }))
}

function toAnthropicMessages(messages: AIMessage[]): Array<{ role: string; content: unknown }> {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => {
              if (part.type === 'text') return { type: 'text', text: part.text }
              const image = parseVisionImage(part.dataUrl)
              return {
                type: 'image',
                source: { type: 'base64', media_type: image.mimeType, data: image.base64 }
              }
            })
    }))
}

async function requestOpenAICompatible(
  provider: AIProviderSummary,
  apiKey: string,
  model: string,
  messages: AIMessage[],
  testing = false,
  signal?: AbortSignal
): Promise<AIRequestResult> {
  const endpoint = provider.baseUrl.endsWith('/chat/completions')
    ? provider.baseUrl
    : `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: buildHeaders(provider, apiKey),
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(messages),
        temperature: provider.advanced.temperature,
        max_tokens: testing ? 8 : provider.advanced.maxTokens
      })
    },
    provider.advanced.timeoutMs,
    signal
  )
  const payload = await parseJsonResponse<OpenAIResponsePayload>(response)
  if (!response.ok) throw new Error(payload.error?.message || `AI 请求失败 (${response.status})`)
  return {
    data: String(payload.choices?.[0]?.message?.content || ''),
    usage: payload.usage
      ? {
          input: payload.usage.prompt_tokens,
          output: payload.usage.completion_tokens,
          total: payload.usage.total_tokens,
          estimated: false
        }
      : undefined
  }
}

async function requestAnthropic(
  provider: AIProviderSummary,
  apiKey: string,
  model: string,
  messages: AIMessage[],
  testing = false,
  signal?: AbortSignal
): Promise<AIRequestResult> {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('\n')
    )
    .join('\n\n')
  const anthropicMessages = toAnthropicMessages(messages)
  const headers = buildHeaders(provider, apiKey)
  if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
  const endpoint = provider.baseUrl.endsWith('/messages')
    ? provider.baseUrl
    : `${provider.baseUrl.replace(/\/+$/, '')}/messages`
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        system: system || undefined,
        messages: anthropicMessages,
        temperature: provider.advanced.temperature,
        max_tokens: testing ? 8 : provider.advanced.maxTokens || 4096
      })
    },
    provider.advanced.timeoutMs,
    signal
  )
  const payload = await parseJsonResponse<AnthropicResponsePayload>(response)
  if (!response.ok)
    throw new Error(payload.error?.message || `Anthropic 请求失败 (${response.status})`)
  return {
    data: Array.isArray(payload.content)
      ? payload.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text || '')
          .join('\n')
      : '',
    usage: payload.usage
      ? {
          input: payload.usage.input_tokens,
          output: payload.usage.output_tokens,
          total: Number(payload.usage.input_tokens || 0) + Number(payload.usage.output_tokens || 0),
          estimated: false
        }
      : undefined
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = (): void =>
    controller.abort(signal?.reason || new DOMException('AI request cancelled', 'AbortError'))
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(
    () => {
      timedOut = true
      controller.abort(new DOMException('AI request timed out', 'TimeoutError'))
    },
    Math.max(1_000, timeoutMs || 120_000)
  )
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (signal?.aborted) throw new DOMException('AI request cancelled', 'AbortError')
    if (timedOut) throw new DOMException('AI request timed out', 'TimeoutError')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text()
  try {
    return JSON.parse(body) as T
  } catch {
    const looksLikeHtml = /^\s*(?:<!doctype\s+html|<html\b)/i.test(body)
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    if (looksLikeHtml) {
      throw new Error(`模型服务返回了网页而不是 JSON（HTTP ${status}），请稍后重试或检查中转服务`)
    }
    throw new Error(`模型服务返回格式异常（HTTP ${status}）`)
  }
}

function safeAIError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'AI 请求超时'
  if (error instanceof DOMException && error.name === 'AbortError') return 'AI 请求已取消'
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/sk-[a-z0-9_-]+/gi, '***').slice(0, 300)
}

function parseVisionImage(dataUrl: string): { mimeType: string; base64: string; bytes: number } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i.exec(dataUrl)
  if (!match) throw new Error('图片格式不受支持，请选择 PNG、JPG、JPEG 或 WebP')
  const bytes = Buffer.byteLength(match[2], 'base64')
  return { mimeType: match[1].toLowerCase(), base64: match[2], bytes }
}

function validateVisionImage(dataUrl: string): string | undefined {
  try {
    const image = parseVisionImage(dataUrl)
    if (!image.bytes) return '图片内容为空'
    if (image.bytes > 10 * 1024 * 1024) return '图片不能超过 10 MB'
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : '图片无法读取'
  }
}

function visionFailure(error: unknown): {
  code: 'VISION_UNSUPPORTED' | 'API_ERROR'
  error: string
} {
  const message = safeAIError(error)
  const unsupported =
    /vision|multimodal|image[_ ]url|image input|image.*support|support.*image|图片.*不支持|不支持.*图片/i.test(
      message
    )
  return unsupported
    ? { code: 'VISION_UNSUPPORTED', error: '当前模型不支持图片理解' }
    : { code: 'API_ERROR', error: message || 'API 返回错误' }
}
