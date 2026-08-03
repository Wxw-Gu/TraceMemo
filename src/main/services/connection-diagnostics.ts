import { execFile } from 'child_process'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { isUsableDbRoot } from './settings-store'

const execFileAsync = promisify(execFile)

const platformLabel = (): string => {
  if (process.platform === 'win32') return `Windows ${os.release()} (${process.arch})`
  if (process.platform === 'darwin') return `macOS ${os.release()} (${process.arch})`
  return `${process.platform} ${os.release()} (${process.arch})`
}

async function detectWindowsWechatVersion(): Promise<string> {
  const script = [
    '$process = Get-Process Weixin,WeChat -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1',
    '$candidate = if ($process) { $process.Path } else {',
    "  @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'Tencent\\WeChat\\WeChat.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1",
    '}',
    'if ($candidate) { (Get-Item -LiteralPath $candidate).VersionInfo.ProductVersion }'
  ].join('; ')
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 3000, windowsHide: true }
    )
    return stdout.trim() || '未检测到'
  } catch {
    return '未检测到'
  }
}

async function detectMacWechatVersion(): Promise<string> {
  const candidates = [
    '/Applications/WeChat.app/Contents/Info',
    path.join(os.homedir(), 'Applications/WeChat.app/Contents/Info')
  ]
  for (const candidate of candidates) {
    if (!fs.existsSync(`${candidate}.plist`)) continue
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/defaults',
        ['read', candidate, 'CFBundleShortVersionString'],
        { timeout: 3000 }
      )
      if (stdout.trim()) return stdout.trim()
    } catch {
      // Continue to the next known installation location.
    }
  }
  return '未检测到'
}

export async function detectWechatVersion(): Promise<string> {
  if (process.platform === 'win32') return detectWindowsWechatVersion()
  if (process.platform === 'darwin') return detectMacWechatVersion()
  return '未检测到'
}

export function detectDataStructureVersion(dbRoot: string): string {
  return isUsableDbRoot(dbRoot) ? '微信 4.x（WCDB）' : '未检测到'
}

export function getOsVersionLabel(): string {
  return platformLabel()
}
