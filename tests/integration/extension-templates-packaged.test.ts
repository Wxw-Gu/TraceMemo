import fs from 'fs-extra'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExtensionTemplateCatalog } from '../../src/main/extensions/extension-template-catalog'

/** 打包产物验证：只读 `Resources/extension-templates`，不碰源码树。 */
const CANDIDATES = [
  'dist/mac-arm64/TraceMemo.app/Contents/Resources/extension-templates',
  'dist/mac/TraceMemo.app/Contents/Resources/extension-templates',
  'dist/win-unpacked/resources/extension-templates',
  'dist/linux-unpacked/resources/extension-templates'
]

const packagedRoot = CANDIDATES.map((relative) => path.join(process.cwd(), relative)).find(
  (candidate) => fs.existsSync(path.join(candidate, 'index.json'))
)

describe.skipIf(!packagedRoot)('打包后的模板资源', () => {
  it('产物目录自带三个模板与索引', async () => {
    const catalog = new ExtensionTemplateCatalog({
      templateRoot: packagedRoot as string,
      getRecord: () => undefined,
      resolveInstallDir: (id) => path.join(process.cwd(), 'dist', 'unused', id),
      platform: process.platform,
      probePython: () => '/usr/bin/python3',
      probeChrome: () => '/usr/bin/chrome'
    })

    const list = await catalog.list()
    expect(list.map((item) => item.template.templateId).sort()).toEqual([
      'douyin-sender',
      'group-chat-bot',
      'keyword-bot'
    ])
    // 资源自包含：索引里的 zip 就在同一目录，且哈希匹配（damaged 会暴露不一致）。
    expect(list.every((item) => item.state !== 'damaged')).toBe(true)
  })

  it('产物里的 ZIP 能通过哈希校验', async () => {
    const catalog = new ExtensionTemplateCatalog({
      templateRoot: packagedRoot as string,
      getRecord: () => undefined,
      resolveInstallDir: (id) => path.join(process.cwd(), 'dist', 'unused', id),
      platform: process.platform,
      probePython: () => '/usr/bin/python3',
      probeChrome: () => '/usr/bin/chrome'
    })
    for (const templateId of ['keyword-bot', 'group-chat-bot', 'douyin-sender']) {
      const resolved = await catalog.resolveZip(templateId)
      expect(fs.existsSync(resolved.path)).toBe(true)
      expect(resolved.template.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })
})
