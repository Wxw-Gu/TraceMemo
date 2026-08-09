import { describe, expect, it } from 'vitest'
import {
  isWindowsVcRuntimeMissingError,
  WINDOWS_VC_RUNTIME_DOWNLOAD_URL,
  WINDOWS_VC_RUNTIME_ERROR_MESSAGE
} from '../../src/shared/windows-runtime'

describe('Windows Visual C++ runtime diagnostics', () => {
  it.each([
    'VCRUNTIME140_1.dll was not found',
    'MSVCP140.dll is missing',
    'The specified module could not be found',
    'Win32 error 126',
    '找不到指定的模块'
  ])('recognizes a Windows native dependency load failure: %s', (detail) => {
    expect(isWindowsVcRuntimeMissingError(detail, 'win32')).toBe(true)
  })

  it('does not relabel unrelated or non-Windows failures', () => {
    expect(isWindowsVcRuntimeMissingError('invalid database key', 'win32')).toBe(false)
    expect(isWindowsVcRuntimeMissingError('VCRUNTIME140.dll was not found', 'darwin')).toBe(false)
  })

  it('keeps the official download URL in the actionable error message', () => {
    expect(WINDOWS_VC_RUNTIME_ERROR_MESSAGE).toContain(WINDOWS_VC_RUNTIME_DOWNLOAD_URL)
  })
})
