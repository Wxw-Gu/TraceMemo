import { createRequire } from 'module'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

const nodeRequire = createRequire(import.meta.url)
const { findNestedMacosCodePaths, signMacosAppBundle } = nodeRequire(
  '../../scripts/after-pack.cjs'
) as {
  findNestedMacosCodePaths: (appBundlePath: string) => string[]
  signMacosAppBundle: (appBundlePath: string, run?: (args: string[]) => void) => string
}

const root = mkdtempSync(join(tmpdir(), 'wxe-after-pack-sign-'))

/** 最小可用的 64 位 thin Mach-O 头，足以让 readBinaryArchitectures 判出 x64。 */
function macho(): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeUInt32LE(0x01000007, 4)
  return buffer
}

function file(...segments: string[]): string {
  const target = join(root, ...segments)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, macho())
  return target
}

/** 复刻 Electron 43.1.0 darwin-x64 的未签名 bundle 形状。 */
function fixtureApp(): string {
  const app = join(root, 'TraceMemo.app')
  file('TraceMemo.app', 'Contents', 'MacOS', 'TraceMemo')
  file('TraceMemo.app', 'Contents', 'Frameworks', 'Mantle.framework', 'Versions', 'A', 'Mantle')
  file(
    'TraceMemo.app',
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Electron Framework'
  )
  file(
    'TraceMemo.app',
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Libraries',
    'libffmpeg.dylib'
  )
  file(
    'TraceMemo.app',
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Helpers',
    'chrome_crashpad_handler'
  )
  file('TraceMemo.app', 'Contents', 'Frameworks', 'Helper.app', 'Contents', 'MacOS', 'Helper')
  // framework 内指向 Versions/A 的符号链接：真实文件在更深层级被走到，这里要跳过。
  symlinkSync(
    'A',
    join(
      root,
      'TraceMemo.app',
      'Contents',
      'Frameworks',
      'Mantle.framework',
      'Versions',
      'Current'
    ),
    'dir'
  )
  // Contents/Resources 下的原生文件不是「嵌套代码」，不参与签名。
  file(
    'TraceMemo.app',
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'sherpa-onnx-darwin-x64',
    'sherpa-onnx.node'
  )
  // 非原生文件必须被忽略。
  writeFileSync(join(root, 'TraceMemo.app', 'Contents', 'Frameworks', 'README.md'), 'not a binary')
  return app
}

const app = fixtureApp()
const relative = (target: string): string => target.slice(app.length + 1)

describe('macOS nested code signing order', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('signs nested code inside-out and ignores resources and symlinks', () => {
    const paths = findNestedMacosCodePaths(app).map(relative)

    expect(paths).toContain(join('Contents', 'MacOS', 'TraceMemo'))
    expect(paths).not.toContain(app)
    expect(paths.some((entry) => entry.includes('Resources'))).toBe(false)
    expect(paths.some((entry) => entry.endsWith('.md'))).toBe(false)
    expect(paths.some((entry) => entry.includes('Versions/Current'))).toBe(false)

    const index = (needle: string): number => paths.indexOf(needle)
    const handler =
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler'
    const frameworkBinary =
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
    const framework = 'Contents/Frameworks/Electron Framework.framework'
    const helperBinary = 'Contents/Frameworks/Helper.app/Contents/MacOS/Helper'
    const helperApp = 'Contents/Frameworks/Helper.app'

    expect(index(handler)).toBeGreaterThanOrEqual(0)
    // 内层可执行文件先于其所属 bundle，helper 的可执行文件先于 helper app。
    expect(index(handler)).toBeLessThan(index(framework))
    expect(index(frameworkBinary)).toBeLessThan(index(framework))
    expect(index(helperBinary)).toBeLessThan(index(helperApp))
    // 最深的目标排在最前。
    expect(paths[0]).toBe(handler)
  })

  it('re-signs the app bundle after every nested target', () => {
    const calls: string[][] = []
    let verifyCalls = 0
    const run = (args: string[]): void => {
      if (args[0] === '--verify') {
        verifyCalls += 1
        // 未签名来源包：外层首次校验必然失败，补签之后才允许通过。
        if (verifyCalls === 1) throw new Error('code object is not signed at all')
        return
      }
      calls.push(args)
    }

    signMacosAppBundle(app, run)

    const signed = calls.map((args) => args[args.length - 1])
    expect(signed[signed.length - 1]).toBe(app)
    expect(signed.slice(0, -1)).toEqual(findNestedMacosCodePaths(app))
    expect(verifyCalls).toBe(2)
  })

  it('leaves an already valid bundle untouched', () => {
    const calls: string[][] = []
    const run = (args: string[]): void => {
      calls.push(args)
    }

    signMacosAppBundle(app, run)

    // 只有首次 --verify，没有任何 --sign。
    expect(calls).toEqual([['--verify', '--strict', app]])
  })
})
