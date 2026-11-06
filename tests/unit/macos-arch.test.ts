import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KeyServiceMac } from '../../src/main/key-service-mac'
import {
  ARCH_MISMATCH_X64_ON_ARM_ERROR,
  buildMacArchSnapshot,
  resolveMacKeyFlow,
  shouldProbeIntelEnvironment,
  type MacArchInput
} from '../../src/shared/macos-arch'

/**
 * 密钥流程的选择依据是「硬件 + 运行架构 + 转译状态」三者组合，
 * 不是单一的 `process.arch`。这组用例把组合表钉死，
 * 避免以后有人把判定简化回 `process.arch === 'x64'`。
 */
function input(overrides: Partial<MacArchInput>): MacArchInput {
  return {
    platform: 'darwin',
    hardwareArch: 'arm64',
    runtimeArch: 'arm64',
    underARM64Translation: false,
    ...overrides
  }
}

describe('resolveMacKeyFlow', () => {
  it('runs the Apple Silicon flow on native arm64', () => {
    expect(resolveMacKeyFlow(input({}))).toBe('apple-silicon')
  })

  it('blocks the Intel flow when Rosetta is reported, even if hardware is unknown', () => {
    expect(
      resolveMacKeyFlow(input({ hardwareArch: 'unknown', runtimeArch: 'x64', underARM64Translation: true }))
    ).toBe('arch-mismatch')
  })

  it('blocks the Intel flow when hardware is arm64 but the translation flag is missing', () => {
    expect(
      resolveMacKeyFlow(input({ hardwareArch: 'arm64', runtimeArch: 'x64', underARM64Translation: false }))
    ).toBe('arch-mismatch')
  })

  it('keeps the Intel flow on a real Intel Mac', () => {
    expect(
      resolveMacKeyFlow(input({ hardwareArch: 'x64', runtimeArch: 'x64', underARM64Translation: false }))
    ).toBe('intel')
  })

  it('falls back to the Intel flow when hardware cannot be read but nothing looks translated', () => {
    expect(
      resolveMacKeyFlow(input({ hardwareArch: 'unknown', runtimeArch: 'x64', underARM64Translation: false }))
    ).toBe('intel')
  })

  it('treats other platforms as unsupported', () => {
    expect(
      resolveMacKeyFlow(input({ platform: 'win32', hardwareArch: 'x64', runtimeArch: 'x64' }))
    ).toBe('unsupported')
  })

  it('treats an unexpected runtime architecture as unsupported', () => {
    expect(resolveMacKeyFlow(input({ runtimeArch: 'ia32' }))).toBe('unsupported')
  })
})

describe('buildMacArchSnapshot', () => {
  it('records the unknown hardware signal without changing the Intel flow', () => {
    const snapshot = buildMacArchSnapshot(
      input({ hardwareArch: 'unknown', runtimeArch: 'x64', underARM64Translation: false })
    )
    expect(snapshot.macKeyFlow).toBe('intel')
    expect(snapshot.anomalies).toContain('hardware_arch_unknown')
  })

  it('records a translated process whose hardware probe disagreed', () => {
    const snapshot = buildMacArchSnapshot(
      input({ hardwareArch: 'x64', runtimeArch: 'x64', underARM64Translation: true })
    )
    expect(snapshot.macKeyFlow).toBe('arch-mismatch')
    expect(snapshot.anomalies).toContain('translation_flag_without_arm_hardware')
  })

  it('records a translation flag on a native arm64 process', () => {
    const snapshot = buildMacArchSnapshot(input({ underARM64Translation: true }))
    expect(snapshot.macKeyFlow).toBe('apple-silicon')
    expect(snapshot.anomalies).toContain('translation_flag_with_native_arm64')
  })

  it('flags an x64 runtime on Apple silicon that reports no translation', () => {
    const snapshot = buildMacArchSnapshot(
      input({ hardwareArch: 'arm64', runtimeArch: 'x64', underARM64Translation: false })
    )
    expect(snapshot.macKeyFlow).toBe('arch-mismatch')
    expect(snapshot.anomalies).toContain('x64_runtime_on_arm_without_translation_flag')
  })
})

describe('ARCH_MISMATCH_X64_ON_ARM_ERROR', () => {
  it('tells the user to install the arm64 build', () => {
    expect(ARCH_MISMATCH_X64_ON_ARM_ERROR).toContain('Apple Silicon')
    expect(ARCH_MISMATCH_X64_ON_ARM_ERROR).toContain('arm64')
  })
})

describe('shouldProbeIntelEnvironment', () => {
  it('only probes on a genuine Intel Mac', () => {
    expect(shouldProbeIntelEnvironment('intel')).toBe(true)
    expect(shouldProbeIntelEnvironment('apple-silicon')).toBe(false)
    expect(shouldProbeIntelEnvironment('arch-mismatch')).toBe(false)
    expect(shouldProbeIntelEnvironment('unsupported')).toBe(false)
  })
})

