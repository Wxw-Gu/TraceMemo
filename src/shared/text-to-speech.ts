export type TextToSpeechKeySource = 'secure-storage' | 'environment' | 'missing'
export type TextToSpeechModel = 's2.1-pro-free' | 's2.1-pro'

export interface TextToSpeechVoice {
  id: string
  name: string
  description: string
  tags: string[]
  languages: string[]
  source: 'fish-audio'
  coverImage?: string
  previewUrl?: string
  previewText?: string
  authorName?: string
  taskCount?: number
  likeCount?: number
  markCount?: number
}

export interface TextToSpeechSettings {
  provider: 'fish-audio'
  hasApiKey: boolean
  hasStoredApiKey: boolean
  hasEnvironmentApiKey: boolean
  keySource: TextToSpeechKeySource
  encryptionAvailable: boolean
  selectedVoiceId: string
  outputFormat: 'mp3'
  model: TextToSpeechModel
  phase: 'ready'
}

export interface TextToSpeechSettingsResult {
  success: boolean
  settings: TextToSpeechSettings
  voices: TextToSpeechVoice[]
  error?: string
}

export interface SaveTextToSpeechSettingsRequest {
  apiKey?: string
  clearApiKey?: boolean
  selectedVoiceId?: string
  model?: TextToSpeechModel
}

export interface ListTextToSpeechVoicesRequest {
  pageNumber?: number
  pageSize?: number
  title?: string
  language?: string
  tags?: string[]
}

export interface ListTextToSpeechVoicesResult {
  success: boolean
  items: TextToSpeechVoice[]
  total: number
  pageNumber: number
  pageSize: number
  hasMore: boolean
  error?: string
}

export interface SynthesizeTextToSpeechRequest {
  text: string
  referenceId: string
}

export interface SynthesizeTextToSpeechResult {
  success: boolean
  filePath?: string
  audioDataUrl?: string
  error?: string
}
