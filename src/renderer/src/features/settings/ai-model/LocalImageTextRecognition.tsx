import { useCallback, useEffect, useState } from 'react'
import type {
  SystemOcrCapability,
  SystemOcrEngine,
  SystemOcrResult
} from '../../../../../shared/system-ocr'
import { Button } from '../../../components/ui'

const MAX_FILE_BYTES = 10 * 1024 * 1024

type LocalOcrStatus = 'idle' | 'reading' | 'ready' | 'running' | 'done' | 'error'

interface LocalOcrState {
  status: LocalOcrStatus
  image?: {
    dataUrl: string
    fileName: string
    size: number
  }
  result?: SystemOcrResult
  error?: string
}

/**
 * 本地图片文字识别（系统 OCR）。
 *
 * 这是**本地 Runtime**，不是 AI 图片理解：
 *   - 只把图片里的文字读出来；不描述画面、人物、场景，也不做视觉推理；
 *   - 原始图片不会因为这一步发给任何 AI Provider；
 *   - 结果只是派生内容，不会写进本地知识库。
 *
 * 引擎由平台决定（Windows 系统 OCR / macOS 系统 OCR），UI 一律从 capability 派生文案，
 * 不硬编码平台名。
 */
export function LocalImageTextRecognition(): React.ReactElement {
  const [capability, setCapability] = useState<SystemOcrCapability | null>(null)
  const [state, setState] = useState<LocalOcrState>({ status: 'idle' })

  useEffect(() => {
    let alive = true
    void window.api
      .getSystemOcrCapability()
      .then((value) => {
        if (alive) setCapability(value)
      })
      .catch(() => {
        if (alive) setCapability(null)
      })
    return () => {
      alive = false
    }
  }, [])

  const selectImage = useCallback(async (file: File): Promise<void> => {
    const extension = file.name.split('.').pop()?.toLowerCase()
    const inferredType =
      extension === 'png'
        ? 'image/png'
        : extension === 'jpg' || extension === 'jpeg'
          ? 'image/jpeg'
          : extension === 'webp'
            ? 'image/webp'
            : extension === 'bmp'
              ? 'image/bmp'
              : extension === 'gif'
                ? 'image/gif'
                : ''
    const mimeType = file.type === 'image/jpg' ? 'image/jpeg' : file.type || inferredType
    const supportedTypes = new Set([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/bmp',
      'image/gif'
    ])
    if (!supportedTypes.has(mimeType)) {
      setState({ status: 'error', error: '请选择 PNG、JPG、JPEG、WebP、BMP 或 GIF 图片' })
      return
    }
    if (!file.size || file.size > MAX_FILE_BYTES) {
      setState({ status: 'error', error: '图片大小必须在 10 MB 以内' })
      return
    }
    setState({ status: 'reading' })
    try {
      const rawDataUrl = await readFileAsDataUrl(file)
      const dataUrl = rawDataUrl.replace(/^data:[^;]*;/, `data:${mimeType};`)
      setState({
        status: 'ready',
        image: { dataUrl, fileName: file.name, size: file.size }
      })
    } catch {
      setState({ status: 'error', error: '图片无法读取，请重新选择' })
    }
  }, [])

  const run = useCallback(async (): Promise<void> => {
    const image = state.image
    if (!image) return
    if (!capability?.available) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: capability?.message || '本机当前不支持本地图片文字识别'
      }))
      return
    }
    setState((current) => ({ ...current, status: 'running', result: undefined, error: undefined }))
    try {
      const result = await window.api.recognizeLocalImageText({ imageDataUrl: image.dataUrl })
      setState((current) =>
        result.success
          ? { ...current, status: 'done', result, error: undefined }
          : { ...current, status: 'error', result: undefined, error: localOcrErrorMessage(result) }
      )
    } catch {
      setState((current) => ({
        ...current,
        status: 'error',
        result: undefined,
        error: '本地文字识别调用失败，请重试'
      }))
    }
  }, [capability, state.image])

  const clear = useCallback(() => setState({ status: 'idle' }), [])

  const running = state.status === 'running'
  const result = state.result
  const engineLabel = systemOcrEngineLabel(capability?.engine)

  return (
    <section className="settings-card local-ocr-test">
      <header>
        <div>
          <h2>本地图片文字识别</h2>
          <p>使用{engineLabel}在本机读取图片中的文字，原始图片无需发送给 AI Provider。</p>
        </div>
        <span className={`local-ocr-capability ${capability?.available ? 'supported' : ''}`}>
          {capability ? (capability.available ? '本机可用' : '本机不可用') : '检测中…'}
        </span>
      </header>

      {capability && !capability.available ? (
        <p className="local-ocr-notice">{capability.message}</p>
      ) : null}
      {capability?.available ? (
        <p className="local-ocr-runtime">
          引擎：{engineLabel}
          {capability.runtimeVersion ? ` · 组件 ${capability.runtimeVersion}` : ''}
          {capability.language ? ` · 语言 ${capability.language}` : ' · 语言跟随系统'}
        </p>
      ) : null}

      <label className={`local-ocr-upload ${state.image ? 'has-image' : ''}`}>
        <input
          type="file"
          accept=".png,.jpg,.jpeg,.webp,.bmp,.gif,image/png,image/jpeg,image/webp,image/bmp,image/gif"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            if (file) void selectImage(file)
            event.currentTarget.value = ''
          }}
        />
        {state.image ? (
          <>
            <img src={state.image.dataUrl} alt="本地文字识别测试预览" />
            <div>
              <strong>{state.image.fileName}</strong>
              <small>{formatFileSize(state.image.size)} · 仅保存在内存中</small>
            </div>
          </>
        ) : (
          <div>
            <strong>{state.status === 'reading' ? '正在读取图片…' : '选择本地图片'}</strong>
            <small>支持 PNG、JPG、JPEG、WebP、BMP、GIF，最大 10 MB</small>
          </div>
        )}
      </label>

      <p className="local-ocr-privacy">
        使用本地 OCR 时，原始图片无需发送给 AI Provider，也不会写入本地缓存或知识库。如果后续继续使用云端
        AI 分析，提取出的文字可能按当前 Provider 配置发送。
      </p>

      {state.error ? <p className="local-ocr-error">{state.error}</p> : null}

      {result?.success ? (
        <div className="local-ocr-result">
          <h3>识别结果</h3>
          <dl>
            <div>
              <dt>引擎</dt>
              <dd>{systemOcrEngineLabel(result.engine)}</dd>
            </div>
            <div>
              <dt>语言</dt>
              <dd>{result.language || '跟随系统'}</dd>
            </div>
            <div>
              <dt>耗时</dt>
              <dd>{Math.round(result.durationMs)} ms</dd>
            </div>
          </dl>
          <pre className="local-ocr-text">{result.text}</pre>
          <p className="local-ocr-hint">
            本地文字识别只读取图片中的文字内容，不会描述画面、人物或场景。
          </p>
        </div>
      ) : null}

      <footer>
        {state.image ? (
          <Button variant="outline" onClick={clear}>
            移除图片
          </Button>
        ) : null}
        <Button
          disabled={!state.image || running || !capability?.available}
          onClick={() => void run()}
        >
          {running ? '识别中…' : '本地文字识别'}
        </Button>
      </footer>
    </section>
  )
}

