/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

/**
 * electron@43 的 npm 包不再声明 postinstall（它自己的 package.json 里 scripts 是空的），
 * 下载被改成「首次 require('electron') 时的懒加载」。后果是 `pnpm install` 之后
 * node_modules/electron 里只有一个空壳：dist/ 与 path.txt 都不在，而
 * package.json 里的 pnpm.onlyBuiltDependencies: ["electron"] 对着空气发号施令 ——
 * 上游没有脚本可跑，pnpm 自然什么也不做。新 clone 于是直到 `pnpm dev` 才炸。
 * 这里显式补上下载，并把它挂在 postinstall / predev 上。
 */
const MIRROR_FALLBACK = 'https://npmmirror.com/mirrors/electron/'
const projectRoot = path.resolve(__dirname, '..')

function resolveElectronPackageRoot() {
  try {
    return path.dirname(require.resolve('electron/package.json'))
  } catch {
    return ''
  }
}

/**
 * .npmrc 的 electron_mirror 只有在 npm/pnpm 执行脚本时才会变成 npm_config_* 环境变量；
 * 直接 `node node_modules/electron/install.js` 时读不到，于是会绕开镜像去打 GitHub。
 * 这里显式读出来当 ELECTRON_MIRROR 传下去。显式设置的环境变量优先。
 */
function resolveMirror() {
  if (process.env.ELECTRON_MIRROR) return process.env.ELECTRON_MIRROR
  try {
    const npmrc = fs.readFileSync(path.join(projectRoot, '.npmrc'), 'utf8')
    const match = npmrc.match(/^\s*electron_mirror\s*=\s*(\S+)\s*$/m)
    return match ? match[1] : ''
  } catch {
    return ''
  }
}

/**
 * path.txt 只是 electron 写下的相对路径，光有它不算装好 —— 指向的可执行文件
 * 必须真的存在，否则仍会在启动时报「Electron failed to install correctly」。
 */
function isElectronBinaryInstalled(packageRoot) {
  if (!packageRoot) return false
  try {
    const executable = fs.readFileSync(path.join(packageRoot, 'path.txt'), 'utf8').trim()
    return executable !== '' && fs.existsSync(path.join(packageRoot, 'dist', executable))
  } catch {
    return false
  }
}

function runInstaller(packageRoot) {
  const installer = path.join(packageRoot, 'install.js')
  if (!fs.existsSync(installer)) {
    throw new Error(`[ensure-electron] missing ${installer}; run pnpm install first`)
  }
  const mirror = resolveMirror()
  const attempts = mirror
    ? [{ label: mirror, env: { ELECTRON_MIRROR: mirror } }]
    : [{ label: 'default source', env: {} }]
  // 配的镜像本身不是 npmmirror 时，再兜一层：镜像挂掉时不至于完全没退路。
  if (!mirror.includes('npmmirror.com')) {
    attempts.push({ label: MIRROR_FALLBACK, env: { ELECTRON_MIRROR: MIRROR_FALLBACK } })
  }
  let lastError
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]
    console.log(`[ensure-electron] downloading from ${attempt.label}`)
    try {
      execFileSync(process.execPath, [installer], {
        stdio: 'inherit',
        env: { ...process.env, ...attempt.env }
      })
      return
    } catch (error) {
      lastError = error
      const next = attempts[index + 1]
      if (next) {
        console.warn(`[ensure-electron] download failed, retrying from ${next.label}`)
      }
    }
  }
  throw lastError
}

function ensureElectronBinary() {
  const packageRoot = resolveElectronPackageRoot()
  if (isElectronBinaryInstalled(packageRoot)) return false
  console.log('[ensure-electron] Electron binary is missing; downloading it now')
  runInstaller(packageRoot)
  if (!isElectronBinaryInstalled(packageRoot)) {
    throw new Error('[ensure-electron] Electron binary is still missing after installing')
  }
  console.log('[ensure-electron] Electron binary is ready')
  return true
}

if (require.main === module) ensureElectronBinary()

module.exports = { ensureElectronBinary, isElectronBinaryInstalled, resolveElectronPackageRoot }
