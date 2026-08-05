import { createHash } from 'crypto'
import { net } from 'electron'
import { createReadStream } from 'fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type { VoiceModelDownloadResult, VoiceModelStatus } from '../../shared/voice-recognition'
import { DEFAULT_VOICE_MODEL_ID } from '../../shared/voice-recognition'

const MODEL_VERSION = '2024-07-17'
// SHA-256 values come from the repository's Git LFS object IDs. Hugging Face's
// xetHash is a storage-level hash and does not match the downloaded file bytes.
export const SENSEVOICE_MODEL_FILES = [
  {
    name: 'model.int8.onnx',
    size: 239_233_841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx'
  },
  {
    name: 'tokens.txt',
    size: 315_894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt'
  }
] as const

const TOTAL_BYTES = SENSEVOICE_MODEL_FILES.reduce((total, file) => total + file.size, 0)
const MODEL_FINGERPRINT = createHash('sha256')
  .update(SENSEVOICE_MODEL_FILES.map((file) => `${file.name}:${file.sha256}`).join('|'))
  .digest('hex')

interface VerifiedManifest {
  modelId: string
  version: string
  fingerprint: string
  files: Record<string, { size: number; sha256: string }>
}

export interface VoiceModelPaths {
  model: string
  tokens: string
}

export class VoiceModelManager {
  readonly modelId = DEFAULT_VOICE_MODEL_ID
  readonly version = MODEL_VERSION
  readonly fingerprint = MODEL_FINGERPRINT
  private readonly modelRoot: string
  private downloadController: AbortController | null = null
  private downloadPromise: Promise<VoiceModelDownloadResult> | null = null
  private progressBytes = 0
  private lastProgressAt = 0
  private progressListener: ((status: VoiceModelStatus) => void) | null = null

  constructor(modelRoot: string) {
    this.modelRoot = modelRoot
  }

  get directory(): string {
    return this.modelRoot
  }

  setProgressListener(listener: ((status: VoiceModelStatus) => void) | null): void {
    this.progressListener = listener
  }

  async getStatus(): Promise<VoiceModelStatus> {
    if (!this.isRuntimeSupported()) {
      return this.buildStatus(
        'unsupported',
        0,
        `当前系统暂不支持离线语音识别：${process.platform} ${process.arch}`
      )
    }
    if (this.downloadPromise) return this.buildStatus('downloading', this.progressBytes)
    const verified = await this.isVerified()
    if (verified) return this.buildStatus('ready', TOTAL_BYTES)
    const hasFiles = await this.hasAnyModelFile()
    return this.buildStatus(
      hasFiles ? 'invalid' : 'missing',
      0,
      hasFiles ? '模型文件不完整或校验失败，请重新下载' : undefined
    )
  }

  async getPaths(): Promise<VoiceModelPaths | null> {
    if (!(await this.isVerified())) return null
    return {
      model: join(this.modelRoot, SENSEVOICE_MODEL_FILES[0].name),
      tokens: join(this.modelRoot, SENSEVOICE_MODEL_FILES[1].name)
    }
  }

  download(): Promise<VoiceModelDownloadResult> {
    if (!this.isRuntimeSupported()) {
      const status = this.buildStatus(
        'unsupported',
        0,
        `当前系统暂不支持离线语音识别：${process.platform} ${process.arch}`
      )
      return Promise.resolve({ success: false, status, error: status.error })
    }
    if (this.downloadPromise) return this.downloadPromise
    this.downloadController = new AbortController()
    this.progressBytes = 0
    this.downloadPromise = this.runDownload(this.downloadController.signal).finally(() => {
      this.downloadPromise = null
      this.downloadController = null
    })
    return this.downloadPromise
  }

  cancelDownload(): boolean {
    if (!this.downloadController) return false
    this.downloadController.abort()
    return true
  }

  async remove(): Promise<VoiceModelStatus> {
    if (this.downloadPromise) return this.buildStatus('downloading', this.progressBytes)
    await Promise.all([
      ...SENSEVOICE_MODEL_FILES.flatMap((file) => [
        rm(join(this.modelRoot, file.name), { force: true }),
        rm(join(this.modelRoot, `${file.name}.partial`), { force: true })
      ]),
      rm(join(this.modelRoot, 'verified.json'), { force: true }),
      rm(join(this.modelRoot, 'verified.json.partial'), { force: true })
    ])
    return this.getStatus()
  }

