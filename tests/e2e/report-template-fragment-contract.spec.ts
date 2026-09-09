import { _electron as electron, chromium, expect, test } from '@playwright/test'
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ZipArchive } from 'archiver'

const fixture = JSON.parse(
  readFileSync(resolve('tests/fixtures/report-template-production-fragments.json'), 'utf8')
)

const makeZip = async (directory: string): Promise<string> => {
  const archivePath = join(directory, 'hostile-avatar-template.zip')
  const output = createWriteStream(archivePath)
  const archive = new ZipArchive({ zlib: { level: 6 } })
  archive.pipe(output)
  archive.append(
    JSON.stringify({
      protocolVersion: '1.0',
      kind: 'daily-report',
      id: 'community.github.example.fragment-contract',
      name: 'Production Fragment Contract 压力模板',
      author: { name: 'fixture' },
      templateVersion: '1.0.0',
      interfaceVersion: '1',
      entry: 'template.html',
      capture: { width: 1000, maxWidth: 1000, maxHeight: 20000 },
      license: { spdx: 'MIT' }
    }),
    { name: 'manifest.json' }
  )
  archive.append(
    `<!doctype html><html><head><style>
      *{box-sizing:border-box}html,body{margin:0;background:#f2f5f7;color:#102030;font-family:sans-serif}body{overflow-x:hidden}.report{max-width:1000px;margin:0 auto;padding:20px}.panel{margin:12px 0;padding:14px;border:1px solid #c9d4dd;border-radius:8px}.topics,.participants{display:flex;flex-wrap:wrap;gap:8px}.topic-card{min-width:0;flex:1 1 260px}.important-card,.chat-msg{padding:10px;border-top:1px solid #d8e0e6}.chat-bubble{padding:8px;background:#fff;max-width:100%}img{width:100%;height:auto}.empty-section{display:none!important}@media(max-width:680px){.report{padding:12px}.panel{padding:10px}}
    </style></head><body><main class="report"><header class="panel">{{HERO_AVATARS}}</header><section class="panel topics">{{TOPIC_CARDS}}</section><section class="panel">{{IMPORTANT_MESSAGES}}</section><section class="panel">{{QUOTE_BLOCKS}}</section><section class="panel">{{TODO_CARDS}}{{UNRESOLVED_CARDS}}</section><section class="panel">{{QA_CARDS}}</section><section class="panel">{{RANK_ITEMS}}</section></main></body></html>`,
    { name: 'template.html' }
  )
  await new Promise<void>((resolvePromise, reject) => {
    output.on('close', resolvePromise)
    output.on('error', reject)
    archive.on('error', reject)
    void archive.finalize().catch(reject)
  })
  return archivePath
}

