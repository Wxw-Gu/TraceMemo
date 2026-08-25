import type { AIProviderConfig, AIProviderType } from '../../../../../shared/ai-provider'

export const PROVIDER_TYPE_LABELS: Record<AIProviderType, string> = {
  'openai-compatible': 'OpenAI Compatible',
  'anthropic-messages': 'Anthropic Messages',
  'azure-openai': 'Azure OpenAI',
  ollama: 'Ollama',
  custom: '自定义'
}

export const PROVIDER_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    type: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-latest'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat'
  },
  {
    id: 'qwen',
    label: '通义千问',
    type: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus'
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    type: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k'
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    type: 'openai-compatible',
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'MiniMax-Text-01'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    type: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5'
  },
  {
    id: 'custom',
    label: '自建 OpenAI Compatible API',
    type: 'openai-compatible',
    baseUrl: '',
    model: ''
  }
] as const

export function createProviderFromPreset(presetId = 'deepseek'): AIProviderConfig {
  const preset = PROVIDER_PRESETS.find((item) => item.id === presetId) || PROVIDER_PRESETS[2]
  const id = `${preset.id}-${Date.now().toString(36)}`
  return {
    id,
    name: preset.label,
    type: preset.type,
    baseUrl: preset.baseUrl,
    apiKey: '',
    auth: {
      type:
        preset.type === 'ollama'
          ? 'none'
          : preset.type === 'anthropic-messages'
            ? 'x-api-key'
            : 'bearer'
    },
    models: [
      {
        name: preset.model || '默认模型',
        id: preset.model,
        capabilities: { chat: true, vision: false, ocr: false, longContext: false }
      }
    ],
    defaultModel: preset.model,
    advanced: {
      timeoutMs: 120000,
      temperature: 0.7,
      maxTokens: 4096,
      stream: false,
      apiProtocol: 'chat-completions',
      extraHeaders: {}
    }
  }
}
