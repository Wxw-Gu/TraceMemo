/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const defaultRuntimeRoot = path.join(projectRoot, 'node_modules', 'sherpa-onnx-win-x64')
const requiredFiles = ['package.json', 'sherpa-onnx.node']

function hasWindowsSherpaRuntime(runtimeRoot = defaultRuntimeRoot) {
  return requiredFiles.every((fileName) => fs.existsSync(path.join(runtimeRoot, fileName)))
}

function ensureWindowsSherpaRuntime() {
  if (hasWindowsSherpaRuntime()) {
    console.log('[prepare-win-runtime] sherpa-onnx-win-x64 is ready')
    return
  }

  console.log('[prepare-win-runtime] installing cross-platform optional dependencies')
  execFileSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['install', '--force', '--ignore-scripts'],
    {
      cwd: projectRoot,
      stdio: 'inherit'
    }
  )

  if (!hasWindowsSherpaRuntime()) {
    throw new Error(`Missing Windows sherpa runtime: ${defaultRuntimeRoot}`)
  }
}

if (require.main === module) ensureWindowsSherpaRuntime()

module.exports = { hasWindowsSherpaRuntime, ensureWindowsSherpaRuntime }
