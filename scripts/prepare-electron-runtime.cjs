const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { readBinaryArchitectures } = require('./binary-arch.cjs')

const runtimeNames = ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']

function copyIfDifferent(sourcePath, targetPath) {
  const source = fs.statSync(sourcePath)
  const targetExists = fs.existsSync(targetPath)

  if (targetExists) {
    const target = fs.statSync(targetPath)
    if (target.size === source.size && target.mtimeMs >= source.mtimeMs) {
      return false
    }
  }

  fs.copyFileSync(sourcePath, targetPath)
  return true
}

function readOption(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function ffmpegExecutableName(targetPlatform) {
  return targetPlatform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

/**
 * ffmpeg-static keeps a single binary per platform ("ffmpeg" everywhere except
 * Windows), so an arm64 and an x64 macOS checkout cannot coexist in
 * node_modules. Its installer also exits early whenever the file already
 * exists, so a binary left over from the other architecture would be packed
 * silently. Check the real architecture and drop the file when it differs, so
 * the caller re-downloads the requested one.
 */
function ensureFfmpegArchitecture(ffmpegPath, targetPlatform, targetArch) {
  if (!fs.existsSync(ffmpegPath)) return 'missing'
  const architectures = readBinaryArchitectures(ffmpegPath)
  if (architectures.includes(targetArch)) return 'match'
  console.log(
    `[prepare-electron-runtime] ffmpeg-static is ${
      architectures.join('/') || 'not a native binary'
    } but ${targetPlatform}-${targetArch} was requested; replacing it`
  )
  fs.rmSync(ffmpegPath, { force: true })
  return 'replaced'
}

function prepareFfmpegRuntime(targetPlatform = process.platform, targetArch = process.arch) {
  let packageRoot = ''
  try {
    packageRoot = path.dirname(require.resolve('ffmpeg-static/package.json'))
  } catch {
    return
  }
  const executable = ffmpegExecutableName(targetPlatform)
  const ffmpegPath = path.join(packageRoot, executable)
  const architectureState = ensureFfmpegArchitecture(ffmpegPath, targetPlatform, targetArch)

  if (architectureState !== 'match') {
    const installScript = path.join(packageRoot, 'install.js')
    console.log(
      `[prepare-electron-runtime] downloading ffmpeg-static for ${targetPlatform}-${targetArch}`
    )
    execFileSync(process.execPath, [installScript], {
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_platform: targetPlatform,
        npm_config_arch: targetArch
      }
    })
  }

  if (!fs.existsSync(ffmpegPath)) {
    throw new Error(`ffmpeg-static runtime download failed: ${ffmpegPath}`)
  }
  if (targetPlatform === 'win32') return

  fs.chmodSync(ffmpegPath, 0o755)
  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', ffmpegPath], { stdio: 'ignore' })
  }
}

function main() {
  prepareFfmpegRuntime(readOption('platform', process.platform), readOption('arch', process.arch))
  if (process.platform !== 'win32') return

  const projectRoot = path.resolve(__dirname, '..')
  const sourceDir = path.join(projectRoot, 'resources', 'runtime', 'win32')
  const targetDir = path.join(projectRoot, 'node_modules', 'electron', 'dist')

  if (!fs.existsSync(sourceDir) || !fs.existsSync(targetDir)) return

  let copiedCount = 0
  for (const name of runtimeNames) {
    const sourcePath = path.join(sourceDir, name)
    const targetPath = path.join(targetDir, name)
    if (!fs.existsSync(sourcePath)) continue
    if (copyIfDifferent(sourcePath, targetPath)) copiedCount += 1
  }

  if (copiedCount > 0) {
    console.log(`[prepare-electron-runtime] synced ${copiedCount} runtime DLL(s) to ${targetDir}`)
  }
}

if (require.main === module) main()

module.exports = { ensureFfmpegArchitecture, ffmpegExecutableName, prepareFfmpegRuntime }