  private async runDownload(signal: AbortSignal): Promise<VoiceModelDownloadResult> {
    try {
      await mkdir(this.modelRoot, { recursive: true })
      for (const file of SENSEVOICE_MODEL_FILES) {
        await this.downloadFile(file, signal)
      }
      await this.writeVerifiedManifest()
      const status = this.buildStatus('ready', TOTAL_BYTES)
      this.reportProgress(status, true)
      return { success: true, status }
    } catch (error) {
      await Promise.all(
        SENSEVOICE_MODEL_FILES.map((file) =>
          rm(join(this.modelRoot, `${file.name}.partial`), { force: true })
        )
      )
      const cancelled = signal.aborted
      const message = cancelled
        ? '模型下载已取消'
        : error instanceof Error
          ? error.message
          : String(error)
      const status = this.buildStatus(cancelled ? 'missing' : 'error', this.progressBytes, message)
      this.reportProgress(status, true)
      return { success: false, status, error: message }
    }
  }

  private async downloadFile(
    file: (typeof SENSEVOICE_MODEL_FILES)[number],
    signal: AbortSignal
  ): Promise<void> {
    const target = join(this.modelRoot, file.name)
    const partial = `${target}.partial`
    await rm(partial, { force: true })
    // Use Chromium's network stack rather than Node's global fetch so model
    // downloads follow the operating system proxy configuration. This matters
    // on networks where Hugging Face is only reachable through a system proxy.
    const response = await net.fetch(file.url, { signal })
    if (!response.ok || !response.body) throw new Error(`模型下载失败：HTTP ${response.status}`)

    const handle = await open(partial, 'w')
    const hash = createHash('sha256')
    let fileBytes = 0
    try {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError')
        const chunk = Buffer.from(value)
        await handle.write(chunk)
        hash.update(chunk)
        fileBytes += chunk.length
        this.progressBytes += chunk.length
        this.reportProgress(this.buildStatus('downloading', this.progressBytes))
      }
    } finally {
      await handle.close()
    }

    const digest = hash.digest('hex')
    if (fileBytes !== file.size || digest !== file.sha256) {
      await rm(partial, { force: true })
      throw new Error(`模型文件校验失败：${file.name}`)
    }
    await rm(target, { force: true })
    await rename(partial, target)
  }

  private async isVerified(): Promise<boolean> {
    try {
      const manifest = JSON.parse(
        await readFile(join(this.modelRoot, 'verified.json'), 'utf8')
      ) as VerifiedManifest
      if (
        manifest.modelId !== this.modelId ||
        manifest.version !== this.version ||
        manifest.fingerprint !== this.fingerprint
      ) {
        return false
      }
      for (const file of SENSEVOICE_MODEL_FILES) {
        const info = await stat(join(this.modelRoot, file.name))
        if (info.size !== file.size || manifest.files[file.name]?.sha256 !== file.sha256)
          return false
      }
      return true
    } catch {
      return this.verifyExistingFiles()
    }
  }

  private async verifyExistingFiles(): Promise<boolean> {
    try {
      for (const file of SENSEVOICE_MODEL_FILES) {
        const path = join(this.modelRoot, file.name)
        const info = await stat(path)
        if (info.size !== file.size || (await this.hashFile(path)) !== file.sha256) return false
      }
      await this.writeVerifiedManifest()
      return true
    } catch {
      return false
    }
  }

  private async hasAnyModelFile(): Promise<boolean> {
    for (const file of SENSEVOICE_MODEL_FILES) {
      try {
        await stat(join(this.modelRoot, file.name))
        return true
      } catch {
        // Continue checking the remaining model files.
      }
    }
    return false
  }

  private hashFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(path)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  private async writeVerifiedManifest(): Promise<void> {
    const manifest: VerifiedManifest = {
      modelId: this.modelId,
      version: this.version,
      fingerprint: this.fingerprint,
      files: Object.fromEntries(
        SENSEVOICE_MODEL_FILES.map((file) => [file.name, { size: file.size, sha256: file.sha256 }])
      )
    }
    const temporary = join(this.modelRoot, 'verified.json.partial')
    const target = join(this.modelRoot, 'verified.json')
    await writeFile(temporary, JSON.stringify(manifest, null, 2), 'utf8')
    await rm(target, { force: true })
    await rename(temporary, target)
  }

  private buildStatus(
    state: VoiceModelStatus['state'],
    downloadedBytes: number,
    error?: string
  ): VoiceModelStatus {
    return {
      modelId: this.modelId,
      version: this.version,
      state,
      downloadedBytes,
      totalBytes: TOTAL_BYTES,
      progress: TOTAL_BYTES ? Math.min(1, downloadedBytes / TOTAL_BYTES) : 0,
      platform: process.platform,
      architecture: process.arch,
      supported: this.isRuntimeSupported(),
      error
    }
  }

  private isRuntimeSupported(): boolean {
    return (
      (process.platform === 'win32' && process.arch === 'x64') ||
      (process.platform === 'darwin' && (process.arch === 'x64' || process.arch === 'arm64'))
    )
  }

  private reportProgress(status: VoiceModelStatus, force = false): void {
    const now = Date.now()
    if (!force && now - this.lastProgressAt < 100) return
    this.lastProgressAt = now
    this.progressListener?.(status)
  }
}