test('REPORT-TEMPLATE-E2E-FRAGMENT-01 protects production avatars and text from hostile template CSS', async ({}, testInfo) => {
  const userData = mkdtempSync(join(tmpdir(), 'tracememo-fragment-contract-user-'))
  const outputDir = mkdtempSync(join(tmpdir(), 'tracememo-fragment-contract-output-'))
  const fixtureDir = mkdtempSync(join(tmpdir(), 'tracememo-fragment-contract-fixture-'))
  const launch = () =>
    electron.launch({
      args: [resolve('out/main/reportTemplateTest.js')],
      env: {
        ...process.env,
        TRACEMEMO_TEMPLATE_TEST_USER_DATA: userData,
        TRACEMEMO_REPORT_OUTPUT_DIR: outputDir
      }
    })
  let app = await launch()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const installed = await page.evaluate((packagePath) => window.api.installReportTemplate(packagePath), await makeZip(fixtureDir))
    expect(installed.success, installed.error).toBe(true)
    const exported = await page.evaluate(
      ({ metadata, report }) =>
        window.api.exportGroupReport({
          templateRef: { id: 'community.github.example.fragment-contract', version: '1.0.0' },
          metadata,
          report
        }),
      fixture
    )
    expect(exported.success, exported.error).toBe(true)
    expect(readFileSync(exported.htmlPath!, 'utf8')).toContain('tm-production-fragment-contract')
    expect(readFileSync(exported.htmlPath!, 'utf8')).toContain('tm-avatar--fallback')
    expect(readFileSync(exported.htmlPath!, 'utf8')).toContain('&lt;&gt;')
    expect(readFileSync(exported.pngPath!).length).toBeGreaterThan(1000)

    const browser = await chromium.launch({ headless: true })
    try {
      for (const viewportWidth of [1000, 430]) {
        const inspectPage = await browser.newPage({ viewport: { width: viewportWidth, height: 1200 }, deviceScaleFactor: 1 })
        const externalRequests: string[] = []
        const badResponses: string[] = []
        inspectPage.on('request', (request) => {
          if (/^https?:/i.test(request.url())) externalRequests.push(request.url())
        })
        inspectPage.on('response', (response) => {
          if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`)
        })
        await inspectPage.goto(pathToFileURL(exported.htmlPath!).href)
        await inspectPage.waitForFunction(() => Array.from(document.images).every((image) => image.complete))
        const metrics = await inspectPage.evaluate(() => {
          const rect = (element: Element) => {
            const box = element.getBoundingClientRect()
            return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
          }
          const overlaps = (first: ReturnType<typeof rect>, second: ReturnType<typeof rect>) =>
            first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top
          const avatars = Array.from(document.querySelectorAll('img.tm-avatar')).map((element) => {
            const box = rect(element)
            const parent = element.closest('.tm-message,.tm-participant,.tm-ranking-item,.tm-fragment,.report')
            return {
              classes: element.className,
              box,
              parent: parent ? rect(parent) : null,
              display: getComputedStyle(element).display,
              objectFit: getComputedStyle(element).objectFit
            }
          })
          const messages = Array.from(document.querySelectorAll('.tm-message')).map((element) => {
            const avatar = element.querySelector('img.tm-avatar')
            const body = element.querySelector('.tm-message__body')
            const author = element.querySelector('.tm-message__author')
            const timestamp = element.querySelector('.tm-message__time')
            return {
              message: rect(element),
              avatar: avatar ? rect(avatar) : null,
              body: body ? rect(body) : null,
              author: author ? rect(author) : null,
              timestamp: timestamp ? rect(timestamp) : null,
              authorTimestampOverlap: author && timestamp ? overlaps(rect(author), rect(timestamp)) : false
            }
          })
          return {
            scrollWidth: document.documentElement.scrollWidth,
            imageFailures: Array.from(document.images).filter((image) => image.naturalWidth === 0).length,
            avatars,
            messages,
            fallbackCount: document.querySelectorAll('.tm-avatar--fallback').length
          }
        })
        expect(metrics.scrollWidth).toBeLessThanOrEqual(viewportWidth + 1)
        expect(metrics.imageFailures).toBe(0)
        expect(metrics.fallbackCount).toBeGreaterThanOrEqual(4)
        for (const avatar of metrics.avatars) {
          expect(avatar.display).not.toBe('none')
          expect(avatar.objectFit).toBe('cover')
          expect(avatar.box.width).toBeGreaterThan(0)
          expect(avatar.box.height).toBeGreaterThan(0)
          expect(Math.abs(avatar.box.width - avatar.box.height)).toBeLessThanOrEqual(1)
          if (avatar.classes.includes('tm-avatar--message')) {
            expect(avatar.box.width).toBeGreaterThanOrEqual(28)
            expect(avatar.box.width).toBeLessThanOrEqual(44)
          }
          if (avatar.classes.includes('tm-avatar--participant')) {
            expect(avatar.box.width).toBeGreaterThanOrEqual(18)
            expect(avatar.box.width).toBeLessThanOrEqual(28)
          }
          expect(avatar.parent).not.toBeNull()
          expect(avatar.box.width).toBeLessThanOrEqual(avatar.parent!.width + 1)
          expect(avatar.box.height).toBeLessThanOrEqual(avatar.parent!.height + 1)
        }
        for (const message of metrics.messages) {
          expect(message.body?.width || 0).toBeGreaterThan(0)
          expect(message.body!.right).toBeLessThanOrEqual(viewportWidth + 1)
          expect(message.authorTimestampOverlap).toBe(false)
          expect(message.avatar!.right).toBeLessThanOrEqual(message.body!.left + 1)
        }
        await inspectPage.screenshot({ path: testInfo.outputPath(`fragment-contract-${viewportWidth}.png`), fullPage: true })
        await inspectPage.close()
        expect(externalRequests).toEqual([])
        expect(badResponses).toEqual([])
      }
    } finally {
      await browser.close()
    }
  } finally {
    await app.close()
    rmSync(fixtureDir, { recursive: true, force: true })
    rmSync(outputDir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  }
})
