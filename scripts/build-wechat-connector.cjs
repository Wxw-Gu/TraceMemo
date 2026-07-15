/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const sourceDir = process.env.WECHAT_CONNECTOR_SOURCE
  ? path.resolve(process.env.WECHAT_CONNECTOR_SOURCE)
  : path.join(projectRoot, 'services', 'wechat-connector')
const outputRoot = path.join(projectRoot, 'resources', 'connectors', 'wechat')

function normalizePlatform(value) {
  if (value === 'win32' || value === 'windows') return 'windows'
  if (value === 'darwin' || value === 'macos') return 'darwin'
  if (value === 'linux') return 'linux'
  throw new Error(`Unsupported connector platform: ${value}`)
}

function normalizeArch(value) {
  if (value === 'x64' || value === 'amd64') return 'amd64'
  if (value === 'arm64') return 'arm64'
  throw new Error(`Unsupported connector architecture: ${value}`)
}

function parseTargets() {
  const platformArg = process.argv.indexOf('--platform')
  const archArg = process.argv.indexOf('--arch')
  const platforms = platformArg >= 0 ? process.argv[platformArg + 1].split(',') : [process.platform]
  const arches = archArg >= 0 ? process.argv[archArg + 1].split(',') : [process.arch]
  return platforms.flatMap((platform) =>
    arches.map((arch) => ({ goos: normalizePlatform(platform), goarch: normalizeArch(arch) }))
  )
}

if (!fs.existsSync(path.join(sourceDir, 'go.mod'))) {
  const existingTargets = parseTargets().every((target) => {
    const directoryName = `${target.goos === 'windows' ? 'win32' : target.goos}-${target.goarch === 'amd64' ? 'x64' : target.goarch}`
    const executable = target.goos === 'windows' ? 'wechat-connector.exe' : 'wechat-connector'
    return fs.existsSync(path.join(outputRoot, directoryName, executable))
  })
  if (existingTargets) {
    console.log('[build-wechat-connector] source not configured; reusing existing binary')
    process.exit(0)
  }
  throw new Error(
    'Wechat connector source is not included in this repository. Set WECHAT_CONNECTOR_SOURCE to a compatible connector checkout.'
  )
}

fs.rmSync(outputRoot, { recursive: true, force: true })

for (const target of parseTargets()) {
  const directoryName = `${target.goos === 'windows' ? 'win32' : target.goos}-${target.goarch === 'amd64' ? 'x64' : target.goarch}`
  const outputDir = path.join(outputRoot, directoryName)
  const outputPath = path.join(
    outputDir,
    target.goos === 'windows' ? 'wechat-connector.exe' : 'wechat-connector'
  )
  fs.mkdirSync(outputDir, { recursive: true })
  execFileSync('go', ['build', '-trimpath', '-o', outputPath, '.'], {
    cwd: sourceDir,
    env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' },
    stdio: 'inherit'
  })
  if (target.goos !== 'windows') fs.chmodSync(outputPath, 0o755)
  console.log(`[build-wechat-connector] built ${directoryName}: ${outputPath}`)
}
