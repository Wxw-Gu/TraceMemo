import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import ffmpegStaticPath from 'ffmpeg-static'

export function resolveBundledFfmpegPath(): string {
  if (process.platform === 'darwin' && app.isPackaged) {
    const editionFfmpeg = path.join(process.resourcesPath, 'resources', 'ffmpeg', 'ffmpeg')
    if (fs.existsSync(editionFfmpeg)) return editionFfmpeg
  }
  return String(ffmpegStaticPath || '').replace('app.asar', 'app.asar.unpacked').trim()
}
