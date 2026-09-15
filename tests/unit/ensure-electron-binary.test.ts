import { createRequire } from 'module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

const nodeRequire = createRequire(import.meta.url)
const { isElectronBinaryInstalled } = nodeRequire('../../scripts/ensure-electron-binary.cjs') as {
  isElectronBinaryInstalled: (packageRoot: string) => boolean
}

const root = mkdtempSync(join(tmpdir(), 'wxe-electron-binary-'))

function fixture(name: string, pathTxt: string | null, executable: string | null): string {
  const packageRoot = join(root, name)
  mkdirSync(packageRoot, { recursive: true })
  if (pathTxt !== null) writeFileSync(join(packageRoot, 'path.txt'), pathTxt)
  if (executable !== null) {
    const file = join(packageRoot, 'dist', executable)
    mkdirSync(join(packageRoot, 'dist', ...executable.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(file, 'fixture')
  }
  return packageRoot
}

describe('electron binary readiness', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('treats an empty shell as not installed', () => {
    // electron@43 ships no postinstall hook, so pnpm install leaves exactly this.
    expect(isElectronBinaryInstalled(fixture('empty-shell', null, null))).toBe(false)
  })

  it('does not trust path.txt when the executable is missing', () => {
    const packageRoot = fixture('half-installed', 'Electron.app/Contents/MacOS/Electron', null)
    expect(isElectronBinaryInstalled(packageRoot)).toBe(false)
  })

  it('accepts a completed install', () => {
    const packageRoot = fixture(
      'installed',
      'Electron.app/Contents/MacOS/Electron',
      'Electron.app/Contents/MacOS/Electron'
    )
    expect(isElectronBinaryInstalled(packageRoot)).toBe(true)
  })

  it('rejects blank paths and missing package roots', () => {
    expect(isElectronBinaryInstalled(fixture('blank-path', '   ', 'Electron'))).toBe(false)
    expect(isElectronBinaryInstalled('')).toBe(false)
    expect(isElectronBinaryInstalled(join(root, 'does-not-exist'))).toBe(false)
  })
})
