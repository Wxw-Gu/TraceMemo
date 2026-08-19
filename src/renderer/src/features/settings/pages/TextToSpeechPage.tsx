import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  TextToSpeechModel,
  TextToSpeechSettings,
  TextToSpeechVoice
} from '../../../../../shared/text-to-speech'
import type { PersonalWechatRuntimeStatus } from '../../../../../shared/personal-wechat-runtime'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../../components/ui'
import { isMac, isWindows } from '../../../utils/runtime-environment'

const VOICE_PAGE_SIZE = 24
const WECHAT_VERSION_DOWNLOAD_URL = 'https://github.com/zsbai/wechat-versions/releases'
const SHOW_SUPPORTED_WECHAT_VERSIONS_KEY = 'wxe:show-supported-wechat-versions'
const BUNDLED_WECHAT_VERSIONS = [
  '4.1.6.12',
  '4.1.6.46',
  '4.1.6.47',
  '4.1.7.31',
  '4.1.7.55',
  '4.1.7.57',
  '4.1.8.28',
  '4.1.8.29',
  '4.1.8.104',
  '4.1.8.107',
  '4.1.9.52',
  '4.1.9.55',
  '4.1.9.58',
  '4.1.10.53',
  '4.1.11.53'
] as const

const RUNTIME_STATUS_LABELS: Record<PersonalWechatRuntimeStatus['state'], string> = {
  missing: '未下载',
  downloading: '下载中',
  ready: '已就绪',
  invalid: '需要修复',
  error: '下载失败',
  unsupported: '暂不支持'
}

const VOICE_FILTERS = [
  { value: 'male', label: '男性' },
  { value: 'female', label: '女性' },
  { value: 'neutral', label: '中性' },
  { value: 'young', label: '年轻' },
  { value: 'middle-aged', label: '中年' },
  { value: 'narration', label: '旁白' },
  { value: 'social-media', label: '社交媒体' },
  { value: 'sexy', label: '性感' },
  { value: 'documentary', label: '纪录片' },
  { value: 'deep', label: '深沉' },
  { value: 'soft', label: '柔和' },
  { value: 'dramatic', label: '戏剧感' },
  { value: 'mysterious', label: '神秘' },
  { value: 'anime', label: '动漫' }
] as const

const VOICE_FILTER_GROUPS = [
  ['male', 'female', 'neutral'],
  ['young', 'middle-aged']
] as const

const VOICE_TAG_LABELS: Record<string, string> = {
  zh: '中文',
  Chinese: '中文',
  en: '英语',
  English: '英语',
  male: '男性',
  female: '女性',
  neutral: '中性',
  young: '年轻',
  'middle-aged': '中年',
  old: '年长',
  conversational: '对话',
  narration: '旁白',
  'character-voice': '角色声音',
  'social-media': '社交媒体',
  educational: '教育',
  advertisement: '广告',
  entertainment: '娱乐',
  deep: '深沉',
  low: '低沉',
  medium: '中等',
  high: '高亢',
  soft: '柔和',
  bright: '明亮',
  warm: '温暖',
  dark: '暗沉',
  raspy: '沙哑',
  smooth: '顺滑',
  breathy: '气声',
  husky: '烟嗓',
  energetic: '有活力',
  calm: '沉稳',
  relaxed: '放松',
  fast: '快速',
  slow: '缓慢',
  measured: '从容',
  dynamic: '动态',
  sexy: '性感',
  friendly: '亲切',
  professional: '专业',
  serious: '严肃',
  cheerful: '欢快',
  enthusiastic: '热情',
  confident: '自信',
  authoritative: '权威',
  gentle: '温柔',
  empathetic: '共情',
  playful: '活泼',
  dramatic: '戏剧感',
  intimate: '亲密',
  mysterious: '神秘',
  sad: '悲伤',
  angry: '愤怒',
  clear: '清晰',
  crisp: '清脆',
  'neutral-tone': '中性语气',
  expressive: '有表现力',
  monotone: '平稳',
  animated: '生动',
  storytelling: '故事感',
  narrative: '叙事',
  character: '角色',
  announcer: '播音',
  host: '主持',
  teacher: '教师',
  coach: '教练',
  anime: '动漫',
  gaming: '游戏',
  cinematic: '电影感',
  documentary: '纪录片',
  radio: '电台',
  podcast: '播客'
}

