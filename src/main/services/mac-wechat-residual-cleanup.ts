import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import type { MacWechatResidualProcess } from '../../shared/personal-wechat-mac-runtime'

const execFileAsync = promisify(execFile)
type PidCommandRunner = (
  executable: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stdout: string }>

export interface MacWechatResidualCleanupDependencies {
  platform: NodeJS.Platform
  listWechatPids: () => Promise<number[]>
  listPortPids: () => Promise<number[]>
  processName: (pid: number) => Promise<string>
  processIdentity: (pid: number) => Promise<string>
  signal: (pid: number, signal: NodeJS.Signals) => void
  wait: (milliseconds: number) => Promise<void>
}

export async function readPids(
  executable: string,
  args: string[],
  run: PidCommandRunner = async (file, commandArgs, options) =>
    execFileAsync(file, commandArgs, options)
): Promise<number[]> {
  try {
    const { stdout } = await run(executable, args, { timeout: 4_000 })
    return stdout
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  } catch (error) {
    const result = error as { code?: unknown; status?: unknown }
    if (result.code === 'ENOENT' || result.code === 1 || result.status === 1) return []
    throw error
  }
}

const defaultDependencies: MacWechatResidualCleanupDependencies = {
  platform: process.platform,
  listWechatPids: async () => {
    const results = await Promise.all([
      readPids('/usr/bin/pgrep', ['-x', 'WeChat']),
      readPids('/usr/bin/pgrep', ['-x', 'Weixin'])
    ])
    return [...new Set(results.flat())]
  },
  listPortPids: () => readPids('/usr/sbin/lsof', ['-nP', '-t', '-iTCP:4290', '-sTCP:LISTEN']),
  processName: async (pid) => {
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
        timeout: 2_000
      })
      return stdout.trim().split('/').pop() || 'unknown'
    } catch {
      return 'unknown'
    }
  },
  processIdentity: async (pid) => {
    try {
      const { stdout } = await execFileAsync(
        '/bin/ps',
        ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='],
        { timeout: 2_000 }
      )
      return createHash('sha256').update(stdout.trim()).digest('hex')
    } catch {
      return ''
    }
  },
  signal: (pid, signal) => process.kill(pid, signal),
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}

interface ObservedTarget extends MacWechatResidualProcess {
  confirmationToken: string
}

function mergeTargets(
  wechatPids: number[],
  portPids: number[],
  processNames: Map<number, string>,
  processIdentities: Map<number, string>
): ObservedTarget[] {
  const targets = new Map<number, Set<'wechat' | 'port_4290'>>()
  for (const pid of wechatPids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const reasons = targets.get(pid) || new Set<'wechat' | 'port_4290'>()
    reasons.add('wechat')
    targets.set(pid, reasons)
  }
  for (const pid of portPids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const reasons = targets.get(pid) || new Set<'wechat' | 'port_4290'>()
    reasons.add('port_4290')
    targets.set(pid, reasons)
  }
  return [...targets.entries()]
    .sort(([first], [second]) => first - second)
    .map(([pid, reasons]) => ({
      pid,
      name: processNames.get(pid) || 'unknown',
      targets: [...reasons].sort(),
      confirmationToken: processIdentities.get(pid) || ''
    }))
}

async function inspectObservedTargets(
  dependencies: MacWechatResidualCleanupDependencies
): Promise<ObservedTarget[]> {
  if (dependencies.platform !== 'darwin') return []
  const [rawWechatPids, rawPortPids] = await Promise.all([
    dependencies.listWechatPids(),
    dependencies.listPortPids()
  ])
  const wechatPids = rawWechatPids.filter((pid) => pid !== process.pid)
  const portPids = rawPortPids.filter((pid) => pid !== process.pid)
  const pids = [...new Set([...wechatPids, ...portPids])].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 0
  )
  const [names, identities] = await Promise.all([
    Promise.all(pids.map(async (pid) => [pid, await dependencies.processName(pid)] as const)),
    Promise.all(pids.map(async (pid) => [pid, await dependencies.processIdentity(pid)] as const))
  ])
  return mergeTargets(wechatPids, portPids, new Map(names), new Map(identities))
}

export async function inspectMacWechatResidualProcesses(
  dependencies: MacWechatResidualCleanupDependencies = defaultDependencies
): Promise<MacWechatResidualProcess[]> {
  return inspectObservedTargets(dependencies)
}

export async function cleanupMacWechatResidualProcesses(
  confirmedTargets: Array<Pick<MacWechatResidualProcess, 'pid' | 'confirmationToken'>>,
  dependencies: MacWechatResidualCleanupDependencies = defaultDependencies,
  onTargetsConfirmed?: (targets: MacWechatResidualProcess[]) => void
): Promise<{ stopped: MacWechatResidualProcess[]; remaining: MacWechatResidualProcess[] }> {
  if (dependencies.platform !== 'darwin') return { stopped: [], remaining: [] }
  const confirmed = new Map(
    confirmedTargets
      .filter(
        (target) =>
          target.pid !== process.pid &&
          Number.isSafeInteger(target.pid) &&
          target.pid > 0 &&
          typeof target.confirmationToken === 'string' &&
          target.confirmationToken.length > 0
      )
      .map((target) => [target.pid, target.confirmationToken])
  )
  const current = await inspectObservedTargets(dependencies)
  const selected = current.filter(
    (target) => confirmed.get(target.pid) === target.confirmationToken
  )
  if (selected.length === 0) {
    return {
      stopped: [],
      remaining: current.filter((target) => confirmed.has(target.pid))
    }
  }
  let cleanupTargetsNotified = false
  const signalMatchingTarget = async (
    target: ObservedTarget,
    expectedIdentity: string,
    signal: NodeJS.Signals
  ): Promise<void> => {
    const identity = await dependencies.processIdentity(target.pid)
    if (!expectedIdentity || identity !== expectedIdentity) return
    try {
      dependencies.signal(target.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    if (target.targets.includes('port_4290') && !cleanupTargetsNotified) {
      cleanupTargetsNotified = true
      onTargetsConfirmed?.([target])
    }
  }

  for (const target of selected.filter((item) => item.targets.includes('wechat'))) {
    await signalMatchingTarget(target, confirmed.get(target.pid) || '', 'SIGTERM')
  }
  if (selected.some((item) => item.targets.includes('wechat'))) await dependencies.wait(1_000)

  let remaining = (await inspectObservedTargets(dependencies)).filter((target) =>
    confirmed.has(target.pid)
  )
  for (const target of remaining) {
    const selectedTarget = selected.find((item) => item.pid === target.pid)
    if (!selectedTarget || target.confirmationToken !== selectedTarget.confirmationToken) continue
    await signalMatchingTarget(target, selectedTarget.confirmationToken, 'SIGTERM')
  }
  if (remaining.length > 0) await dependencies.wait(1_000)

  remaining = (await inspectObservedTargets(dependencies)).filter((target) =>
    confirmed.has(target.pid)
  )
  for (const target of remaining) {
    const selectedTarget = selected.find((item) => item.pid === target.pid)
    if (!selectedTarget || target.confirmationToken !== selectedTarget.confirmationToken) continue
    await signalMatchingTarget(target, selectedTarget.confirmationToken, 'SIGKILL')
  }
  if (remaining.length > 0) await dependencies.wait(250)
  remaining = (await inspectObservedTargets(dependencies)).filter((target) =>
    confirmed.has(target.pid)
  )
  return {
    stopped: selected
      .filter((target) => !remaining.some((item) => item.pid === target.pid))
      .map((target) => target),
    remaining
  }
}
