import { app } from 'electron'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { isPackagedRuntime } from '../runtime-mode'

const nodeRequire = createRequire(import.meta.url)

export interface EncodedVoiceSource {
  data: Buffer
  codec: string
  sourceHash: string
}

export interface DecodedVoiceAudio {
  pcm: Buffer
  sampleRate: number
  channels: number
  sourceHash: string
}

export interface VoiceAudioDecoder {
  readonly codec: string
  decode(source: EncodedVoiceSource): Promise<DecodedVoiceAudio>
}

export interface EncodedSilkAudio {
  data: Buffer
  durationMs: number
}

export type SilkWasmRuntimeLocation = {
  packagePath: string
  wasmPath: string
  source: 'unpacked' | 'resources' | 'asar' | 'development'
}

export function getSilkWasmRuntimeLocations(options?: {
  packaged?: boolean
  resourcesPath?: string
  appPath?: string
}): SilkWasmRuntimeLocation[] {
  const packaged = options?.packaged ?? isPackagedRuntime()
  const resourcesPath = options?.resourcesPath ?? process.resourcesPath
  const appPath = options?.appPath ?? app.getAppPath()
  const location = (
    packagePath: string,
    source: SilkWasmRuntimeLocation['source']
  ): SilkWasmRuntimeLocation => ({
    packagePath,
    wasmPath: join(packagePath, 'lib', 'silk.wasm'),
    source
  })

  if (!packaged) {
    return [location(join(appPath, 'node_modules', 'silk-wasm'), 'development')]
  }
  return [
    location(join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'silk-wasm'), 'unpacked'),
    location(join(resourcesPath, 'node_modules', 'silk-wasm'), 'resources'),
    location(join(appPath, 'node_modules', 'silk-wasm'), 'asar')
  ]
}

export function findSilkWasmRuntimeLocation(
  locations: SilkWasmRuntimeLocation[]
): SilkWasmRuntimeLocation | null {
  return locations.find((location) => existsSync(location.wasmPath)) || null
}

export class SilkAudioDecoder implements VoiceAudioDecoder {
  readonly codec = 'silk'

  async decode(source: EncodedVoiceSource): Promise<DecodedVoiceAudio> {
    const locations = getSilkWasmRuntimeLocations()
    const runtime = findSilkWasmRuntimeLocation(locations)
    if (!runtime) throw new Error('silk.wasm 未找到')
    const silkWasm = nodeRequire(runtime.packagePath) as {
      decode?: (data: Buffer, sampleRate: number) => Promise<{ data: Uint8Array }>
    }
    if (!silkWasm.decode) throw new Error('silk-wasm 运行时无效')
    const result = await silkWasm.decode(source.data, 16000)
    const pcm = Buffer.from(result.data)
    if (!pcm.length) throw new Error('Silk 解码结果为空')
    return {
      pcm,
      sampleRate: 16000,
      channels: 1,
      sourceHash: source.sourceHash
    }
  }
}

export class SilkAudioEncoder {
  async encode(pcm: Buffer, sampleRate: number): Promise<EncodedSilkAudio> {
    const locations = getSilkWasmRuntimeLocations()
    const runtime = findSilkWasmRuntimeLocation(locations)
    if (!runtime) throw new Error('silk.wasm 未找到')
    const silkWasm = nodeRequire(runtime.packagePath) as {
      encode?: (
        data: Buffer,
        sampleRate: number
      ) => Promise<{ data: Uint8Array; duration?: number }>
    }
    if (!silkWasm.encode) throw new Error('silk-wasm 运行时无效')
    const result = await silkWasm.encode(pcm, sampleRate)
    return { data: Buffer.from(result.data), durationMs: Math.round(Number(result.duration) || 0) }
  }
}

export class AudioDecoderRegistry {
  private readonly decoders = new Map<string, VoiceAudioDecoder>()

  register(decoder: VoiceAudioDecoder): this {
    if (this.decoders.has(decoder.codec))
      throw new Error(`Decoder already registered: ${decoder.codec}`)
    this.decoders.set(decoder.codec, decoder)
    return this
  }

  decode(source: EncodedVoiceSource): Promise<DecodedVoiceAudio> {
    const decoder = this.decoders.get(source.codec)
    if (!decoder) throw new Error(`Unsupported voice codec: ${source.codec}`)
    return decoder.decode(source)
  }
}

export function createDefaultAudioDecoderRegistry(): AudioDecoderRegistry {
  return new AudioDecoderRegistry()
    .register(new SilkAudioDecoder())
    .register(new AmrAudioDecoder())
}

/**
 * V3 AMR：外部 `ffmpeg` 解码为 PCM（MultiMediaDyn `CAMRDecoder` 未导出）。
 */
export class AmrAudioDecoder implements VoiceAudioDecoder {
  readonly codec = 'amr'

  async decode(source: EncodedVoiceSource): Promise<DecodedVoiceAudio> {
    const { spawn } = await import('child_process')
    const { tmpdir } = await import('os')
    const { promises: fs } = await import('fs')
    const { randomBytes } = await import('crypto')
    const stamp = randomBytes(8).toString('hex')
    const inPath = join(tmpdir(), `tracememo-amr-in-${stamp}.amr`)
    const outPath = join(tmpdir(), `tracememo-amr-out-${stamp}.wav`)
    await fs.writeFile(inPath, source.data)
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'ffmpeg',
          ['-y', '-i', inPath, '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '8000', '-ac', '1', outPath],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        )
        let err = ''
        child.stderr.on('data', (chunk) => {
          err += String(chunk)
        })
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`ffmpeg amr decode failed: ${err.slice(-200)}`))
        })
      })
      const wav = await fs.readFile(outPath)
      const pcm = wav.length > 44 && wav.toString('ascii', 0, 4) === 'RIFF' ? wav.subarray(44) : wav
      return {
        pcm,
        sampleRate: 8000,
        channels: 1,
        sourceHash: source.sourceHash
      }
    } finally {
      await fs.rm(inPath, { force: true })
      await fs.rm(outPath, { force: true })
    }
  }
}
