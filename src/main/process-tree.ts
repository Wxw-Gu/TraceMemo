import { spawn, type ChildProcess } from 'node:child_process'

const DEFAULT_TASKKILL_TIMEOUT_MS = 5_000
const DEFAULT_EXIT_TIMEOUT_MS = 2_000

/** 结束进程树的结果；Windows 上仅 taskkill 退出码为 0 时视为成功。 */
export type ProcessTreeKillResult = 'group' | 'taskkill' | 'fallback'

export interface TerminateChildProcessOptions {
  platform?: NodeJS.Platform
  signal?: NodeJS.Signals
  timeoutMs?: number
  killTree?: typeof killProcessTree
}

export async function killProcessTree(
  pid: number | undefined,
  options: { platform?: NodeJS.Platform; signal?: NodeJS.Signals; timeoutMs?: number } = {}
): Promise<ProcessTreeKillResult> {
  if (!pid) return 'fallback'
  const platform = options.platform ?? process.platform
  const signal = options.signal ?? 'SIGKILL'

  if (platform === 'win32') {
    return killWindowsProcessTree(pid, options.timeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS)
  }

  try {
    process.kill(-pid, signal)
    return 'group'
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // 进程已退出。
    }
    return 'fallback'
  }
}

function killWindowsProcessTree(
  pid: number,
  timeoutMs: number
): Promise<'taskkill' | 'fallback'> {
  return new Promise((resolve) => {
    let killer: ChildProcess
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      resolve('fallback')
      return
    }

    let settled = false
    const finish = (result: 'taskkill' | 'fallback'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      try {
        killer.kill()
      } catch {
        // 进程已退出。
      }
      finish('fallback')
    }, timeoutMs)

    killer.on('error', () => finish('fallback'))
    killer.on('exit', (code) => finish(code === 0 ? 'taskkill' : 'fallback'))
  })
}

export interface ExitObservableChild {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  once(event: 'exit', listener: (...args: unknown[]) => void): unknown
  removeListener(event: 'exit', listener: (...args: unknown[]) => void): unknown
}

export interface TerminatableChild extends ExitObservableChild {
  pid?: number
  killed: boolean
  kill(signal?: NodeJS.Signals | number): boolean
}

/** 等待子进程真实退出；仅发信号不等待会在 Windows 更新时残留文件锁与同名进程。 */
export function waitForChildExit(
  child: ExitObservableChild,
  timeoutMs = DEFAULT_EXIT_TIMEOUT_MS
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve) => {
    let settled = false
    const onExit = (): void => finish(true)
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
    child.once('exit', onExit)
  })
}

export async function terminateChildProcess(
  child: TerminatableChild,
  options: TerminateChildProcessOptions = {}
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true

  const timeoutMs = options.timeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS
  const exitPromise = waitForChildExit(child, timeoutMs)
  const runKillTree = options.killTree ?? killProcessTree

  let result: ProcessTreeKillResult = 'fallback'
  if (child.pid) {
    result = await runKillTree(child.pid, {
      platform: options.platform,
      signal: options.signal,
      timeoutMs
    })
  }

  if (result === 'fallback' && !child.killed) {
    try {
      child.kill(options.signal ?? 'SIGKILL')
    } catch {
      // 进程已退出。
    }
  }

  return exitPromise
}
