import { execFile } from 'child_process'
import { promisify } from 'util'
import { isAbsolute } from 'path'
import type {
  PersonalWechatVoiceEncodingEnvironment,
  PersonalWechatVoiceEncodingEnvironmentResult,
  PersonalWechatVoiceRuntimeComponent
} from '../../shared/personal-wechat-voice-runtime'
import { PERSONAL_WECHAT_PILK_VERSION } from '../../shared/personal-wechat-voice-runtime'
import {
  buildPersonalWechatRuntimeEnvironment,
  findPersonalWechatRuntime
} from './personal-wechat-send-service'
import type { RuntimeLayout } from './personal-wechat-send-service'
import { appLogger } from '../app-logger'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 10_000
const INSTALL_TIMEOUT_MS = 120_000

const PYTHON_PROBE =
  'import json,sys; print(json.dumps({"executable":sys.executable,"version":".".join(map(str,sys.version_info[:3]))}))'
const PILK_PROBE =
  'import json,pilk; print(json.dumps({"version":getattr(pilk,"__version__", ""),"path":getattr(pilk,"__file__", "")}))'

interface CommandOptions {
  env: NodeJS.ProcessEnv
  timeout?: number
}

type CommandRunner = (
  executable: string,
  args: string[],
  options: CommandOptions
) => Promise<{ stdout: string; stderr: string }>

interface PersonalWechatVoiceEnvironmentServiceOptions {
  platform?: NodeJS.Platform
  architecture?: string
  findRuntime?: () => RuntimeLayout | null
  buildEnvironment?: (runtimeRoot?: string) => NodeJS.ProcessEnv
  runCommand?: CommandRunner
  now?: () => Date
}

function blankComponent(): PersonalWechatVoiceRuntimeComponent {
  return { ready: false }
}

function commandError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 500) || '命令执行失败'
}

function logEnvironmentLine(message: string, details?: Record<string, unknown>): void {
  appLogger.write({ level: 'info', scope: 'VoiceRuntime', message, details })
}

function logEnvironmentWarning(message: string, details?: Record<string, unknown>): void {
  appLogger.write({ level: 'warn', scope: 'VoiceRuntime', message, details })
}

async function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(executable, args, {
    env: options.env,
    timeout: options.timeout || COMMAND_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    windowsHide: true
  }) as Promise<{ stdout: string; stderr: string }>
}

async function findCommandPath(
  command: string,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner = runCommand
): Promise<string | undefined> {
  try {
    const { stdout } = await runner('/usr/bin/which', [command], { env })
    const path = stdout.trim().split(/\r?\n/)[0]
    return path && isAbsolute(path) ? path : undefined
  } catch {
    return undefined
  }
}

function unsupportedEnvironment(): PersonalWechatVoiceEncodingEnvironment {
  return {
    state: 'unsupported',
    ready: false,
    runtimeReady: false,
    python: blankComponent(),
    pilk: blankComponent(),
    ffmpeg: blankComponent(),
    encoder: 'unavailable',
    message: '语音编码环境检查当前仅支持 Apple Silicon Mac'
  }
}

export class PersonalWechatVoiceEnvironmentService {
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly findRuntime: () => RuntimeLayout | null
  private readonly buildEnvironment: (runtimeRoot?: string) => NodeJS.ProcessEnv
  private readonly runCommand: CommandRunner
  private readonly now: () => Date

  constructor(options: PersonalWechatVoiceEnvironmentServiceOptions = {}) {
    this.platform = options.platform || process.platform
    this.architecture = options.architecture || process.arch
    this.findRuntime = options.findRuntime || findPersonalWechatRuntime
    this.buildEnvironment = options.buildEnvironment || buildPersonalWechatRuntimeEnvironment
    this.runCommand = options.runCommand || runCommand
    this.now = options.now || (() => new Date())
  }

