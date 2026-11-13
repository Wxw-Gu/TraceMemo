import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseExtensionManifest } from '../../src/shared/extensions/manifest'

const EXAMPLES_ROOT = path.resolve(process.cwd(), 'examples/extensions')

function exampleDirectories(): string[] {
  return fs
    .readdirSync(EXAMPLES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * 示例扩展是文档的一部分：manifest 失配或入口文件缺失时必须在这里失败，
 * 而不是等用户点「安装目录」才看到错误。
 */
describe('example extensions', () => {
  it('每个示例都有合法 manifest 与真实入口文件', () => {
    const directories = exampleDirectories()
    expect(directories.length).toBeGreaterThanOrEqual(2)
    for (const directory of directories) {
      const root = path.join(EXAMPLES_ROOT, directory)
      const manifestPath = path.join(root, 'manifest.json')
      expect(fs.existsSync(manifestPath), `${directory} 缺少 manifest.json`).toBe(true)
      const parsed = parseExtensionManifest(
        JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown,
        { appVersion: '2.6.0' }
      )
      expect(parsed.ok, `${directory}: ${parsed.message || ''}`).toBe(true)
      const manifest = parsed.manifest
      if (!manifest) throw new Error(`${directory} manifest 未解析`)
      for (const [key, entry] of Object.entries(manifest.entrypoints)) {
        if (!entry) continue
        expect(fs.existsSync(path.join(root, entry)), `${directory} 缺少 ${key}: ${entry}`).toBe(true)
      }
      for (const page of manifest.contributions.pages) {
        const entry = page.entry || manifest.entrypoints.page
        expect(Boolean(entry), `${directory} 页面 ${page.id} 缺少入口`).toBe(true)
        if (entry) expect(fs.existsSync(path.join(root, entry))).toBe(true)
      }
    }
  })
})
