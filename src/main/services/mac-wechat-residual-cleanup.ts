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
  listHostPids: () => Promise<number[]>
  listFridaHelperPids: () => Promise<number[]>
  listPortPids: () => Promise<number[]>
  processName: (pid: number) => Promise<string>
  processCommand: (pid: number) => Promise<string>
  processCwd: (pid: number) => Promise<string>
  processState: (pid: number) => Promise<string>
  processIdentity: (pid: number) => Promise<string>
  signal: (pid: number, signal: NodeJS.Signals) => void
  wait: (milliseconds: number) => Promise<void>
}

const SEND_HOST_PORT = Number(process.env.TM_WECHAT_HOST_PORT) || 4290

function isTraceMemoRuntimePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').toLowerCase()
  return /\/tracememo(?:\.app\/contents)?\/resources\/runtime\/darwin-arm64(?:\/|$)/.test(
    normalized
  )
}

export function isTraceMemoFridaHelper(command: string, cwd: string): boolean {
  return isTraceMemoRuntimePath(command) || isTraceMemoRuntimePath(cwd)
}

/* 不要把进程信息不可读当作进程已退出：TCC 限制下仍可能有存活进程。 */
function resolveProcessName(
  name: string,
  command: string,
  cwd: string,
  isFridaHelper: boolean
): string {
  const trimmed = name.trim()
  if (/^frida-hel/.test(trimmed)) return 'frida-helper'
  if (/^tm-wechat/.test(trimmed)) return 'tm-wechat-host'
  if (trimmed && trimmed !== 'unknown') return trimmed
  if (/tm-wechat-host/.test(command)) return 'tm-wechat-host'
  if (/frida-helper/.test(command)) return 'frida-helper'
  if (isFridaHelper) return 'frida-helper'
  if (isTraceMemoRuntimePath(cwd)) return 'tm-wechat-host'
  return 'unknown'
}

async function readShortProcessName(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/sbin/lsof',
      ['-a', '-p', String(pid), '-d', 'cwd'],
      { timeout: 2_000 }
    )
    /* lsof 可能忽略失效的 -p 参数，因此必须核对返回行的 PID。 */
    for (const line of stdout.split('\n')) {
      const columns = line.trim().split(/\s+/)
      if (columns[1] === String(pid)) return columns[0] || ''
    }
    return ''
  } catch {
    return ''
  }
}

