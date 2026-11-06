/**
 * macOS 硬件架构与密钥流程的判定规则。
 *
 * 三个概念必须分开，混用会把 Apple Silicon 上的 x64 运行时当成 Intel 机器：
 *
 *   - hardwareArch          CPU 实际架构，来自 `hw.optional.arm64`
 *   - runtimeArch           当前 Electron 可执行文件的架构（`process.arch`）
 *   - underARM64Translation 该进程是否被 Rosetta 翻译
 *
 * 密钥流程只能由这三者共同决定；原生库加载仍然只看 runtimeArch，
 * 因为同一进程内不能混用 arm64 与 x86_64 代码。
 */
export type MacHardwareArch = 'arm64' | 'x64' | 'unknown'

export type MacKeyFlow = 'apple-silicon' | 'intel' | 'arch-mismatch' | 'unsupported'

export interface MacArchSnapshot {
  platform: NodeJS.Platform
  hardwareArch: MacHardwareArch
  runtimeArch: string
  underARM64Translation: boolean
  macKeyFlow: MacKeyFlow
  /** 检测到的矛盾信号，仅用于诊断上报，不参与流程选择。 */
  anomalies: string[]
}

export interface MacArchInput {
  platform: NodeJS.Platform
  hardwareArch: MacHardwareArch
  runtimeArch: string
  underARM64Translation: boolean
}

export const ARCH_MISMATCH_X64_ON_ARM_ERROR =
  '当前 Mac 使用 Apple 芯片，但 TraceMemo 正在运行 Intel 版本。请安装 Apple Silicon（arm64）版本后重试。'

/**
 * 判定顺序有约束，不能调整：
 *
 * 1. 转译标志排在 sysctl 之前 —— 它由内核按当前进程直接给出，比一次外部命令更可信。
 *    即使 sysctl 失败（hardwareArch 为 unknown），只要进程被翻译且运行 x64，
 *    硬件就必然是 Apple 芯片，必须拦下。
 * 2. 硬件明确为 arm64 时，即使转译标志缺失，也不能走 Intel 流程 ——
 *    那等于在 Apple 芯片上装 Intel 运行环境。
 * 3. 只有硬件为 x64 或无法确认、且未经转译的 x64 进程，才允许走 Intel 流程。
 *    无法确认时保留兼容路径，避免无故阻断真正的 Intel Mac。
 */
export function resolveMacKeyFlow(input: MacArchInput): MacKeyFlow {
  if (input.platform !== 'darwin') return 'unsupported'
  if (input.runtimeArch === 'arm64') return 'apple-silicon'
  if (input.runtimeArch !== 'x64') return 'unsupported'
  if (input.underARM64Translation) return 'arch-mismatch'
  if (input.hardwareArch === 'arm64') return 'arch-mismatch'
  return 'intel'
}

/**
 * Intel 运行环境探测要起一个 x86 子进程，只在真正的 Intel Mac 上才有意义。
 * 其它流程（尤其 `arch-mismatch`）一律跳过，避免刷新连接页就拉起错误的 helper。
 */
export function shouldProbeIntelEnvironment(flow: MacKeyFlow): boolean {
  return flow === 'intel'
}

export function buildMacArchSnapshot(input: MacArchInput): MacArchSnapshot {
  const anomalies: string[] = []
  if (input.hardwareArch === 'unknown') anomalies.push('hardware_arch_unknown')
  if (input.runtimeArch === 'arm64' && input.underARM64Translation) {
    anomalies.push('translation_flag_with_native_arm64')
  }
  if (input.runtimeArch === 'x64' && input.hardwareArch === 'arm64' && !input.underARM64Translation) {
    // 硬件是 ARM、进程是 x64、却无转译标志：信号矛盾。流程仍按 arch-mismatch，
    // 这个名字只用于诊断，不参与判定。
    anomalies.push('x64_runtime_on_arm_without_translation_flag')
  }
  if (input.runtimeArch === 'x64' && input.underARM64Translation && input.hardwareArch !== 'arm64') {
    anomalies.push('translation_flag_without_arm_hardware')
  }
  return { ...input, macKeyFlow: resolveMacKeyFlow(input), anomalies }
}
