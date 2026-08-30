export type RuntimePlatform = NodeJS.Platform | 'unknown'

function detectRuntimePlatform(): RuntimePlatform {
  if (typeof window === 'undefined') return 'unknown'
  return (window.electron?.process?.platform as NodeJS.Platform | undefined) || 'unknown'
}

export const runtimePlatform = detectRuntimePlatform()
export const isMac = runtimePlatform === 'darwin'
export const isWindows = runtimePlatform === 'win32'

export const supportsPersonalWechatSend = isMac || isWindows
