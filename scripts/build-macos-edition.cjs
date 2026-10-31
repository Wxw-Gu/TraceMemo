const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { assertStagingTargetDoesNotExist, prepareEdition, validateStagedEdition } = require('./prepare-macos-edition.cjs')

const ROOT = path.resolve(__dirname, '..')
const STAGE_ROOT = path.join(ROOT, 'build', 'mac-staging')
const OUTPUT_ROOT = path.join(ROOT, 'dist', 'mac')
const EDITIONS = ['public', 'native']
const CONFIG_ROOT = path.join(STAGE_ROOT, 'configs')
const YAML = require('yaml')

function run(args, env) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${args.join(' ')}`)
}

function createBuilderConfig({ edition, stageRoot, buildOutput, outputRoot, appVersion }) {
  return {
    appId: 'com.tracememo.app',
    productName: 'TraceMemo',
    afterPack: path.join(ROOT, 'scripts/after-pack.cjs'),
    directories: {
      buildResources: path.join(ROOT, 'build'),
      output: outputRoot
    },
    files: [
      { from: buildOutput, to: 'out', filter: ['**/*'] },
      'package.json',
      '!resources/**',
      '!1.txt',
      '!**/1.txt',
      '!**/*.db',
      '!**/*.sqlite*',
      '!**/*.log',
      '!**/runtime.zip',
      '!.' + 'ai-local/**',
      '!.' + 'workbuddy/**',
      '!tests/**',
      '!AGENTS.md',
      '!**/.vscode/*',
      '!src/*',
      '!electron.vite.config.{js,ts,mjs,cjs}',
      '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}',
      '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
      '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}'
    ],
    extraMetadata: { main: 'out/main/index.js' },
    asarUnpack: [
      'resources/**',
      'node_modules/ffmpeg-static/**',
      'node_modules/silk-wasm/**',
      'node_modules/sherpa-onnx-node/**',
      'node_modules/sherpa-onnx-*/**',
      'node_modules/@napi-rs/system-ocr/**',
      'node_modules/@napi-rs/system-ocr-*/**'
    ],
    extraResources: [
      { from: path.join(stageRoot, 'resources'), to: 'resources', filter: ['**/*'] },
      { from: path.join(ROOT, 'build/app-update.yml'), to: 'app-update.yml' },
      {
        from: path.join(ROOT, 'docs/skill/tracememo-reader'),
        to: 'skill/tracememo-reader',
        filter: ['**/*']
      }
    ],
    mac: {
      icon: path.join(ROOT, 'build/icon.icns'),
      target: ['dmg'],
      entitlementsInherit: path.join(ROOT, 'build/entitlements.mac.plist'),
      extendInfo: {
        CFBundleDisplayName: 'TraceMemo',
        NSCameraUsageDescription: 'Application requests access to the device camera.',
        NSMicrophoneUsageDescription: 'Application requests access to the device microphone.',
        NSDocumentsFolderUsageDescription: 'Application requests access to the user documents folder.',
        NSDownloadsFolderUsageDescription: 'Application requests access to the user downloads folder.'
      },
      notarize: false
    },
    dmg: {
      artifactName:
        edition === 'native'
          ? `TraceMemo-${appVersion}-mac-arm64-native.dmg`
          : `TraceMemo-${appVersion}-mac-arm64-public.dmg`
    },
    npmRebuild: false
  }
}

function buildEdition(edition, options = {}) {
  if (!EDITIONS.includes(edition)) throw new Error('Usage: build-macos-edition.cjs <public|native>')
  const stageRoot = path.join(STAGE_ROOT, edition)
  const outputRoot = path.join(OUTPUT_ROOT, edition)
  if (fs.existsSync(stageRoot) && !options.reuseStaging) {
    throw new Error(`Refusing to overwrite existing build staging: ${stageRoot}`)
  }
  if (fs.existsSync(outputRoot)) throw new Error(`Refusing to overwrite existing build output: ${outputRoot}`)
  if (fs.existsSync(CONFIG_ROOT)) throw new Error(`Refusing to overwrite existing build config directory: ${CONFIG_ROOT}`)
  const preparation = fs.existsSync(stageRoot)
    ? Promise.resolve(validateStagedEdition(edition))
    : prepareEdition(edition)
  if (!preparation || typeof preparation.then !== 'function') throw new Error('Edition staging preparation did not return a Promise')
  return preparation.then(() => {
    const buildOutput = path.join(stageRoot, 'out')
    const configPath = path.join(CONFIG_ROOT, `electron-builder-${edition}.yml`)
    let ownsConfigRoot = false
    let buildSucceeded = false
    try {
      const markerPath = path.join(stageRoot, 'resources', 'tracememo-build.json')
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
      const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      if (marker.profile !== edition || marker.appVersion !== packageJson.version) {
        throw new Error('Staged edition marker does not match the current package metadata')
      }
      validateStagedEdition(edition)
      const env = { ...process.env, TRACEMEMO_EDITION: edition, TRACEMEMO_RUNTIME_PROFILE: edition }
      env.TRACEMEMO_EDITION_OUT_DIR = path.relative(ROOT, buildOutput)
      run(
        [
          path.join(ROOT, 'node_modules/electron-vite/bin/electron-vite.js'),
          'build',
          '--outDir',
          path.relative(ROOT, buildOutput)
        ],
        env
      )
      fs.mkdirSync(CONFIG_ROOT)
      ownsConfigRoot = true
      const config = createBuilderConfig({
        edition,
        stageRoot,
        buildOutput,
        outputRoot,
        appVersion: packageJson.version
      })
      fs.writeFileSync(configPath, YAML.stringify(config), { flag: 'wx' })
      run(
        [
          path.join(ROOT, 'node_modules/electron-builder/cli.js'),
          '--config',
          path.relative(ROOT, configPath),
          '--mac',
          '--arm64'
        ],
        env
      )
      buildSucceeded = true
    } finally {
      if (ownsConfigRoot) fs.rmSync(CONFIG_ROOT, { recursive: true, force: true })
      if (!buildSucceeded && fs.existsSync(outputRoot)) {
        fs.rmSync(outputRoot, { recursive: true, force: true })
      }
    }
  })
}

if (require.main === module) {
  try {
    Promise.resolve(buildEdition(process.argv[2], { reuseStaging: process.argv[3] === '--reuse-staging' })).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = { buildEdition, createBuilderConfig }
