import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { ZipArchive } from 'archiver'
import { renderExportPage } from '../../src/main/export-html-template'
import type { Message } from '../../src/shared/types'

const archiveMessage = (
  id: string,
  conversationId: string,
  conversationName: string,
  content: string,
  createTime: number
): Message => ({
  id,
  from: 'user',
  type: '普通文本',
  datetime: '',
  content,
  isSender: false,
  name: '脱敏成员',
  createTime,
  exportConversationId: conversationId,
  exportConversationName: conversationName
})

const zipDirectory = async (
  sourceDir: string,
  zipPath: string,
  folderName: string
): Promise<void> => {
  const output = createWriteStream(zipPath)
  const archive = new ZipArchive({ zlib: { level: 6 } })
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.directory(sourceDir, folderName)
    void archive.finalize().catch(reject)
  })
}

test('EXPORT-ARCHIVE-01 merged v2 archive is usable offline on desktop and mobile', async ({
  page
}, testInfo) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'wxe-merged-archive-e2e-'))
  const outputDir = join(fixtureRoot, 'source')
  try {
    const dataPath = join(outputDir, 'data', 'messages.js')
    mkdirSync(dirname(dataPath), { recursive: true })
    writeFileSync(join(outputDir, 'index.html'), renderExportPage('合并聊天档案'), 'utf8')
    writeFileSync(
      dataPath,
      `window.__WECHAT_EXPORT__ = ${JSON.stringify({
        version: 2,
        name: '合并聊天档案',
        exportedAt: '2026-08-04T00:00:00.000Z',
        conversations: [
          { id: 'alpha', name: '项目群', type: 'group', messageCount: 2 },
          { id: 'beta', name: '文件传输助手', type: 'user', messageCount: 1 }
        ],
        messages: [
          archiveMessage('alpha-1', 'alpha', '项目群', '项目群第一条', 1_764_547_200),
          archiveMessage('beta-1', 'beta', '文件传输助手', '个人聊天消息', 1_769_904_000),
          archiveMessage('alpha-2', 'alpha', '项目群', '项目群第二条', 1_769_990_400)
        ]
      })};\n`,
      'utf8'
    )
    const zipPath = join(fixtureRoot, 'merged-archive.zip')
    const extractedDir = join(fixtureRoot, 'extracted')
    await zipDirectory(outputDir, zipPath, '合并聊天档案')
    mkdirSync(extractedDir, { recursive: true })
    execFileSync('unzip', ['-q', zipPath, '-d', extractedDir])
    const offlineIndex = join(extractedDir, '合并聊天档案', 'index.html')

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(pathToFileURL(offlineIndex).href)
    const conversationSelect = page.getByLabel('筛选聊天')
    await expect(conversationSelect).toHaveValue('all')
    await expect(conversationSelect.locator('option')).toHaveCount(3)
    await expect(page.locator('#archive-title')).toBeHidden()
    await expect(page.locator('.archive-heading #conversation-filter')).toBeVisible()
    await expect(page.locator('#archive-meta')).toHaveText(/^更新于 /)
    await expect(page.locator('#archive-meta')).not.toContainText('条消息')
    await expect(page.locator('.message')).toHaveCount(3)
    await expect(page.locator('.conversation-source')).toHaveCount(3)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('merged-archive-1440.png'), fullPage: true })

    await conversationSelect.selectOption('beta')
    await expect(page.locator('.message')).toHaveCount(1)
    await expect(page.locator('.conversation-source')).toHaveCount(0)

    await conversationSelect.selectOption('all')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('.timeline-year')).toHaveCount(2)
    await expect(page.locator('.timeline-year').first()).toBeVisible()
    await expect(page.locator('.timeline-year').first()).toHaveText('2025 年')
    const positions = await page.evaluate(() => {
      const conversations = document.querySelector('#conversation-filter')!.getBoundingClientRect()
      const toolbar = document.querySelector('.toolbar')!.getBoundingClientRect()
      const timeline = document.querySelector('#timeline')!.getBoundingClientRect()
      return {
        conversationTop: conversations.top,
        conversationBottom: conversations.bottom,
        toolbarTop: toolbar.top,
        toolbarBottom: toolbar.bottom,
        timelineTop: timeline.top,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
      }
    })
    expect(positions.conversationTop).toBeGreaterThanOrEqual(positions.toolbarTop)
    expect(positions.conversationBottom).toBeLessThanOrEqual(positions.toolbarBottom)
    expect(positions.timelineTop).toBeGreaterThanOrEqual(positions.toolbarBottom)
    expect(positions.documentWidth).toBeLessThanOrEqual(positions.viewportWidth)
    await expect(page.locator('.message')).toHaveCount(3)
    await page.screenshot({ path: testInfo.outputPath('merged-archive-390.png'), fullPage: true })
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('EXPORT-ARCHIVE-02 legacy single-chat archive keeps its original layout', async ({
  page
}, testInfo) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'wxe-single-archive-e2e-'))
  try {
    const dataPath = join(outputDir, 'data', 'messages.js')
    mkdirSync(dirname(dataPath), { recursive: true })
    writeFileSync(join(outputDir, 'index.html'), renderExportPage('单聊天档案'), 'utf8')
    writeFileSync(
      dataPath,
      `window.__WECHAT_EXPORT__ = ${JSON.stringify({
        version: 1,
        sourceId: 'single',
        name: '单聊天档案',
        exportedAt: '2026-08-04T00:00:00.000Z',
        messages: [archiveMessage('single-1', 'single', '单聊天档案', '单聊天消息', 1_767_225_600)]
      })};\n`,
      'utf8'
    )

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(pathToFileURL(join(outputDir, 'index.html')).href)
    await expect(page.locator('#conversation-filter')).toBeHidden()
    await expect(page.locator('#archive-title')).toBeVisible()
    await expect(page.locator('#archive-title')).toHaveText('单聊天档案')
    await expect(page.locator('#archive-meta')).toContainText('1 条消息 · 更新于 ')
    await expect(page.locator('.archive-layout')).toHaveClass(/single-conversation/)
    await expect(page.locator('.message')).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('single-archive-1440.png'), fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await expect(page.locator('.message')).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('single-archive-390.png'), fullPage: true })
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})
