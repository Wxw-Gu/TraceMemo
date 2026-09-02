import { app, net } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import { randomUUID } from 'crypto'
import type {
  ListTextToSpeechVoicesRequest,
  ListTextToSpeechVoicesResult,
  SaveTextToSpeechSettingsRequest,
  SynthesizeTextToSpeechRequest,
  SynthesizeTextToSpeechResult,
  TextToSpeechKeySource,
  TextToSpeechModel,
  TextToSpeechSettingsResult,
  TextToSpeechVoice
} from '../../shared/text-to-speech'
import { AIProviderKeyStore } from '../ai-provider-key-store'
import { loadSettings, updateSettings } from './settings-store'

const FISH_AUDIO_KEY_ID = 'fish-audio-tts'
const FISH_AUDIO_BASE_URL = 'https://api.fish.audio'
const FISH_AUDIO_PUBLIC_ASSET_URL = 'https://public-platform.r2.fish.audio/'
const DEFAULT_PAGE_SIZE = 24
const MAX_PAGE_SIZE = 100
const GENERATED_AUDIO_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface FishAudioModelEntity {
  _id: string
  type: 'svc' | 'tts'
  title: string
  description?: string
  cover_image?: string
  state: 'created' | 'training' | 'trained' | 'failed'
  tags?: string[]
  languages?: string[]
  default_text?: string
  samples?: Array<{ title: string; text: string; task_id: string; audio: string }>
  task_count?: number
  like_count?: number
  mark_count?: number
  author?: { _id: string; nickname: string; avatar: string }
}

interface FishAudioModelListResponse {
  total: number
  items: FishAudioModelEntity[]
  has_more?: boolean | null
}

export class TextToSpeechSettingsService {
  constructor(private readonly keyStore = new AIProviderKeyStore()) {}

  get(): TextToSpeechSettingsResult {
    const resolved = this.resolveKey()
    const settings = loadSettings()
    return {
      success: resolved.success,
      settings: {
        provider: 'fish-audio',
        hasApiKey: Boolean(resolved.key),
        hasStoredApiKey: resolved.hasStoredApiKey,
        hasEnvironmentApiKey: resolved.hasEnvironmentApiKey,
        keySource: resolved.source,
        encryptionAvailable: resolved.encryptionAvailable,
        selectedVoiceId: normalizeSelectedVoiceId(settings.ttsSelectedVoiceId),
        outputFormat: 'mp3',
        model: normalizeModel(settings.ttsModel),
        phase: 'ready'
      },
      voices: [],
      error: resolved.error
    }
  }

  save(request: SaveTextToSpeechSettingsRequest): TextToSpeechSettingsResult {
    const apiKey = request.apiKey?.trim()
    if (request.clearApiKey) {
      const cleared = this.keyStore.clear(FISH_AUDIO_KEY_ID)
      if (!cleared.success) return { ...this.get(), success: false, error: cleared.error }
    } else if (apiKey) {
      const saved = this.keyStore.save(FISH_AUDIO_KEY_ID, apiKey)
      if (!saved.success) return { ...this.get(), success: false, error: saved.error }
    }

    const patch: { ttsSelectedVoiceId?: string; ttsModel?: TextToSpeechModel } = {}
    if (request.selectedVoiceId !== undefined) {
      patch.ttsSelectedVoiceId = request.selectedVoiceId.trim()
    }
    if (request.model !== undefined) patch.ttsModel = normalizeModel(request.model)
    if (Object.keys(patch).length) updateSettings(patch)
    return this.get()
  }