async function readProcessField(pid: number, field: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', `${field}=`], {
      timeout: 2_000
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function readProcessCwd(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/sbin/lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { timeout: 2_000 }
    )
    const lines = stdout.split('\n')
    /* lsof 可能忽略失效的 -p 参数，因此必须核对记录的 PID。 */
    if (lines.find((line) => line.startsWith('p')) !== `p${pid}`) return ''
    return lines.find((line) => line.startsWith('n'))?.slice(1) || ''
  } catch {
    return ''
  }
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
  listPortPids: () =>
    readPids('/usr/sbin/lsof', [
      '-nP',
      '-t',
      `-iTCP:${SEND_HOST_PORT}`,
      '-sTCP:LISTEN'
    ]),
  listHostPids: async () => {
    const pids = await readPids('/usr/bin/pgrep', ['-x', 'tm-wechat-host'])
    const [commands, directories] = await Promise.all([
      Promise.all(pids.map((pid) => readProcessField(pid, 'command'))),
      Promise.all(pids.map(readProcessCwd))
    ])
    return pids.filter(
      (_, index) =>
        isTraceMemoRuntimePath(commands[index]) || isTraceMemoRuntimePath(directories[index])
    )
  },
  listFridaHelperPids: async () => {
    const pids = await readPids('/usr/bin/pgrep', ['-f', 'frida-helper'])
    const [commands, directories] = await Promise.all([
      Promise.all(pids.map((pid) => readProcessField(pid, 'command'))),
      Promise.all(pids.map(readProcessCwd))
    ])
    return pids.filter((_, index) => isTraceMemoFridaHelper(commands[index], directories[index]))
  },
  processName: async (pid) => {
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
        timeout: 2_000
      })
      const name = stdout.trim().split('/').pop() || ''
      if (name) return name
    } catch {
      /* ps 对同用户外部进程可能整体不可用，落到 lsof。 */
    }
    return readShortProcessName(pid) || 'unknown'
  },
  processCommand: (pid) => readProcessField(pid, 'command'),
  processCwd: readProcessCwd,
  processState: (pid) => readProcessField(pid, 'state'),
  processIdentity: async (pid) => {
    try {
      const [startTime, command, cwd] = await Promise.all([
        readProcessField(pid, 'lstart'),
        readProcessField(pid, 'command'),
        readProcessCwd(pid)
      ])
      /* 纳入 PID，避免进程退出后复用同一工作目录导致身份碰撞。 */
      return createHash('sha256')
        .update([String(pid), startTime, command, cwd].join('\0'))
        .digest('hex')
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
  hostPids: number[],
  portPids: number[],
  processNames: Map<number, string>,
  processIdentities: Map<number, string>,
  processStates: Map<number, string>,
  fridaHelperPids: number[]
): ObservedTarget[] {
  const targets = new Map<number, Set<'wechat' | 'host' | 'port_4290' | 'frida_helper'>>()
  for (const pid of wechatPids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const reasons = targets.get(pid) || new Set<'wechat' | 'host' | 'port_4290' | 'frida_helper'>()
    reasons.add('wechat')
    targets.set(pid, reasons)
  }
  for (const pid of hostPids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const reasons = targets.get(pid) || new Set<'wechat' | 'host' | 'port_4290' | 'frida_helper'>()
    reasons.add('host')
    targets.set(pid, reasons)
  }
  for (const pid of portPids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const reasons = targets.get(pid) || new Set<'wechat' | 'host' | 'port_4290' | 'frida_helper'>()
    reasons.add('port_4290')
    targets.set(pid, reasons)
  }
  for (const pid of fridaHelperPids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const reasons = targets.get(pid) || new Set<'wechat' | 'host' | 'port_4290' | 'frida_helper'>()
    reasons.add('frida_helper')
    targets.set(pid, reasons)
  }
  return [...targets.entries()]
    .sort(([first], [second]) => first - second)
    .map(([pid, reasons]) => {
      const state = processStates.get(pid) || ''
      return {
        pid,
        name: processNames.get(pid) || 'unknown',
        ...(state ? { state } : {}),
        /* 只有明确的 U 状态才标记为不可中断；状态未知不做推断。 */
        ...(/U/.test(state) ? { uninterruptible: true } : {}),
        targets: [...reasons].sort(),
        confirmationToken: processIdentities.get(pid) || ''
      }
    })
}

async function inspectObservedTargets(
  dependencies: MacWechatResidualCleanupDependencies
): Promise<ObservedTarget[]> {
  if (dependencies.platform !== 'darwin') return []
  const [rawWechatPids, rawHostPids, rawPortPids, rawFridaHelperPids] = await Promise.all([
    dependencies.listWechatPids(),
    dependencies.listHostPids(),
    dependencies.listPortPids(),
    dependencies.listFridaHelperPids()
  ])
  const wechatPids = rawWechatPids.filter((pid) => pid !== process.pid)
  const hostPids = rawHostPids.filter((pid) => pid !== process.pid)
  const portPids = rawPortPids.filter((pid) => pid !== process.pid)
  const fridaHelperPids = rawFridaHelperPids.filter((pid) => pid !== process.pid)
  const pids = [...new Set([...wechatPids, ...portPids, ...fridaHelperPids])].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 0
  )
  for (const pid of hostPids) {
    if (Number.isSafeInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid)
  }
  const [names, identities, states] = await Promise.all([
    Promise.all(pids.map(async (pid) => [pid, await dependencies.processName(pid)] as const)),
    Promise.all(pids.map(async (pid) => [pid, await dependencies.processIdentity(pid)] as const)),
    Promise.all(pids.map(async (pid) => [pid, await dependencies.processState(pid)] as const))
  ])
  const [commands, directories] = await Promise.all([
    Promise.all(pids.map(async (pid) => [pid, await dependencies.processCommand(pid)] as const)),
    Promise.all(pids.map(async (pid) => [pid, await dependencies.processCwd(pid)] as const))
  ])
  const commandByPid = new Map(commands)
  const cwdByPid = new Map(directories)
  const nameByPid = new Map(names)
  const filteredFridaHelpers = fridaHelperPids.filter((pid) =>
    isTraceMemoFridaHelper(commandByPid.get(pid) || '', cwdByPid.get(pid) || '')
  )
  const fridaHelperSet = new Set(filteredFridaHelpers)
  const resolvedNames = new Map<number, string>()
  for (const pid of pids) {
    resolvedNames.set(
      pid,
      resolveProcessName(
        nameByPid.get(pid) || '',
        commandByPid.get(pid) || '',
        cwdByPid.get(pid) || '',
        fridaHelperSet.has(pid)
      )
    )
  }
  return mergeTargets(
    wechatPids,
    hostPids,
    portPids,
    resolvedNames,
    new Map(identities),
    new Map(states),
    filteredFridaHelpers
  )
}

