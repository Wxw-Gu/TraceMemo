import { execFileSync } from 'node:child_process'
import { app } from 'electron'
import { buildMacArchSnapshot, type MacArchSnapshot, type MacHardwareArch } from '../shared/macos-arch'

let cachedSnapshot: MacArchSnapshot | null = null

/**
 * `hw.optional.arm64` 是唯一可靠的硬件判据：它在 ARM 上恒为 1，
 * 在 Intel 上不存在或为 0，且与进程是否被翻译无关。
 *
 * 读不到时返回 `unknown`，由上层保留兼容路径 —— 不能猜测硬件，
 * 猜错会让真正的 Intel Mac 被误拦。
 */
function readHardwareArch(): MacHardwareArch {
  try {
    const stdout = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const value = stdout.trim()
    if (value === '1') return 'arm64'
    if (value === '0') return 'x64'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

function readTranslationFlag(platform: NodeJS.Platform): boolean {
  if (platform !== 'darwin') return false
  try {
    return app.runningUnderARM64Translation === true
  } catch {
    return false
  }
}

/**
 * 取当前进程的架构快照。
 *
 * 结果缓存一次：调用方包括每次刷新连接页都会走的 `key:getEnvironment`，
 * 缓存后 sysctl 只在首次执行，避免刷 UI 反复起子进程。
 */
export function getMacArchSnapshot(): MacArchSnapshot {
  if (cachedSnapshot) return cachedSnapshot
  const platform = process.platform
  cachedSnapshot = buildMacArchSnapshot({
    platform,
    hardwareArch: platform === 'darwin' ? readHardwareArch() : 'unknown',
    runtimeArch: process.arch,
    underARM64Translation: readTranslationFlag(platform)
  })
  return cachedSnapshot
}

/** 仅供测试重置缓存；运行期不调用。 */
export function resetMacArchSnapshotCache(): void {
  cachedSnapshot = null
}
