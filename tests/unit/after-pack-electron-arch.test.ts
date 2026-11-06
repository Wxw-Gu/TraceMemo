import { createRequire } from 'module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

const nodeRequire = createRequire(import.meta.url)
const { validateElectronMainBinary } = nodeRequire('../../scripts/after-pack.cjs') as {
  validateElectronMainBinary: (
    appOutDir: string,
    productName: string,
    platform: string,
    arch: string
  ) => void
}

const root = mkdtempSync(join(tmpdir(), 'tm-electron-arch-'))

/** 最小 64 位 Mach-O 头；cputype 决定被判成哪种架构。 */
function macho(cpuType: number): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeUInt32LE(cpuType, 4)
  return buffer
}

const CPU_X86_64 = 0x01000007
const CPU_ARM64 = 0x0100000c

function bundle(name: string, binary: Buffer | string): { appOutDir: string; productName: string } {
  const appOutDir = join(root, name)
  const macosDir = join(appOutDir, 'TraceMemo.app', 'Contents', 'MacOS')
  mkdirSync(macosDir, { recursive: true })
  writeFileSync(join(macosDir, 'TraceMemo'), binary)
  return { appOutDir, productName: 'TraceMemo' }
}

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('validateElectronMainBinary', () => {
  it('accepts an arm64 main binary for an arm64 bundle', () => {
    const context = bundle('arm64-ok', macho(CPU_ARM64))
    expect(() =>
      validateElectronMainBinary(context.appOutDir, context.productName, 'darwin', 'arm64')
    ).not.toThrow()
  })

  it('rejects an x64 Electron binary in an arm64 bundle', () => {
    const context = bundle('arm64-with-x64', macho(CPU_X86_64))
    expect(() =>
      validateElectronMainBinary(context.appOutDir, context.productName, 'darwin', 'arm64')
    ).toThrow(/is x64 but this bundle targets arm64/)
  })

  it('accepts either slice for a universal bundle', () => {
    const context = bundle('universal', macho(CPU_X86_64))
    expect(() =>
      validateElectronMainBinary(context.appOutDir, context.productName, 'darwin', 'universal')
    ).not.toThrow()
  })

  it('fails when the main binary is missing', () => {
    const appOutDir = join(root, 'missing')
    mkdirSync(join(appOutDir, 'TraceMemo.app', 'Contents', 'MacOS'), { recursive: true })
    expect(() =>
      validateElectronMainBinary(appOutDir, 'TraceMemo', 'darwin', 'arm64')
    ).toThrow(/Missing Electron main binary/)
  })

  it('fails when the main binary is not a Mach-O executable', () => {
    const context = bundle('not-macho', '#!/bin/sh\necho hi\n')
    expect(() =>
      validateElectronMainBinary(context.appOutDir, context.productName, 'darwin', 'arm64')
    ).toThrow(/not a Mach-O executable/)
  })

  it('ignores non-darwin targets', () => {
    expect(() =>
      validateElectronMainBinary(join(root, 'nowhere'), 'TraceMemo', 'win32', 'x64')
    ).not.toThrow()
  })
})
