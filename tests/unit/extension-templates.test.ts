import { createRequire } from 'node:module'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Open } from 'unzipper'
import { createExtensionPaths } from '../../src/main/extensions/extension-paths'
import { ExtensionRegistry } from '../../src/main/extensions/extension-registry'
import { ExtensionInstaller } from '../../src/main/extensions/extension-installer'

const require = createRequire(import.meta.url)
const {
  buildTemplates
}: {
  buildTemplates: (options?: Record<string, unknown>) => {
    templates: Array<{ templateId: string; version: string; sha256: string; file: string }>
    warnings: string[]
  }
} = require('../../scripts/build-extension-templates.cjs')

const roots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-templates-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
})

/** 复制真实的 examples 到临时目录，避免测试写仓库里的 lock 文件。 */
function stageExamples(): { sourceRoot: string; lockFile: string } {
  const root = tempRoot()
  const sourceRoot = path.join(root, 'examples')
  fs.copySync(path.join(process.cwd(), 'examples/extensions'), sourceRoot)
  return { sourceRoot, lockFile: path.join(root, 'template-lock.json') }
}

describe('官方模板构建', () => {
  it('产出三个模板与索引，索引指向真实文件', () => {
    const { sourceRoot, lockFile } = stageExamples()
    const outputDir = path.join(tempRoot(), 'out')
    const result = buildTemplates({ sourceRoot, outputDir, lockFile })

    expect(result.templates.map((item) => item.templateId).sort()).toEqual([
      'douyin-sender',
      'group-chat-bot',
      'keyword-bot'
    ])
    const index = fs.readJsonSync(path.join(outputDir, 'index.json'))
    expect(index.version).toBe(1)
    expect(index.templates).toHaveLength(3)
    for (const template of index.templates) {
      expect(fs.existsSync(path.join(outputDir, template.file))).toBe(true)
      expect(template.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('两次构建字节一致（确定性 ZIP）', () => {
    const { sourceRoot, lockFile } = stageExamples()
    const first = buildTemplates({ sourceRoot, outputDir: path.join(tempRoot(), 'a'), lockFile })
    const second = buildTemplates({ sourceRoot, outputDir: path.join(tempRoot(), 'b'), lockFile })
    expect(second.templates.map((item) => item.sha256)).toEqual(
      first.templates.map((item) => item.sha256)
    )
  })

  it('私有脚本与缓存文件不会进入发布包', async () => {
    const { sourceRoot, lockFile } = stageExamples()
    // 模拟开发者本机存在被 gitignore 的私有脚本与缓存。
    const privateScript = path.join(sourceRoot, 'douyin-sender/scripts/douyin.py')
    fs.ensureDirSync(path.dirname(privateScript))
    fs.writeFileSync(privateScript, '# private')
    fs.ensureDirSync(path.join(sourceRoot, 'douyin-sender/scripts/__pycache__'))
    fs.writeFileSync(path.join(sourceRoot, 'douyin-sender/scripts/__pycache__/x.pyc'), 'x')
    fs.writeFileSync(path.join(sourceRoot, 'keyword-bot/.DS_Store'), 'x')

    const outputDir = path.join(tempRoot(), 'out')
    buildTemplates({ sourceRoot, outputDir, lockFile })
    const zipPath = path.join(outputDir, 'douyin-sender-1.0.5.zip')
    const archive = await Open.file(zipPath)
    const names = archive.files.map((file) => file.path)
    expect(names).not.toContain('scripts/douyin.py')
    expect(names.some((name) => name.includes('__pycache__'))).toBe(false)

    const keyword = await Open.file(path.join(outputDir, 'keyword-bot-1.0.1.zip'))
    expect(keyword.files.map((file) => file.path)).not.toContain('.DS_Store')
  })

  it('入口文件缺失时构建失败', () => {
    const { sourceRoot, lockFile } = stageExamples()
    fs.removeSync(path.join(sourceRoot, 'keyword-bot/background/index.js'))
    expect(() =>
      buildTemplates({ sourceRoot, outputDir: path.join(tempRoot(), 'out'), lockFile })
    ).toThrowError(/入口|不存在/)
  })

  it('同版本内容变化被拒绝，升版本后放行', () => {
    const { sourceRoot, lockFile } = stageExamples()
    const outputDir = path.join(tempRoot(), 'out')
    buildTemplates({ sourceRoot, outputDir, lockFile })

    // 改动内容但不升版本。
    const manifestPath = path.join(sourceRoot, 'keyword-bot/manifest.json')
    const manifest = fs.readJsonSync(manifestPath)
    fs.writeJsonSync(manifestPath, { ...manifest, description: '改了一句话' })
    expect(() => buildTemplates({ sourceRoot, outputDir, lockFile })).toThrowError(/内容已变化/)

    // 升版本后放行。
    fs.writeJsonSync(manifestPath, { ...manifest, description: '改了一句话', version: '1.0.2' })
    const result = buildTemplates({ sourceRoot, outputDir, lockFile })
    expect(result.templates.some((item) => item.version === '1.0.2')).toBe(true)
  })

  it('产物 ZIP 能被现有安装器直接安装', async () => {
    const { sourceRoot, lockFile } = stageExamples()
    const outputDir = path.join(tempRoot(), 'out')
    buildTemplates({ sourceRoot, outputDir, lockFile })

    const userData = tempRoot()
    const paths = createExtensionPaths(userData)
    const registry = new ExtensionRegistry({ registryFile: paths.registryFile })
    const installer = new ExtensionInstaller({ paths, registry })

    const zipPath = path.join(outputDir, 'keyword-bot-1.0.1.zip')
    const outcome = await installer.installFromPackage(zipPath, {
      appVersion: '2.6.0',
      source: 'template',
      template: { id: 'keyword-bot', version: '1.0.1' }
    })

    expect(outcome.manifest.id).toBe('com.example.keyword-bot')
    expect(outcome.upgraded).toBe(false)
    const record = registry.get('com.example.keyword-bot')
    expect(record?.source).toBe('template')
    expect(record?.templateId).toBe('keyword-bot')
    expect(record?.templateVersion).toBe('1.0.1')
    // 安装不等于启用。
    expect(record?.enabled).toBe(false)
    expect(
      fs.existsSync(path.join(paths.installDir('com.example.keyword-bot'), 'ui/index.html'))
    ).toBe(true)
  })
})