  async check(): Promise<PersonalWechatVoiceEncodingEnvironment> {
    if (this.platform !== 'darwin' || this.architecture !== 'arm64') {
      return unsupportedEnvironment()
    }

    logEnvironmentLine('Checking voice encoding environment')
    const runtime = this.findRuntime()
    const environment = this.buildEnvironment(runtime?.root)
    const python = blankComponent()
    const pilk = blankComponent()
    const ffmpeg = blankComponent()

    let pythonExecutable = ''
    try {
      const result = await this.runCommand('python3', ['-c', PYTHON_PROBE], { env: environment })
      const payload = JSON.parse(result.stdout.trim()) as {
        executable?: string
        version?: string
      }
      pythonExecutable = String(payload.executable || '').trim()
      const version = String(payload.version || '').trim()
      if (!pythonExecutable || !version) throw new Error('Python 未返回可执行路径或版本')
      python.ready = true
      python.executable = pythonExecutable
      python.version = version
      logEnvironmentLine(`Python: ${pythonExecutable}`)
      logEnvironmentLine(`Python version: ${version}`)
    } catch (error) {
      python.error = commandError(error)
      logEnvironmentWarning('Python: unavailable', { error: python.error })
    }

    if (pythonExecutable) {
      try {
        const result = await this.runCommand(pythonExecutable, ['-c', PILK_PROBE], {
          env: environment
        })
        const payload = JSON.parse(result.stdout.trim()) as { version?: string; path?: string }
        const version = String(payload.version || '').trim()
        const path = String(payload.path || '').trim()
        if (!version || !path) throw new Error('pilk 未返回版本或安装路径')
        pilk.version = version
        pilk.path = path
        pilk.ready = version === PERSONAL_WECHAT_PILK_VERSION
        if (!pilk.ready) {
          pilk.error = `版本不匹配，需要 ${PERSONAL_WECHAT_PILK_VERSION}`
        }
        logEnvironmentLine(`pilk: ${pilk.ready ? 'available' : 'incompatible'}`, {
          version,
          path
        })
        logEnvironmentLine(`pilk version: ${version}`)
      } catch (error) {
        pilk.error = commandError(error)
        logEnvironmentWarning('pilk: unavailable', { error: pilk.error })
      }
    } else {
      pilk.error = 'Python 未找到，无法检查 pilk'
    }

    try {
      const [result, executable] = await Promise.all([
        this.runCommand('ffmpeg', ['-version'], { env: environment }),
        findCommandPath('ffmpeg', environment, this.runCommand)
      ])
      const firstLine = result.stdout.split(/\r?\n/).find((line) => line.trim()) || ''
      const version = firstLine.match(/^ffmpeg version\s+([^\s]+)/i)?.[1] || firstLine.trim()
      if (!version) throw new Error('ffmpeg 未返回版本')
      ffmpeg.ready = true
      ffmpeg.version = version
      ffmpeg.executable = executable || 'ffmpeg'
      logEnvironmentLine('ffmpeg: available', {
        executable: ffmpeg.executable,
        version
      })
    } catch (error) {
      ffmpeg.error = commandError(error)
      logEnvironmentWarning('ffmpeg: unavailable', { error: ffmpeg.error })
    }

    const ready = Boolean(runtime && python.ready && pilk.ready && ffmpeg.ready)
    const result: PersonalWechatVoiceEncodingEnvironment = {
      state: ready ? 'ready' : 'incomplete',
      ready,
      checkedAt: this.now().toISOString(),
      runtimeReady: Boolean(runtime),
      ...(runtime ? { runtimeRoot: runtime.root } : {}),
      python,
      pilk,
      ffmpeg,
      encoder: pilk.ready
        ? 'pilk'
        : runtime && python.ready && ffmpeg.ready
          ? 'go-silk'
          : 'unavailable',
      message: ready
        ? '语音编码环境正常，可以使用 pilk 编码'
        : runtime
          ? '语音编码环境不完整，OneBot 可能回退到 go-silk'
          : '微信发送组件尚未安装，请先准备 OneBot 运行时'
    }
    logEnvironmentLine(
      ready ? 'Voice encoding environment is ready' : 'Voice encoding environment is NOT ready',
      { runtimeReady: result.runtimeReady, encoder: result.encoder }
    )
    logEnvironmentLine(`Encoder: ${result.encoder}`)
    return result
  }

  async installPilk(): Promise<PersonalWechatVoiceEncodingEnvironmentResult> {
    const before = await this.check()
    const pythonExecutable = before.python.executable
    if (!before.python.ready || !pythonExecutable) {
      return {
        success: false,
        environment: before,
        error: '未找到 TraceMemo 实际使用的 Python，无法安装 pilk'
      }
    }

    logEnvironmentLine(`Installing pilk ${PERSONAL_WECHAT_PILK_VERSION}`, {
      python: pythonExecutable
    })
    try {
      await this.runCommand(
        pythonExecutable,
        ['-m', 'pip', 'install', '--user', `pilk==${PERSONAL_WECHAT_PILK_VERSION}`],
        {
          env: this.buildEnvironment(before.runtimeRoot || undefined),
          timeout: INSTALL_TIMEOUT_MS
        }
      )
    } catch (error) {
      const message = commandError(error)
      logEnvironmentWarning('pilk installation failed', { error: message })
      return {
        success: false,
        environment: await this.check(),
        error: `pilk 安装失败：${message}`
      }
    }

    const after = await this.check()
    if (!after.pilk.ready) {
      const message = after.pilk.error || '安装后仍无法 import pilk'
      logEnvironmentWarning('pilk installation did not produce a usable module', {
        error: message
      })
      return { success: false, environment: after, error: message }
    }
    return { success: true, environment: after }
  }
}

export const personalWechatVoiceEnvironmentService = new PersonalWechatVoiceEnvironmentService()