  async listVoices(
    request: ListTextToSpeechVoicesRequest = {}
  ): Promise<ListTextToSpeechVoicesResult> {
    const pageNumber = clampInteger(request.pageNumber, 1, Number.MAX_SAFE_INTEGER, 1)
    const pageSize = clampInteger(request.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)
    const resolved = this.resolveKey()
    if (!resolved.key) {
      return {
        success: false,
        items: [],
        total: 0,
        pageNumber,
        pageSize,
        hasMore: false,
        error: resolved.error || '请先配置语音服务 API Key'
      }
    }

    try {
      const url = new URL('/model', FISH_AUDIO_BASE_URL)
      url.searchParams.set('page_size', String(pageSize))
      url.searchParams.set('page_number', String(pageNumber))
      url.searchParams.set('sort_by', 'score')
      if (request.title?.trim()) url.searchParams.set('title', request.title.trim())
      if (request.language?.trim()) url.searchParams.set('language', request.language.trim())
      for (const tag of request.tags || []) {
        if (tag.trim()) url.searchParams.append('tag', tag.trim())
      }

      const response = await fishAudioFetch(url.toString(), {
        headers: { Authorization: `Bearer ${resolved.key}` },
        signal: AbortSignal.timeout(30_000)
      })
      if (!response.ok) throw await fishAudioError(response)
      const payload = (await response.json()) as FishAudioModelListResponse
      let items = payload.items
        .filter((model) => model.type === 'tts' && model.state === 'trained')
        .map(toVoice)

      const selectedVoiceId = normalizeSelectedVoiceId(loadSettings().ttsSelectedVoiceId)
      if (
        pageNumber === 1 &&
        !request.title?.trim() &&
        !(request.tags || []).length &&
        selectedVoiceId
      ) {
        if (!items.some((item) => item.id === selectedVoiceId)) {
          const selected = await this.getVoice(selectedVoiceId, resolved.key)
          if (selected) items = [selected, ...items]
        }
      }

      return {
        success: true,
        items,
        total: payload.total,
        pageNumber,
        pageSize,
        hasMore: payload.has_more ?? pageNumber * pageSize < payload.total
      }
    } catch (error) {
      return {
        success: false,
        items: [],
        total: 0,
        pageNumber,
        pageSize,
        hasMore: false,
        error: safeFishAudioError(error)
      }
    }
  }

  async synthesize(request: SynthesizeTextToSpeechRequest): Promise<SynthesizeTextToSpeechResult> {
    const text = request.text.trim()
    const referenceId = request.referenceId.trim()
    if (!text) return { success: false, error: '请输入要生成语音的文字' }
    if (text.length > 1000) return { success: false, error: '单次生成文字不能超过 1000 个字符' }
    if (!referenceId) return { success: false, error: '请先选择音色' }

    const resolved = this.resolveKey()
    if (!resolved.key) {
      return {
        success: false,
        error: resolved.error || '请先配置语音服务 API Key'
      }
    }

    try {
      const response = await fishAudioFetch(`${FISH_AUDIO_BASE_URL}/v1/tts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resolved.key}`,
          'Content-Type': 'application/json',
          model: normalizeModel(loadSettings().ttsModel)
        },
        body: JSON.stringify({
          text,
          reference_id: referenceId,
          format: 'mp3',
          mp3_bitrate: 128,
          latency: 'normal',
          normalize: true
        }),
        signal: AbortSignal.timeout(120_000)
      })
      if (!response.ok) throw await fishAudioError(response)
      const audio = Buffer.from(await response.arrayBuffer())
      if (audio.length < 128) throw new Error('语音服务返回的音频为空')

      const directory = this.generatedAudioDirectory()
      fs.ensureDirSync(directory)
      this.cleanupGeneratedAudio(directory)
      const filePath = path.join(directory, `fish-audio-${Date.now()}-${randomUUID()}.mp3`)
      fs.writeFileSync(filePath, audio, { mode: 0o600 })
      return {
        success: true,
        filePath,
        audioDataUrl: `data:audio/mpeg;base64,${audio.toString('base64')}`
      }
    } catch (error) {
      return { success: false, error: safeFishAudioError(error) }
    }
  }

  removeGeneratedAudio(filePath: string): { success: boolean; error?: string } {
    const directory = this.generatedAudioDirectory()
    const resolvedPath = path.resolve(filePath)
    if (!resolvedPath.startsWith(`${path.resolve(directory)}${path.sep}`)) {
      return { success: false, error: '拒绝删除非 Fish Audio 临时文件' }
    }
    try {
      fs.removeSync(resolvedPath)
      return { success: true }
    } catch {
      return { success: false, error: '临时语音文件清理失败' }
    }
  }

  private resolveKey(): {
    success: boolean
    key?: string
    source: TextToSpeechKeySource
    hasStoredApiKey: boolean
    hasEnvironmentApiKey: boolean
    encryptionAvailable: boolean
    error?: string
  } {
    const stored = this.keyStore.get(FISH_AUDIO_KEY_ID)
    const environmentKey = String(process.env.FISH_API_KEY || '').trim()
    const storedKey = stored.key?.trim()
    const key = storedKey || environmentKey || undefined
    return {
      success: stored.success || Boolean(environmentKey),
      key,
      source: storedKey ? 'secure-storage' : environmentKey ? 'environment' : 'missing',
      hasStoredApiKey: Boolean(storedKey),
      hasEnvironmentApiKey: Boolean(environmentKey),
      encryptionAvailable: stored.available,
      error: key ? undefined : stored.error
    }
  }

  private async getVoice(id: string, key: string): Promise<TextToSpeechVoice | null> {
    try {
      const response = await fishAudioFetch(
        `${FISH_AUDIO_BASE_URL}/model/${encodeURIComponent(id)}`,
        {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15_000)
        }
      )
      if (!response.ok) return null
      const model = (await response.json()) as FishAudioModelEntity
      return model.type === 'tts' && model.state === 'trained' ? toVoice(model) : null
    } catch {
      return null
    }
  }

  private generatedAudioDirectory(): string {
    return path.join(app.getPath('temp'), 'wechatexplorer-fish-audio')
  }

  private cleanupGeneratedAudio(directory: string): void {
    try {
      const now = Date.now()
      for (const name of fs.readdirSync(directory)) {
        const candidate = path.join(directory, name)
        if (!name.startsWith('fish-audio-') || !name.endsWith('.mp3')) continue
        if (now - fs.statSync(candidate).mtimeMs > GENERATED_AUDIO_MAX_AGE_MS)
          fs.removeSync(candidate)
      }
    } catch {
      // 临时文件清理失败不应阻断当前语音生成。
    }
  }
}

