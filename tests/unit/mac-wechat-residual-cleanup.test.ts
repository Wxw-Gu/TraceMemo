import { describe, expect, it, vi } from 'vitest'
import {
  cleanupMacWechatResidualProcesses,
  isTraceMemoFridaHelper,
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
    listHostPids: vi.fn(async () => []),
    listFridaHelperPids: vi.fn(async () => []),
    listPortPids: vi.fn(async () => [202]),
    processName: vi.fn(async (pid) => (pid === 101 ? 'WeChat' : 'tm-wechat-host')),
    processCommand: vi.fn(async () => ''),
    processState: vi.fn(async () => ''),
    processCwd: vi.fn(async () => ''),
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

  it('lists every TraceMemo Host, including hosts that do not own port 4290', async () => {
    const dependencies = createDependencies({
      listWechatPids: vi.fn(async () => []),
      listHostPids: vi.fn(async () => [303]),
      listPortPids: vi.fn(async () => []),
      processName: vi.fn(async () => 'tm-wechat-host')
    })

    await expect(inspectMacWechatResidualProcesses(dependencies)).resolves.toEqual([
      {
        pid: 303,
        name: 'tm-wechat-host',
        targets: ['host'],
        confirmationToken: 'identity-303'
      }
    ])
  })

  it('lists Frida helpers that retain the configured listener', async () => {
    const dependencies = createDependencies({
      listWechatPids: vi.fn(async () => []),
      listHostPids: vi.fn(async () => []),
      listFridaHelperPids: vi.fn(async () => [404]),
      listPortPids: vi.fn(async () => [404]),
      processName: vi.fn(async () => '(frida-helper)'),
      processCommand: vi.fn(async () => '(frida-helper)'),
      processCwd: vi.fn(async () => '/Applications/TraceMemo.app/Contents/Resources/runtime/darwin-arm64'),
      processState: vi.fn(async () => 'UE')
    })

    await expect(inspectMacWechatResidualProcesses(dependencies)).resolves.toEqual([
      {
        pid: 404,
        name: '(frida-helper)',
        state: 'UE',
        uninterruptible: true,
        targets: ['frida_helper', 'port_4290'],
        confirmationToken: 'identity-404'
      }
    ])
  })

  it('escalates a helper in kernel wait state and reports it while the system retains it', async () => {
    const dependencies = createDependencies({
      listWechatPids: vi.fn(async () => []),
      listHostPids: vi.fn(async () => []),
      listFridaHelperPids: vi.fn(async () => [404]),
      listPortPids: vi.fn(async () => [404]),
      processName: vi.fn(async () => '(frida-helper)'),
      processCommand: vi.fn(async () => '(frida-helper)'),
      processCwd: vi.fn(async () => '/Applications/TraceMemo.app/Contents/Resources/runtime/darwin-arm64'),
      processState: vi.fn(async () => 'UE')
    })
    const targets = await inspectMacWechatResidualProcesses(dependencies)

    const result = await cleanupMacWechatResidualProcesses(
      targets.map(({ pid, confirmationToken }) => ({ pid, confirmationToken })),
      dependencies
    )

    expect(dependencies.signal).toHaveBeenCalledWith(404, 'SIGTERM')
    expect(dependencies.signal).toHaveBeenCalledWith(404, 'SIGKILL')
    expect(dependencies.wait).not.toHaveBeenCalled()
    expect(result.stopped).toEqual([])
    expect(result.remaining).toMatchObject([{ pid: 404, state: 'UE', targets: ['frida_helper', 'port_4290'] }])
  })

  it('uses the process working directory to associate an orphan helper with TraceMemo', async () => {
    const dependencies = createDependencies({
      listWechatPids: vi.fn(async () => []),
      listHostPids: vi.fn(async () => []),
      listFridaHelperPids: vi.fn(async () => [405]),
      listPortPids: vi.fn(async () => []),
      processCommand: vi.fn(async () => '(frida-helper)'),
      processCwd: vi.fn(async () => '/Applications/TraceMemo.app/Contents/Resources/runtime/darwin-arm64')
    })

    await expect(inspectMacWechatResidualProcesses(dependencies)).resolves.toEqual([
      {
        pid: 405,
        name: 'tm-wechat-host',
        targets: ['frida_helper'],
        confirmationToken: 'identity-405'
      }
    ])
  })

  it('does not list unrelated Frida helpers', async () => {
    const dependencies = createDependencies({
      listWechatPids: vi.fn(async () => []),
      listHostPids: vi.fn(async () => []),
      listFridaHelperPids: vi.fn(async () => [405]),
      listPortPids: vi.fn(async () => []),
      processCommand: vi.fn(async () => '/opt/debug-tool/frida-helper'),
      processCwd: vi.fn(async () => '/opt/debug-tool')
    })

    await expect(inspectMacWechatResidualProcesses(dependencies)).resolves.toEqual([])
  })

  it('identifies an orphan helper by its TraceMemo runtime path', () => {
    expect(
      isTraceMemoFridaHelper(
        '(frida-helper)',
        '/Applications/TraceMemo.app/Contents/Resources/runtime/darwin-arm64'
      )
    ).toBe(true)
    expect(isTraceMemoFridaHelper('/opt/debug-tool/frida-helper', '/opt/debug-tool')).toBe(false)
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

  it('waits for a TraceMemo Host to finish normal teardown before signaling its helper', async () => {
    const sentSignals: Array<[number, NodeJS.Signals]> = []
    const dependencies = createDependencies({
      listWechatPids: vi.fn(async () => []),
      listHostPids: vi.fn(async () => [303]),
      listFridaHelperPids: vi.fn(async () => [404]),
      listPortPids: vi.fn(async () => [404]),
      processName: vi.fn(async (pid) => (pid === 303 ? 'tm-wechat-host' : '(frida-helper)')),
      processCommand: vi.fn(async (pid) =>
        pid === 303
          ? '/Applications/TraceMemo.app/Contents/Resources/runtime/darwin-arm64/tm-wechat-host'
          : '(frida-helper)'
      ),
      processCwd: vi.fn(async (pid) =>
        pid === 303 ? '' : '/Applications/TraceMemo.app/Contents/Resources/runtime/darwin-arm64'
      ),
      processIdentity: vi.fn(async (pid) => 'identity-' + pid),
      signal: vi.fn((pid, signal) => sentSignals.push([pid, signal])),
      wait: vi.fn(async () => undefined)
    })
    const targets = await inspectMacWechatResidualProcesses(dependencies)

    await cleanupMacWechatResidualProcesses(
      targets.map(({ pid, confirmationToken }) => ({ pid, confirmationToken })),
      dependencies
    )

    expect(sentSignals.findIndex(([pid]) => pid === 303)).toBeLessThan(
      sentSignals.findIndex(([pid]) => pid === 404)
    )
    expect(sentSignals[0]).toEqual([303, 'SIGTERM'])
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

    expect(identityReads).toBeGreaterThan(1)

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