const { spawnMock, execFileMock, flowState } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
  flowState: { flow: 'arch-mismatch' as 'apple-silicon' | 'intel' | 'arch-mismatch' | 'unsupported' }
}))

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (...args: unknown[]) => execFileMock(...args)
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/tracememo-fixture-userdata',
    getVersion: () => '0.0.0',
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  }
}))

vi.mock('../../src/main/macos-arch', () => ({
  getMacArchSnapshot: () => ({
    platform: 'darwin',
    hardwareArch: flowState.flow === 'intel' ? 'x64' : 'arm64',
    runtimeArch: flowState.flow === 'intel' ? 'x64' : 'x64',
    underARM64Translation: flowState.flow === 'arch-mismatch',
    macKeyFlow: flowState.flow,
    anomalies: []
  }),
  resetMacArchSnapshotCache: () => undefined
}))

describe('KeyServiceMac arch guard', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    execFileMock.mockReset()
    flowState.flow = 'arch-mismatch'
  })

  /** 列出所有被 spawn/execFile 触达的可执行文件，用于断言「什么也没启动」。 */
  const execFileCommands = (): string[] => execFileMock.mock.calls.map((call) => String(call[0]))

  it('returns ARCH_MISMATCH_X64_ON_ARM without spawning anything', async () => {
    const service = new KeyServiceMac()
    const result = await service.autoGetDbKey(undefined, 60_000, '/tmp/fixture-account')

    expect(result.success).toBe(false)
    expect(result.code).toBe('ARCH_MISMATCH_X64_ON_ARM')
    expect(result.error).toBe(ARCH_MISMATCH_X64_ON_ARM_ERROR)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('never touches csrutil, pgrep or osascript on a mismatched machine', async () => {
    const service = new KeyServiceMac()
    await service.autoGetDbKey(undefined, 60_000, '/tmp/fixture-account')

    const commands = execFileCommands()
    // csrutil = SIP 探测，pgrep = 查找微信进程，osascript = 请求管理员授权执行 helper
    expect(commands).not.toContain('/usr/bin/csrutil')
    expect(commands).not.toContain('/usr/bin/pgrep')
    expect(commands).not.toContain('/usr/bin/osascript')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('checks the architecture before SIP, so a mismatch never reports SIP_ENABLED', async () => {
    execFileMock.mockImplementation((_cmd, _args, _options, callback) => {
      callback(null, { stdout: 'System Integrity Protection status: enabled.' }, '')
    })

    const service = new KeyServiceMac()
    const result = await service.autoGetDbKey(undefined, 60_000, '/tmp/fixture-account')

    expect(result.code).toBe('ARCH_MISMATCH_X64_ON_ARM')
    expect(result.code).not.toBe('SIP_ENABLED')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('refuses to install the Intel runtime on a mismatched machine', async () => {
    const service = new KeyServiceMac()
    const result = await service.installIntelKeyRuntime()

    expect(result.success).toBe(false)
    expect(result.code).toBe('ARCH_MISMATCH_X64_ON_ARM')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not spawn the Intel helper when refreshing the environment', async () => {
    const service = new KeyServiceMac()
    const status = await service.getIntelEnvironmentStatus()

    expect(status).toEqual({
      sipDisabled: false,
      pythonAvailable: false,
      fridaAvailable: false,
      wechatAdhocSigned: false
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('still reports SIP_ENABLED on a genuine Intel Mac', async () => {
    flowState.flow = 'intel'
    // promisify(execFile) 在只传两个参数时把 callback 放在第三个位置。
    execFileMock.mockImplementation((_cmd, _args, options, callback) => {
      const done = typeof options === 'function' ? options : callback
      done(null, { stdout: 'System Integrity Protection status: enabled.' }, '')
    })

    const service = new KeyServiceMac()
    const result = await service.autoGetDbKey(undefined, 60_000, '/tmp/fixture-account')

    expect(result.code).toBe('SIP_ENABLED')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('never reaches the Intel helper on the Apple Silicon flow', async () => {
    flowState.flow = 'apple-silicon'
    execFileMock.mockImplementation((_cmd, _args, options, callback) => {
      const done = typeof options === 'function' ? options : callback
      done(null, { stdout: '' }, '')
    })

    const service = new KeyServiceMac()
    const result = await service.autoGetDbKey(undefined, 60_000, '/tmp/fixture-account')

    expect(result.code).not.toBe('ARCH_MISMATCH_X64_ON_ARM')
    // Intel helper 是唯一的 spawn 调用点；arm64 流程走 osascript + xkey_helper，不会经过它。
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
