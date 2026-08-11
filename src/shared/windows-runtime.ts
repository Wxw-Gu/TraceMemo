export const WINDOWS_VC_RUNTIME_DOWNLOAD_URL = 'https://aka.ms/vc14/vc_redist.x64.exe'

export const WINDOWS_VC_RUNTIME_ERROR_MESSAGE = `当前 Windows 缺少 Microsoft Visual C++ 2015-2022 x64 运行库，无法加载微信数据库组件。请下载安装后重新启动 TraceMemo：${WINDOWS_VC_RUNTIME_DOWNLOAD_URL}`

const VC_RUNTIME_LIBRARY_PATTERN =
  /(?:vcruntime140(?:_1)?\.dll|msvcp140(?:_[12])?\.dll|concrt140\.dll|ucrtbase\.dll|api-ms-win-crt)/i
const WINDOWS_DEPENDENCY_LOAD_PATTERN =
  /(?:the specified module could not be found|找不到指定的模块|找不到指定模块|win32 error\s*126|error\s*126|err_dlopen_failed)/i

export function isWindowsVcRuntimeMissingError(detail: string, platform: string): boolean {
  if (platform !== 'win32') return false
  return VC_RUNTIME_LIBRARY_PATTERN.test(detail) || WINDOWS_DEPENDENCY_LOAD_PATTERN.test(detail)
}