function compactCount(value?: number): string {
  if (!value) return '0'
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(value)
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function voiceMetaTags(voice: TextToSpeechVoice): string[] {
  return Array.from(new Set([...voice.languages, ...voice.tags])).filter(Boolean)
}

function voiceTagLabel(tag: string): string {
  return VOICE_TAG_LABELS[tag] || tag
}

function VoiceAvatar({ voice }: { voice: TextToSpeechVoice }): React.ReactElement {
  return (
    <span className="tts-voice-media" aria-hidden>
      <span className="tts-voice-avatar">{voice.name.slice(0, 1)}</span>
      {voice.coverImage ? (
        <img
          src={voice.coverImage}
          alt=""
          className="tts-voice-cover"
          onError={(event) => {
            event.currentTarget.hidden = true
          }}
        />
      ) : null}
    </span>
  )
}

export function TextToSpeechPage({
  onNotice
}: {
  onNotice: (message: string) => void
}): React.ReactElement {
  const [settings, setSettings] = useState<TextToSpeechSettings | null>(null)
  const [voices, setVoices] = useState<TextToSpeechVoice[]>([])
  const [selectedVoiceId, setSelectedVoiceId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [pageNumber, setPageNumber] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingVoices, setLoadingVoices] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [savingVoiceId, setSavingVoiceId] = useState('')
  const [playingVoiceId, setPlayingVoiceId] = useState('')
  const [runtimeStatus, setRuntimeStatus] = useState<PersonalWechatRuntimeStatus | null>(null)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [showWechatVersions, setShowWechatVersions] = useState(false)
  const [error, setError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const wechatVersionsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const personalWechatRuntimeSupported = isMac && Boolean(runtimeStatus?.supported)

  const loadVoices = useCallback(
    async (nextPage: number, title: string, append = false, tags: string[] = []): Promise<void> => {
      setLoadingVoices(true)
      setError('')
      try {
        const result = await window.api.listTextToSpeechVoices({
          pageNumber: nextPage,
          pageSize: VOICE_PAGE_SIZE,
          title: title || undefined,
          tags
        })
        if (!result.success) {
          setError(result.error || '音色加载失败')
          return
        }
        setVoices((current) => {
          const merged = append ? [...current, ...result.items] : result.items
          return Array.from(new Map(merged.map((voice) => [voice.id, voice])).values())
        })
        setPageNumber(result.pageNumber)
        setTotal(result.total)
        setHasMore(result.hasMore)
        setAppliedQuery(title)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '音色加载失败')
      } finally {
        setLoadingVoices(false)
      }
    },
    []
  )

  useEffect(() => {
    let active = true
    void window.api
      .getTextToSpeechSettings()
      .then(async (result) => {
        if (!active) return
        setSettings(result.settings)
        setSelectedVoiceId(result.settings.selectedVoiceId)
        setError(result.success ? '' : result.error || '文字转语音配置读取失败')
        setLoading(false)
        if (result.settings.hasApiKey) await loadVoices(1, '')
      })
      .catch((reason) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : '文字转语音配置读取失败')
        setLoading(false)
      })
    return () => {
      active = false
      audioRef.current?.pause()
    }
  }, [loadVoices])

  useEffect(() => {
    try {
      if (sessionStorage.getItem(SHOW_SUPPORTED_WECHAT_VERSIONS_KEY) !== '1') return
      sessionStorage.removeItem(SHOW_SUPPORTED_WECHAT_VERSIONS_KEY)
      setShowWechatVersions(true)
    } catch {
      // The page remains usable if session storage is unavailable.
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.api
      .getPersonalWechatRuntimeStatus()
      .then((status) => active && setRuntimeStatus(status))
      .catch((reason) => {
        if (!active) return
        setRuntimeStatus(null)
        setError(reason instanceof Error ? reason.message : '微信发送组件状态读取失败')
      })
    const unsubscribe = window.api.onPersonalWechatRuntimeProgress((status) => {
      if (active) setRuntimeStatus(status)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const selectedVoice = voices.find((voice) => voice.id === selectedVoiceId)
  const visibleVoices = useMemo(() => voices, [voices])

  const saveApiKey = async (): Promise<void> => {
    if (!apiKey.trim() || savingKey) return
    setSavingKey(true)
    setError('')
    try {
      const result = await window.api.saveTextToSpeechSettings({ apiKey: apiKey.trim() })
      setSettings(result.settings)
      if (!result.success) {
        setError(result.error || 'API Key 保存失败')
        onNotice(result.error || 'API Key 保存失败')
        return
      }
      setApiKey('')
      onNotice('API Key 已安全保存')
      await loadVoices(1, '')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'API Key 保存失败'
      setError(message)
      onNotice(message)
    } finally {
      setSavingKey(false)
    }
  }

  const clearApiKey = async (): Promise<void> => {
    if (!settings?.hasStoredApiKey || savingKey) return
    setSavingKey(true)
    setError('')
    try {
      const result = await window.api.saveTextToSpeechSettings({ clearApiKey: true })
      setSettings(result.settings)
      setApiKey('')
      if (!result.success) {
        setError(result.error || 'API Key 清除失败')
        return
      }
      onNotice(
        result.settings.hasEnvironmentApiKey
          ? '已清除应用内 Key，将继续使用应用环境中的 Key'
          : 'API Key 已清除'
      )
      if (!result.settings.hasApiKey) {
        setVoices([])
        setTotal(0)
        setHasMore(false)
      }
    } finally {
      setSavingKey(false)
    }
  }

  const selectVoice = async (voice: TextToSpeechVoice): Promise<void> => {
    if (savingVoiceId) return
    const previous = selectedVoiceId
    setSelectedVoiceId(voice.id)
    setSavingVoiceId(voice.id)
    setError('')
    try {
      const result = await window.api.saveTextToSpeechSettings({ selectedVoiceId: voice.id })
      setSettings(result.settings)
      if (!result.success) {
        setSelectedVoiceId(previous)
        setError(result.error || '音色保存失败')
        return
      }
      onNotice(`已选择音色：${voice.name}`)
    } catch (reason) {
      setSelectedVoiceId(previous)
      setError(reason instanceof Error ? reason.message : '音色保存失败')
    } finally {
      setSavingVoiceId('')
    }
  }

  const changeModel = async (model: TextToSpeechModel): Promise<void> => {
    if (!settings) return
    const previous = settings.model
    setSettings({ ...settings, model })
    const result = await window.api.saveTextToSpeechSettings({ model })
    if (!result.success) {
      setSettings({ ...settings, model: previous })
      setError(result.error || '合成模型保存失败')
      return
    }
    setSettings(result.settings)
    onNotice(model === 's2.1-pro-free' ? '已切换到标准模型' : '已切换到高质量模型')
  }

  const searchVoices = async (): Promise<void> => {
    await loadVoices(1, query.trim(), false, selectedTags)
  }

  const toggleVoiceFilter = async (tag: string): Promise<void> => {
    const isSelected = selectedTags.includes(tag)
    const exclusiveGroup = VOICE_FILTER_GROUPS.find((group) => group.includes(tag as never))
    const nextTags = isSelected
      ? selectedTags.filter((item) => item !== tag)
      : [
          ...(exclusiveGroup
            ? selectedTags.filter((item) => !exclusiveGroup.includes(item as never))
            : selectedTags),
          tag
        ]
    setSelectedTags(nextTags)
    await loadVoices(1, appliedQuery, false, nextTags)
  }

  const clearVoiceFilters = async (): Promise<void> => {
    setSelectedTags([])
    await loadVoices(1, appliedQuery, false, [])
  }

  const playPreview = (voice: TextToSpeechVoice): void => {
    if (!voice.previewUrl) {
      onNotice('这个音色暂时没有公开试听片段')
      return
    }
    audioRef.current?.pause()
    if (playingVoiceId === voice.id) {
      setPlayingVoiceId('')
      return
    }
    const audio = new Audio(voice.previewUrl)
    audioRef.current = audio
    setPlayingVoiceId(voice.id)
    audio.addEventListener('ended', () => setPlayingVoiceId(''), { once: true })
    audio.addEventListener(
      'error',
      () => {
        setPlayingVoiceId('')
        onNotice('音色试听加载失败')
      },
      { once: true }
    )
    void audio.play().catch(() => {
      setPlayingVoiceId('')
      onNotice('音色试听播放失败')
    })
  }

  const openApiKeys = async (): Promise<void> => {
    const result = await window.api.openFishAudioApiKeys()
    if (!result.success) onNotice(result.error || '无法打开 API Key 页面')
  }

  const refreshRuntime = async (): Promise<void> => {
    setRuntimeStatus(await window.api.getPersonalWechatRuntimeStatus())
  }

  const downloadRuntime = async (): Promise<void> => {
    if (runtimeBusy || !isMac || !runtimeStatus?.supported) return
    setRuntimeBusy(true)
    setRuntimeStatus((current) =>
      current ? { ...current, state: 'downloading', downloadedBytes: 0, progress: 0 } : current
    )
    try {
      const result = await window.api.downloadPersonalWechatRuntime()
      setRuntimeStatus(result.status)
      onNotice(result.success ? '微信发送组件已准备好' : result.error || '发送组件下载失败')
    } finally {
      setRuntimeBusy(false)
    }
  }

  const cancelRuntimeDownload = async (): Promise<void> => {
    if (!personalWechatRuntimeSupported) return
    await window.api.cancelPersonalWechatRuntimeDownload()
    onNotice('正在取消发送组件下载')
  }

  const removeRuntime = async (): Promise<void> => {
    if (!personalWechatRuntimeSupported || !runtimeStatus?.removable || runtimeBusy) return
    if (!window.confirm('卸载微信发送组件？以后需要向个人微信发送语音时可以重新下载。')) return
    setRuntimeBusy(true)
    try {
      setRuntimeStatus(await window.api.removePersonalWechatRuntime())
      onNotice('微信发送组件已卸载')
    } catch (reason) {
      onNotice(reason instanceof Error ? `发送组件卸载失败：${reason.message}` : '发送组件卸载失败')
    } finally {
      setRuntimeBusy(false)
    }
  }

  const openRuntimeDirectory = async (): Promise<void> => {
    if (!personalWechatRuntimeSupported) return
    const result = await window.api.openPersonalWechatRuntimeDirectory()
    if (!result.success) onNotice(result.error || '无法打开发送组件目录')
  }

  const keyStatusText = !settings
    ? '正在读取 API Key 状态'
    : settings.keySource === 'secure-storage'
      ? 'Key 已保存在系统安全存储中，页面不会回显完整内容'
      : settings.keySource === 'environment'
        ? '已从应用环境中读取 API Key'
        : settings.encryptionAvailable
          ? '还没有配置 API Key，可在这里直接保存'
          : '当前系统安全存储不可用，请从应用环境中提供 API Key'

  return (
    <Dialog open={showWechatVersions} onOpenChange={setShowWechatVersions}>
      <div className="settings-page text-to-speech-page">
        <header className="settings-page-header">
          <div>
            <h1>文字转语音</h1>
            <p>选择喜欢的音色，把文字生成为可发送的微信语音</p>
          </div>
          <span className={`settings-status-badge ${settings?.hasApiKey ? '' : 'unavailable'}`}>
            {loading ? '读取中' : settings?.hasApiKey ? '已配置' : '未配置'}
          </span>
        </header>

        <div className="settings-page-scroll">
          <div className="settings-page-content text-to-speech-content">
            <section className="tts-usage-guide">
              <div className="tts-usage-guide-heading">
                <div>
                  <span className="tts-experimental-badge">实验性功能</span>
                  <h2>使用说明</h2>
                </div>
                <p>语音生成与微信发送是两个独立步骤。建议先生成并试听，确认无误后再发送。</p>
              </div>

              <ol className="tts-usage-steps">
                <li>
                  <span>1</span>
                  <div>
                    <strong>配置并选择音色</strong>
                    <p>保存 API Key，在下方音色库中选择一个音色。</p>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>在档案中生成语音</strong>
                    <p>打开联系人或群聊的测试发送，选择“语音 → 输入文字生成”。</p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <strong>试听后手动发送</strong>
                    <p>点击“生成语音”，播放检查内容，再点击发送到当前会话。</p>
                  </div>
                </li>
              </ol>

              <div className="tts-hook-warning">
                <div className="tts-hook-warning-icon" aria-hidden>
                  !
                </div>
                <div>
                  <strong>微信发送能力注意事项</strong>
                  <ul>
                    <li>
                      仅支持与当前 OneBot 运行时配置匹配的 macOS
                      微信版本；微信自动更新后需要重新确认兼容性。
                    </li>
                    <li>
                      发送功能需要关闭 SIP 并连接微信进程。关闭 SIP
                      会降低系统安全性，请确认风险后再使用。
                    </li>
                    <li>微信重新登录或 PID 改变后，需要在测试发送弹窗中点击“尝试重新绑定”。</li>
                  </ul>
                  {personalWechatRuntimeSupported ? (
                    <Button
                      className="mt-2"
                      variant="outline"
                      size="sm"
                      onClick={(event) => {
                        wechatVersionsTriggerRef.current = event.currentTarget
                        setShowWechatVersions(true)
                      }}
                    >
                      查看支持版本
                    </Button>
                  ) : null}
                </div>
              </div>
            </section>

            <h2 className="settings-section-heading">微信发送组件</h2>
            <section className="settings-card tts-runtime-card">
              <div className="tts-runtime-summary">
                <span className="settings-card-kicker">
                  OneBot {runtimeStatus?.version || 'v0.0.18'}
                </span>
                <strong>
                  {!isMac
                    ? '暂不支持'
                    : runtimeStatus?.state === 'downloading'
                      ? `正在下载 ${Math.round(runtimeStatus.progress * 100)}%`
                      : runtimeStatus
                        ? RUNTIME_STATUS_LABELS[runtimeStatus.state]
                        : '正在检测'}
                </strong>
                <small>
                  {isWindows
                    ? 'Windows 暂不支持个人微信发送；仍可生成和试听语音'
                    : !isMac
                      ? '当前平台暂不支持个人微信发送'
                      : !runtimeStatus
                        ? '正在检测当前平台与组件状态'
                        : personalWechatRuntimeSupported
                          ? `仅用于连接 macOS 微信 · ${formatBytes(runtimeStatus.totalBytes)}`
                          : '当前 Mac 环境不满足个人微信发送组件要求'}
                </small>
                {runtimeStatus?.error ? (
                  <p className="tts-runtime-error">{runtimeStatus.error}</p>
                ) : null}
              </div>

              <div className="tts-runtime-actions">
                {personalWechatRuntimeSupported && runtimeStatus?.state === 'downloading' ? (
                  <button type="button" onClick={() => void cancelRuntimeDownload()}>
                    取消下载
                  </button>
                ) : personalWechatRuntimeSupported && runtimeStatus?.state === 'ready' ? (
                  <>
                    {runtimeStatus.directory ? (
                      <button type="button" onClick={() => void openRuntimeDirectory()}>
                        打开目录
                      </button>
                    ) : null}
                    {runtimeStatus.removable ? (
                      <button
                        type="button"
                        className="settings-danger-button"
                        disabled={runtimeBusy}
                        onClick={() => void removeRuntime()}
                      >
                        卸载组件
                      </button>
                    ) : null}
                  </>
                ) : personalWechatRuntimeSupported ? (
                  <button
                    type="button"
                    className="settings-primary-button"
                    disabled={runtimeBusy}
                    onClick={() => void downloadRuntime()}
                  >
                    {runtimeStatus?.state === 'invalid' || runtimeStatus?.state === 'error'
                      ? '重新下载'
                      : '下载组件'}
                  </button>
                ) : null}
                <button type="button" disabled={runtimeBusy} onClick={() => void refreshRuntime()}>
                  重新检测
                </button>
                {personalWechatRuntimeSupported ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      wechatVersionsTriggerRef.current = event.currentTarget
                      setShowWechatVersions(true)
                    }}
                  >
                    支持版本
                  </button>
                ) : null}
              </div>

              {personalWechatRuntimeSupported && runtimeStatus?.state === 'downloading' ? (
                <div className="tts-runtime-progress">
                  <div>
                    <span>{Math.round(runtimeStatus.progress * 100)}%</span>
                    <small>
                      {formatBytes(runtimeStatus.downloadedBytes)} /{' '}
                      {formatBytes(runtimeStatus.totalBytes)}
                    </small>
                  </div>
                  <progress
                    value={runtimeStatus.progress}
                    max={1}
                    aria-label="微信发送组件下载进度"
                  />
                </div>
              ) : null}
            </section>

            <h2 className="settings-section-heading">API 设置</h2>
            <section className="settings-card tts-api-card">
              <div className="tts-api-heading">
                <div>
                  <span className="settings-card-kicker">语音服务</span>
                  <strong>API Key</strong>
                  <p>保存后即可加载音色并生成语音。</p>
                </div>
                <button type="button" onClick={() => void openApiKeys()}>
                  前往 api.fish.audio 获取 Key
                </button>
              </div>
              <label className="tts-api-input">
                <span>API Key</span>
                <div>
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    disabled={savingKey || !settings?.encryptionAvailable}
                    placeholder={
                      settings?.hasStoredApiKey
                        ? '已安全保存；输入新 Key 可替换'
                        : settings?.hasEnvironmentApiKey
                          ? '当前使用环境变量；也可保存一个应用专用 Key'
                          : '粘贴 API Key'
                    }
                    autoComplete="off"
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <button type="button" onClick={() => setShowApiKey((current) => !current)}>
                    {showApiKey ? '隐藏' : '显示'}
                  </button>
                  <button
                    type="button"
                    className="tts-save-key-button"
                    disabled={!apiKey.trim() || savingKey || !settings?.encryptionAvailable}
                    onClick={() => void saveApiKey()}
                  >
                    {savingKey ? '保存中…' : '保存 Key'}
                  </button>
                </div>
              </label>
              <div className="tts-api-footer">
                <span>{keyStatusText}</span>
                {settings?.hasStoredApiKey ? (
                  <button
                    type="button"
                    className="settings-danger-button"
                    onClick={() => void clearApiKey()}
                  >
                    清除应用内 Key
                  </button>
                ) : null}
              </div>
              <label className="tts-model-select">
                <span>合成模型</span>
                <select
                  value={settings?.model || 's2.1-pro-free'}
                  disabled={!settings}
                  onChange={(event) => void changeModel(event.target.value as TextToSpeechModel)}
                >
                  <option value="s2.1-pro-free">s2.1-pro-free</option>
                  <option value="s2.1-pro">s2.1-pro</option>
                </select>
              </label>
            </section>

            <div className="tts-voice-heading">
              <div>
                <h2 className="settings-section-heading">选择音色</h2>
                <p>
                  当前已加载 {voices.length} 个音色{total ? `，共找到 ${total} 个` : ''}。
                </p>
              </div>
              <form
                className="tts-voice-search"
                onSubmit={(event) => {
                  event.preventDefault()
                  void searchVoices()
                }}
              >
                <span aria-hidden>⌕</span>
                <input
                  type="search"
                  value={query}
                  placeholder="按音色名称搜索"
                  disabled={!settings?.hasApiKey || loadingVoices}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button type="submit" disabled={!settings?.hasApiKey || loadingVoices}>
                  搜索
                </button>
              </form>
            </div>

            <div className="tts-voice-filters" aria-label="音色筛选">
              <button
                type="button"
                className={!selectedTags.length ? 'active' : ''}
                disabled={!settings?.hasApiKey || loadingVoices}
                onClick={() => void clearVoiceFilters()}
              >
                全部
              </button>
              {VOICE_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={selectedTags.includes(filter.value) ? 'active' : ''}
                  disabled={!settings?.hasApiKey || loadingVoices}
                  onClick={() => void toggleVoiceFilter(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>

            {selectedVoice ? (
              <section className="tts-current-voice">
                <VoiceAvatar voice={selectedVoice} />
                <div>
                  <span className="settings-card-kicker">当前音色</span>
                  <strong>{selectedVoice.name}</strong>
                  <p>
                    {selectedVoice.authorName ? `${selectedVoice.authorName} · ` : ''}
                    {selectedVoice.description}
                  </p>
                </div>
                <div className="tts-current-tags">
                  {voiceMetaTags(selectedVoice)
                    .slice(0, 5)
                    .map((tag) => (
                      <span key={tag}>{voiceTagLabel(tag)}</span>
                    ))}
                  {voiceMetaTags(selectedVoice).length > 5 ? (
                    <span>+{voiceMetaTags(selectedVoice).length - 5}</span>
                  ) : null}
                </div>
              </section>
            ) : null}

            {!settings?.hasApiKey && !loading ? (
              <div className="settings-card tts-voice-empty">
                <strong>先配置 API Key</strong>
                <span>保存后即可加载并选择音色。</span>
              </div>
            ) : (
              <div className="tts-voice-grid" role="radiogroup" aria-label="可用音色">
                {visibleVoices.map((voice) => {
                  const selected = voice.id === selectedVoiceId
                  return (
                    <article
                      key={voice.id}
                      className={`tts-voice-card ${selected ? 'selected' : ''}`}
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className="tts-voice-select"
                        disabled={Boolean(savingVoiceId)}
                        onClick={() => void selectVoice(voice)}
                      >
                        <VoiceAvatar voice={voice} />
                        <span className="tts-voice-copy">
                          <span className="tts-voice-title-row">
                            <strong>{voice.name}</strong>
                            {voice.authorName ? <em>{voice.authorName}</em> : null}
                          </span>
                          <small>{voice.description || '公开音色'}</small>
                          <span className="tts-voice-tags">
                            {voiceMetaTags(voice)
                              .slice(0, 4)
                              .map((tag) => (
                                <span key={tag}>{voiceTagLabel(tag)}</span>
                              ))}
                            {voiceMetaTags(voice).length > 4 ? (
                              <span>+{voiceMetaTags(voice).length - 4}</span>
                            ) : null}
                          </span>
                          <span className="tts-voice-stats">
                            <span title="使用量">▥ {compactCount(voice.taskCount)}</span>
                            <span title="喜欢">♡ {compactCount(voice.likeCount)}</span>
                            {voice.markCount ? (
                              <span title="收藏">☆ {compactCount(voice.markCount)}</span>
                            ) : null}
                          </span>
                        </span>
                        <span className="tts-voice-check">
                          {savingVoiceId === voice.id ? '…' : selected ? '✓' : ''}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="tts-voice-preview"
                        disabled={!voice.previewUrl}
                        onClick={() => playPreview(voice)}
                      >
                        {playingVoiceId === voice.id ? '停止' : '试听'}
                      </button>
                    </article>
                  )
                })}
              </div>
            )}

            {loadingVoices ? <div className="tts-voice-loading">正在加载音色…</div> : null}
            {!loadingVoices && settings?.hasApiKey && !voices.length ? (
              <div className="settings-card tts-voice-empty">
                {appliedQuery ? `没有找到“${appliedQuery}”相关音色` : '没有获取到可用音色'}
              </div>
            ) : null}
            {hasMore ? (
              <button
                type="button"
                className="tts-load-more"
                disabled={loadingVoices}
                onClick={() => void loadVoices(pageNumber + 1, appliedQuery, true, selectedTags)}
              >
                加载更多音色
              </button>
            ) : null}
            {error ? <p className="tts-settings-error">{error}</p> : null}
          </div>
        </div>
      </div>
      <DialogContent
        className="max-h-[calc(100vh-3rem)] max-w-[620px] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          const trigger = wechatVersionsTriggerRef.current
          if (!trigger) return
          event.preventDefault()
          trigger.focus()
          wechatVersionsTriggerRef.current = null
        }}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg">支持的微信版本</DialogTitle>
          <DialogDescription>请安装下列完整版本之一。</DialogDescription>
        </DialogHeader>
        <a
          className="w-fit rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary hover:border-primary"
          href={WECHAT_VERSION_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
        >
          下载微信历史版本 ↗
        </a>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {BUNDLED_WECHAT_VERSIONS.map((version) => (
            <span
              className="rounded-md border border-border bg-background px-2 py-2 text-center text-xs text-muted-foreground"
              key={version}
            >
              {version}
            </span>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
