import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findRuntime, buildEnvironment, writeLog } = vi.hoisted(() => ({
  findRuntime: vi.fn(),
  buildEnvironment: vi.fn(),
  writeLog: vi.fn()
}))

vi.mock('../../src/main/services/personal-wechat-send-service', () => ({
  findPersonalWechatRuntime: findRuntime,
  buildPersonalWechatRuntimeEnvironment: buildEnvironment
}))
vi.mock('../../src/main/app-logger', () => ({ appLogger: { write: writeLog } }))

import { PersonalWechatVoiceEnvironmentService } from '../../src/main/services/personal-wechat-voice-environment-service'

const runtime = {
  root: '/runtime',
  executable: '/runtime/onebot/onebot',
  workingDirectory: '/runtime/onebot',
  configDirectory: '/runtime/wechat_version',
  logPath: '/runtime/onebot/log/macos.log'
}

describe('PersonalWechatVoiceEnvironmentService', () => {
  let pilkAvailable = true
  const commands: Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> = []

  beforeEach(() => {
    pilkAvailable = true
    commands.length = 0
    findRuntime.mockReset().mockReturnValue(runtime)
    buildEnvironment.mockReset().mockReturnValue({
      PATH: '/runtime/bin',
      PYTHONPATH: '/runtime/python'
    })
    writeLog.mockReset()
  })

  function createService(): PersonalWechatVoiceEnvironmentService {
    return new PersonalWechatVoiceEnvironmentService({
      platform: 'darwin',
      architecture: 'arm64',
      findRuntime,
      buildEnvironment,
      now: () => new Date('2026-08-31T00:00:00.000Z'),
      runCommand: async (executable, args, options) => {
        commands.push({ executable, args, env: options.env })
        if (executable === 'python3') {
          return {
            stdout: JSON.stringify({ executable: '/runtime/python3', version: '3.12.11' }),
            stderr: ''
          }
        }
        if (executable === '/runtime/python3' && args[0] === '-c') {
          if (!pilkAvailable) throw new Error("ModuleNotFoundError: No module named 'pilk'")
          return {
            stdout: JSON.stringify({ version: '0.2.4', path: '/runtime/python/pilk/__init__.py' }),
            stderr: ''
          }
        }
        if (executable === '/usr/bin/which') {
          return { stdout: '/runtime/bin/ffmpeg\n', stderr: '' }
        }
        if (executable === 'ffmpeg') {
          return { stdout: 'ffmpeg version 7.0 fixture\n', stderr: '' }
        }
        if (executable === '/runtime/python3' && args[0] === '-m') {
          pilkAvailable = true
          return { stdout: 'installed\n', stderr: '' }
        }
        throw new Error(`unexpected command: ${executable} ${args.join(' ')}`)
      }
    })
  }

  it('checks pilk with the Python and environment used by OneBot', async () => {
    const environment = await createService().check()

    expect(environment).toMatchObject({
      state: 'ready',
      ready: true,
      runtimeReady: true,
      encoder: 'pilk',
      python: { ready: true, executable: '/runtime/python3', version: '3.12.11' },
      pilk: { ready: true, version: '0.2.4', path: '/runtime/python/pilk/__init__.py' },
      ffmpeg: { ready: true, executable: '/runtime/bin/ffmpeg', version: '7.0' }
    })
    expect(commands.find((command) => command.executable === 'python3')?.env).toEqual({
      PATH: '/runtime/bin',
      PYTHONPATH: '/runtime/python'
    })
    expect(commands.some((command) => command.executable === '/runtime/python3')).toBe(true)
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'VoiceRuntime',
        message: 'Voice encoding environment is ready'
      })
    )
  })

  it('reports go-silk fallback and installs the exact pilk version with the detected Python', async () => {
    pilkAvailable = false
    const service = createService()
    const before = await service.check()

    expect(before).toMatchObject({ state: 'incomplete', ready: false, encoder: 'go-silk' })
    expect(before.pilk.ready).toBe(false)

    const result = await service.installPilk()

    expect(result.success).toBe(true)
    expect(result.environment.pilk).toMatchObject({ ready: true, version: '0.2.4' })
    expect(commands).toContainEqual(
      expect.objectContaining({
        executable: '/runtime/python3',
        args: ['-m', 'pip', 'install', '--user', 'pilk==0.2.4']
      })
    )
  })

  it('keeps the UI contract explicit when Python cannot be started', async () => {
    const service = new PersonalWechatVoiceEnvironmentService({
      platform: 'darwin',
      architecture: 'arm64',
      findRuntime,
      buildEnvironment,
      runCommand: async () => {
        throw new Error('spawn python3 ENOENT')
      }
    })

    const environment = await service.check()

    expect(environment).toMatchObject({ state: 'incomplete', ready: false, encoder: 'unavailable' })
    expect(environment.python).toMatchObject({ ready: false })
    expect(environment.pilk).toMatchObject({ ready: false, error: 'Python 未找到，无法检查 pilk' })
  })
})
