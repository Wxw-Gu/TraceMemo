import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ffmpegStaticPath from 'ffmpeg-static'

export type WxgfDecodeResult = {
  buffer: Buffer
  extension: '.jpg' | '.gif'
}

type Partition = { offset: number; size: number; ratio: number }

const WXGF_MAGIC = Buffer.from('wxgf')
const MAX_FFMPEG_BUFFER = 64 * 1024 * 1024

const resolveFfmpegPath = (): string | null => {
  const configured = String(process.env['FFMPEG_PATH'] || '').trim()
  if (configured && fs.existsSync(configured)) return configured

  const bundled = ffmpegStaticPath?.replace('app.asar', 'app.asar.unpacked')
  if (bundled && fs.existsSync(bundled)) return bundled
  return null
}

const findPartitions = (data: Buffer): Partition[] => {
  if (data.length < 15 || !data.subarray(0, 4).equals(WXGF_MAGIC)) return []
  const headerLength = data[4]
  if (headerLength < 5 || headerLength >= data.length) return []

  for (const pattern of [Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 1])]) {
    const partitions: Partition[] = []
    let searchOffset = headerLength
    while (searchOffset < data.length) {
      const relativeIndex = data.subarray(searchOffset).indexOf(pattern)
      if (relativeIndex < 0) break
      const offset = searchOffset + relativeIndex
      if (offset < 4) {
        searchOffset = offset + 1
        continue
      }

      const size = data.readUInt32BE(offset - 4)
      if (size === 0 || offset + size > data.length) {
        searchOffset = offset + 1
        continue
      }
      partitions.push({ offset, size, ratio: size / data.length })
      searchOffset = offset + size
    }
    if (partitions.length > 0) return partitions
  }
  return []
}

const runFfmpeg = (args: string[], input?: Buffer): Buffer | null => {
  const ffmpegPath = resolveFfmpegPath()
  if (!ffmpegPath) return null
  const result = spawnSync(ffmpegPath, args, {
    input,
    timeout: 30_000,
    maxBuffer: MAX_FFMPEG_BUFFER,
    windowsHide: true
  })
  if (result.status !== 0 || !result.stdout?.length) return null
  return result.stdout
}

const decodeStill = (stream: Buffer): WxgfDecodeResult | null => {
  const output = runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'hevc',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-c:v',
      'mjpeg',
      '-q:v',
      '2',
      '-f',
      'image2pipe',
      'pipe:1'
    ],
    stream
  )
  return output?.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    ? { buffer: output, extension: '.jpg' }
    : null
}

const decodeAnimation = (
  animationFrames: Buffer[],
  maskFrames: Buffer[]
): WxgfDecodeResult | null => {
  if (animationFrames.length === 0 || animationFrames.length !== maskFrames.length) return null
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechatexplorer-wxgf-'))
  const animationPath = path.join(tempDir, 'animation.hevc')
  const maskPath = path.join(tempDir, 'mask.hevc')
  try {
    fs.writeFileSync(animationPath, Buffer.concat(animationFrames))
    fs.writeFileSync(maskPath, Buffer.concat(maskFrames))
    const output = runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'hevc',
      '-i',
      animationPath,
      '-f',
      'hevc',
      '-i',
      maskPath,
      '-filter_complex',
      '[0:v][1:v]alphamerge,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
      '-loop',
      '0',
      '-f',
      'gif',
      'pipe:1'
    ])
    return output?.subarray(0, 3).toString('ascii') === 'GIF'
      ? { buffer: output, extension: '.gif' }
      : null
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export const decodeWxgf = (data: Buffer): WxgfDecodeResult | null => {
  const partitions = findPartitions(data)
  if (partitions.length === 0) return null

  const maxPartition = partitions.reduce((best, current) =>
    current.ratio > best.ratio ? current : best
  )
  if (partitions.length === 1 || maxPartition.ratio >= 0.6) {
    return decodeStill(data.subarray(maxPartition.offset, maxPartition.offset + maxPartition.size))
  }

  const maskFrames: Buffer[] = []
  const animationFrames: Buffer[] = []
  partitions.forEach((partition, index) => {
    const frame = data.subarray(partition.offset, partition.offset + partition.size)
    if (index % 2 === 0) maskFrames.push(frame)
    else animationFrames.push(frame)
  })
  return decodeAnimation(animationFrames, maskFrames) || decodeStill(animationFrames[0])
}