/** 引擎标识 → 展示名。UI 不硬编码平台，一律从 capability / result 派生。 */
function systemOcrEngineLabel(engine: SystemOcrEngine | undefined): string {
  switch (engine) {
    case 'macos-system-ocr':
      return 'macOS 系统 OCR'
    case 'windows-system-ocr':
      return 'Windows 系统 OCR'
    default:
      return '系统 OCR'
  }
}

function localOcrErrorMessage(result: SystemOcrResult): string {
  switch (result.errorCode) {
    case 'UNSUPPORTED_PLATFORM':
      return '本地图片文字识别目前支持 Windows 与 macOS。'
    case 'SYSTEM_OCR_UNAVAILABLE':
      return '本地文字识别组件不可用，请重新安装 TraceMemo。'
    case 'OCR_LANGUAGE_UNAVAILABLE':
      return '当前 Windows 未安装可用的 OCR 语言支持，请在系统「语言和区域」中安装中文或英文语言包。'
    case 'UNSUPPORTED_IMAGE':
      return '这张图片的格式暂不支持本地文字识别。'
    case 'IMAGE_DECODE_FAILED':
      return '图片解码失败，无法读取这张图片。'
    case 'OCR_EMPTY_RESULT':
      return '没有在这张图片里识别到文字。'
    default:
      return result.error || '本地文字识别失败，请重试。'
  }
}

function formatFileSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('invalid image'))
    )
    reader.addEventListener('error', () => reject(reader.error || new Error('read failed')))
    reader.readAsDataURL(file)
  })
}
