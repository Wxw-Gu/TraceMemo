import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { Wcdb4Client } from './wcdb4-client'
import { isPackagedRuntime } from './runtime-mode'

const nodeRequire = createRequire(import.meta.url)

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

export class VoiceService {
  private wcdb4Client: Wcdb4Client
  private voiceCache = new Map<string, string>()

  constructor(wcdb4Client: Wcdb4Client) {
    this.wcdb4Client = wcdb4Client
  }

  async resolveVoice(
    sessionId: string,
    localId: number,
    createTime: number,
    svrId?: string | number
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    const cacheKey = this.buildCacheKey(sessionId, localId, createTime)

    const cached = this.voiceCache.get(cacheKey)
    if (cached) {
      console.log('[VoiceService] cache hit for', cacheKey)
      return { success: true, data: cached }
    }

    const candidates = this.buildCandidates(sessionId)
    console.log('[VoiceService] resolving voice:', { sessionId, localId, createTime, candidates })

    const voiceResult = await this.wcdb4Client.getVoiceData(
      sessionId,
      createTime,
      candidates,
      localId,
      svrId || 0
    )

    if (!voiceResult.success || !voiceResult.hex) {
      console.log('[VoiceService] getVoiceData failed:', voiceResult.error)
      return { success: false, error: voiceResult.error || '获取语音数据失败' }
    }

    console.log('[VoiceService] got hex data, length:', voiceResult.hex.length)

    const silkData = this.decodeVoiceBlob(voiceResult.hex)
    if (!silkData || silkData.length === 0) {
      console.log('[VoiceService] decodeVoiceBlob failed, hex:', voiceResult.hex.substring(0, 100))
      return { success: false, error: '语音数据为空' }
    }

    console.log('[VoiceService] silkData length:', silkData.length)

    const pcmData = await this.decodeSilkToPcm(silkData, 24000)
    if (!pcmData || pcmData.length === 0) {
      console.log('[VoiceService] decodeSilkToPcm failed')
      return { success: false, error: 'Silk 解码失败' }
    }

    console.log('[VoiceService] pcmData length:', pcmData.length)

    const wavData = this.createWavBuffer(pcmData, 24000)
    console.log(
      '[VoiceService] wavData length:',
      wavData.length,
      'base64 length:',
      wavData.toString('base64').length
    )

    const base64Data = wavData.toString('base64')

    this.voiceCache.set(cacheKey, base64Data)

    return { success: true, data: base64Data }
  }

  private buildCacheKey(sessionId: string, localId: number, createTime: number): string {
    return `${sessionId}-${localId}-${createTime}`
  }

  private buildCandidates(sessionId: string): string[] {
    const candidates: string[] = [sessionId]
    if (sessionId.endsWith('@chatroom')) {
      candidates.push(sessionId.replace('@chatroom', ''))
    }
    return candidates
  }

  private decodeVoiceBlob(hex: string): Buffer | null {
    try {
      const hexClean = hex.replace(/\s+/g, '')
      if (!/^[0-9a-fA-F]+$/.test(hexClean)) {
        return null
      }
      return Buffer.from(hexClean, 'hex')
    } catch {
      return null
    }
  }

  private async decodeSilkToPcm(silkData: Buffer, sampleRate: number): Promise<Buffer | null> {
    try {
      const locations = getSilkWasmRuntimeLocations()
      const runtime = findSilkWasmRuntimeLocation(locations)
      if (!runtime) {
        console.error(
          '[VoiceService] silk.wasm not found. checked:',
          locations.map((location) => location.wasmPath)
        )
        return null
      }

      const silkWasm = nodeRequire(runtime.packagePath)
      if (!silkWasm || !silkWasm.decode) {
        console.error('[VoiceService] silk-wasm module invalid:', runtime.packagePath)
        return null
      }

      console.log('[VoiceService] using silk-wasm runtime:', runtime.source)
      const result = await silkWasm.decode(silkData, sampleRate)
      return Buffer.from(result.data)
    } catch (e) {
      console.error('[VoiceService] decodeSilkToPcm error:', e)
      return null
    }
  }

  private createWavBuffer(
    pcmData: Buffer,
    sampleRate: number = 24000,
    channels: number = 1
  ): Buffer {
    const pcmLength = pcmData.length
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcmLength, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * channels * 2, 28)
    header.writeUInt16LE(channels * 2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcmLength, 40)
    return Buffer.concat([header, pcmData])
  }
}
