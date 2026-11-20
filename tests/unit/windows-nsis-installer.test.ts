import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

describe('Windows NSIS installer configuration', () => {
  it('wires build/installer.nsh in electron-builder configs', () => {
    const winConfig = readFileSync(path.join(ROOT, 'electron-builder.win.yml'), 'utf8')
    const baseConfig = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')

    expect(winConfig).toContain('include: build/installer.nsh')
    expect(baseConfig).toContain('include: build/installer.nsh')
    expect(existsSync(path.join(ROOT, 'build', 'installer.nsh'))).toBe(true)
  })

  it('kills process trees and handles cross-drive updates in build/installer.nsh', () => {
    const script = readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8')

    expect(script).toContain('!macro customCheckAppRunning')
    expect(script).toContain('taskkill /f /t /im')
    expect(script).toContain('find.exe" /I')
    expect(script).toContain('Function tmPrepareCrossDriveUpdateTemp')
    expect(script).toContain('Function tmRestoreCrossDriveUpdateTemp')
    expect(script).toContain('!macro customInstall')
    expect(script).toContain('!macro customRemoveFiles')
    expect(script).toContain('un.tmAtomicMoveToBackup')
    expect(script).toContain('un.tmRestoreFromBackup')
  })
})