function toVoice(model: FishAudioModelEntity): TextToSpeechVoice {
  const sample = model.samples?.find((item) => item.audio) || model.samples?.[0]
  return {
    id: model._id,
    name: model.title || '未命名音色',
    description: model.description || sample?.text || '公开音色',
    tags: Array.isArray(model.tags) ? model.tags : [],
    languages: Array.isArray(model.languages) ? model.languages : [],
    source: 'fish-audio',
    coverImage: resolvePublicAssetUrl(model.cover_image || model.author?.avatar),
    previewUrl: sample?.audio || undefined,
    previewText: sample?.text || model.default_text || undefined,
    authorName: model.author?.nickname || undefined,
    taskCount: model.task_count,
    likeCount: model.like_count,
    markCount: model.mark_count
  }
}

function resolvePublicAssetUrl(value?: string): string | undefined {
  const normalized = String(value || '').trim()
  if (!normalized) return undefined
  if (/^https?:\/\//i.test(normalized)) return normalized
  if (normalized.startsWith('//')) return `https:${normalized}`
  return new URL(normalized.replace(/^\/+/, ''), FISH_AUDIO_PUBLIC_ASSET_URL).toString()
}

function normalizeSelectedVoiceId(value: string): string {
  const normalized = String(value || '').trim()
  return normalized.startsWith('demo-') ? '' : normalized
}

function normalizeModel(value: unknown): TextToSpeechModel {
  return value === 's2.1-pro' ? 's2.1-pro' : 's2.1-pro-free'
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

async function fishAudioError(response: Response): Promise<Error> {
  let detail = ''
  try {
    const payload = (await response.json()) as
      | { status?: number; message?: string }
      | Array<{ msg?: string }>
    detail = Array.isArray(payload)
      ? payload
          .map((item) => item.msg)
          .filter(Boolean)
          .join('；')
      : payload.message || ''
  } catch {
    detail = await response.text().catch(() => '')
  }
  if (response.status === 401) return new Error('API Key 无效或已失效')
  if (response.status === 402) return new Error('语音服务余额不足')
  if (response.status === 404) return new Error('所选音色不存在或不可访问')
  if (response.status === 422) return new Error(detail || '语音生成参数不正确')
  if (response.status === 503) return new Error('语音服务暂时不可用，请稍后重试')
  return new Error(detail || `语音服务请求失败（HTTP ${response.status}）`)
}

async function fishAudioFetch(input: string, init: RequestInit): Promise<Response> {
  try {
    return await net.fetch(input, init)
  } catch (electronError) {
    try {
      return await fetch(input, init)
    } catch (nodeError) {
      throw new Error(
        `Fish Audio 网络请求失败（Electron: ${networkErrorMessage(electronError)}；Node: ${networkErrorMessage(nodeError)}）`
      )
    }
  }
}

function networkErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return String(error || '未知错误')
}

function safeFishAudioError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return '语音服务请求超时'
  if (error instanceof Error) return error.message
  return '语音服务请求失败'
}
