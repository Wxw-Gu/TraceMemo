import { describe, expect, it, vi } from 'vitest'
import {
  cleanupMacWechatResidualProcesses,
  inspectMacWechatResidualProcesses,
  readPids,
  type MacWechatResidualCleanupDependencies
} from '../../src/main/services/mac-wechat-residual-cleanup'

function createDependencies(
  overrides: Partial<MacWechatResidualCleanupDependencies> = {}
): MacWechatResidualCleanupDependencies {
  return {
    platform: 'darwin',
    listWechatPids: vi.fn(async () => [101]),
    listPortPids: vi.fn(async () => [202]),
    processName: vi.fn(async (pid) => (pid === 101 ? 'WeChat' : 'tm-wechat-host')),
    processIdentity: vi.fn(async (pid) => 'identity-' + pid),
    signal: vi.fn(),
    wait: vi.fn(async () => undefined),
    ...overrides
  }
}

describe('macOS WeChat residual cleanup', () => {
  it('treats pgrep exit code 1 as no matching process', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: /usr/bin/pgrep -x Weixin'), { code: 1 })
    })

    await expect(readPids('/usr/bin/pgrep', ['-x', 'Weixin'], run)).resolves.toEqual([])
  })

  it('lists only WeChat processes and port 4290 listeners', async () => {
    const dependencies = createDependencies()

    await expect(inspectMacWechatResidualProcesses(dependencies)).resolves.toEqual([
      { pid: 101, name: 'WeChat', targets: ['wechat'], confirmationToken: 'identity-101' },
      {
        pid: 202,
        name: 'tm-wechat-host',
        targets: ['port_4290'],
        confirmationToken: 'identity-202'
      }
    ])
    expect(dependencies.processName).toHaveBeenCalledTimes(2)
  })

  it('does not signal a PID whose process identity changed after confirmation', async () => {
    const dependencies = createDependencies({
      listWechatPids: vi.fn(async () => []),
      listPortPids: vi.fn(async () => [202]),
      processIdentity: vi.fn(async () => 'changed-process')
    })

    const result = await cleanupMacWechatResidualProcesses(
      [{ pid: 202, confirmationToken: 'old-process' }],
      dependencies
    )

    expect(dependencies.signal).not.toHaveBeenCalled()
    expect(result.remaining).toEqual([
      {
        pid: 202,
        name: 'tm-wechat-host',
        targets: ['port_4290'],
        confirmationToken: 'changed-process'
      }
    ])
  })

  it('uses graceful termination first and only escalates confirmed targets', async () => {
    const signalled: Array<[number, NodeJS.Signals]> = []
    const dependencies = createDependencies({
      listWechatPids: vi.fn(async () => []),
      listPortPids: vi.fn(async () => [202]),
      signal: vi.fn((pid, signal) => signalled.push([pid, signal]))
    })

    const targets = await inspectMacWechatResidualProcesses(dependencies)
    const result = await cleanupMacWechatResidualProcesses(
      [{ pid: 202, confirmationToken: targets[0].confirmationToken }],
      dependencies
    )

    expect(signalled).toEqual([
      [202, 'SIGTERM'],
      [202, 'SIGKILL']
    ])
    expect(result.remaining.map((target) => target.pid)).toEqual([202])
  })

  it('reports only identity-matched targets before signaling so the caller can stop its own runtime safely', async () => {
    const dependencies = createDependencies({
      listWechatPids: vi.fn(async () => []),
      listPortPids: vi.fn(async () => [202, 303]),
      processIdentity: vi.fn(async (pid) =>
        pid === 202 ? 'identity-202' : 'stale-confirmation-303'
      ),
      processName: vi.fn(async (pid) => 'process-' + pid),
      signal: vi.fn()
    })
    const onTargetsConfirmed = vi.fn()

    await cleanupMacWechatResidualProcesses(
      [{ pid: 202, confirmationToken: 'identity-202' }],
      dependencies,
      onTargetsConfirmed
    )

    expect(onTargetsConfirmed).toHaveBeenCalledWith([
      {
        pid: 202,
        name: 'process-202',
        targets: ['port_4290'],
        confirmationToken: 'identity-202'
      }
    ])
    expect(dependencies.signal).toHaveBeenCalledWith(202, 'SIGTERM')
    expect(dependencies.signal).not.toHaveBeenCalledWith(303, expect.any(String))
  })

  it('does not signal a process after its PID identity changes', async () => {
    let identityReads = 0
    const dependencies = createDependencies({
      listWechatPids: vi.fn(async () => []),
      listPortPids: vi.fn(async () => [202]),
      processIdentity: vi.fn(async () => {
        identityReads += 1
        return identityReads === 1 ? 'confirmed-process' : 'reused-pid-process'
      }),
      signal: vi.fn()
    })
    const onTargetsConfirmed = vi.fn()

    const result = await cleanupMacWechatResidualProcesses(
      [{ pid: 202, confirmationToken: 'confirmed-process' }],
      dependencies,
      onTargetsConfirmed
    )

    expect(dependencies.signal).not.toHaveBeenCalled()
    expect(onTargetsConfirmed).not.toHaveBeenCalled()
    expect(result.stopped).toEqual([])
    expect(result.remaining[0]).toMatchObject({
      pid: 202,
      confirmationToken: 'reused-pid-process'
    })
  })

  it('does nothing outside macOS', async () => {
    const dependencies = createDependencies({ platform: 'win32' })

    await expect(inspectMacWechatResidualProcesses(dependencies)).resolves.toEqual([])
    await expect(
      cleanupMacWechatResidualProcesses(
        [{ pid: 101, confirmationToken: 'identity-101' }],
        dependencies
      )
    ).resolves.toEqual({
      stopped: [],
      remaining: []
    })
    expect(dependencies.signal).not.toHaveBeenCalled()
  })
})