async function waitForConfirmedTargets(
  dependencies: MacWechatResidualCleanupDependencies,
  selected: ObservedTarget[],
  attempts: number,
  intervalMs: number
): Promise<ObservedTarget[]> {
  const expected = new Map(selected.map((target) => [target.pid, target.confirmationToken]))
  let remaining = selected.filter((target) => !/U/.test(target.state || ''))
  if (remaining.length === 0) return selected
  for (let attempt = 0; attempt < attempts && remaining.length > 0; attempt++) {
    await dependencies.wait(intervalMs)
    const current = await inspectObservedTargets(dependencies)
    remaining = current.filter(
      (target) =>
        expected.get(target.pid) === target.confirmationToken && !/U/.test(target.state || '')
    )
  }
  const blocked = selected.filter((target) => /U/.test(target.state || ''))
  return [...remaining, ...blocked]
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
  const selectedIdentities = new Map(selected.map((target) => [target.pid, target.confirmationToken]))
  if (selected.length === 0) {
    return {
      stopped: [],
      remaining: current
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
    if (
      (target.targets.includes('host') ||
        target.targets.includes('port_4290') ||
        target.targets.includes('frida_helper')) &&
      !cleanupTargetsNotified
    ) {
      cleanupTargetsNotified = true
      onTargetsConfirmed?.([target])
    }
    try {
      dependencies.signal(target.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  let activeTargets = (await inspectObservedTargets(dependencies)).filter(
    (target) =>
      confirmed.has(target.pid) &&
      selectedIdentities.get(target.pid) === target.confirmationToken
  )
  const hostTargets = activeTargets.filter((target) => target.targets.includes('host'))
  for (const target of hostTargets) {
    await signalMatchingTarget(target, target.confirmationToken, 'SIGTERM')
  }
  if (hostTargets.some((target) => !/U/.test(target.state || ''))) {
    await dependencies.wait(1_000)
    await waitForConfirmedTargets(dependencies, hostTargets, 8, 250)
  }

  activeTargets = (await inspectObservedTargets(dependencies)).filter((target) =>
    confirmed.has(target.pid) && selectedIdentities.get(target.pid) === target.confirmationToken
  )
  const helperTargets = activeTargets.filter(
    (target) =>
      !target.targets.includes('host') &&
      target.targets.includes('frida_helper') &&
      selectedIdentities.get(target.pid) === target.confirmationToken
  )
  const unrelatedPortTargets = activeTargets.filter(
    (target) =>
      !target.targets.includes('host') &&
      !target.targets.includes('frida_helper') &&
      selectedIdentities.get(target.pid) === target.confirmationToken
  )
  for (const target of helperTargets) {
    await signalMatchingTarget(target, target.confirmationToken, 'SIGTERM')
  }
  for (const target of unrelatedPortTargets) {
    await signalMatchingTarget(target, target.confirmationToken, 'SIGTERM')
  }
  await waitForConfirmedTargets(dependencies, helperTargets, 4, 250)
  await waitForConfirmedTargets(dependencies, unrelatedPortTargets, 4, 250)

  activeTargets = (await inspectObservedTargets(dependencies)).filter(
    (target) =>
      confirmed.has(target.pid) &&
      selectedIdentities.get(target.pid) === target.confirmationToken
  )
  const wechatTargets = activeTargets.filter((target) => target.targets.includes('wechat'))
  for (const target of wechatTargets) {
    await signalMatchingTarget(target, target.confirmationToken, 'SIGTERM')
  }
  await waitForConfirmedTargets(dependencies, wechatTargets, 8, 250)
  const remainingTargets = activeTargets.filter(
    (target) =>
      !target.targets.includes('host') &&
      !target.targets.includes('frida_helper') &&
      !target.targets.includes('wechat') &&
      selectedIdentities.get(target.pid) === target.confirmationToken
  )
  await waitForConfirmedTargets(dependencies, remainingTargets, 10, 500)

  activeTargets = (await inspectObservedTargets(dependencies)).filter((target) =>
    confirmed.has(target.pid) && selectedIdentities.get(target.pid) === target.confirmationToken
  )
  for (const target of activeTargets) {
    const selectedTarget = selected.find((item) => item.pid === target.pid)
    if (!selectedTarget || target.confirmationToken !== selectedTarget.confirmationToken) continue
    await signalMatchingTarget(target, selectedTarget.confirmationToken, 'SIGKILL')
  }
  await waitForConfirmedTargets(dependencies, activeTargets, 8, 250)
  const remaining = await inspectObservedTargets(dependencies)
  return {
    stopped: selected
      .filter((target) => !remaining.some((item) => item.pid === target.pid))
      .map((target) => target),
    remaining
  }
}
