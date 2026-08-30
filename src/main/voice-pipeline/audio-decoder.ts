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
  return new AudioDecoderRegistry().register(new SilkAudioDecoder())
}
