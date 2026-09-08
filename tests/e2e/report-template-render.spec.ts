import { _electron as electron, expect, test } from '@playwright/test'
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ZipArchive } from 'archiver'

const makeZip = async (
  directory: string,
  files: Record<string, string | Buffer>
): Promise<string> => {
  const zipPath = join(directory, `${Math.random().toString(36).slice(2)}.zip`)
  const output = createWriteStream(zipPath)
  const archive = new ZipArchive({ zlib: { level: 6 } })
  archive.pipe(output)
  for (const [name, content] of Object.entries(files)) archive.append(content, { name })
  await new Promise<void>((resolvePromise, reject) => {
    output.on('close', resolvePromise)
    output.on('error', reject)
    archive.on('error', reject)
    void archive.finalize().catch(reject)
  })
  return zipPath
}

const templateManifest = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    protocolVersion: '1.0',
    kind: 'daily-report',
    id: 'community.github.example.runtime-attack',
    name: '运行时安全测试模板',
    author: { name: 'fixture' },
    templateVersion: '1.0.0',
    interfaceVersion: '1',
    entry: 'template.html',
    capture: { width: 430, maxWidth: 430, maxHeight: 20000 },
    license: { spdx: 'MIT' },
    ...patch
  })

const runtimeAttackReport = (imageUrl: string) => ({
  overview: '虚构运行时安全测试',
  topics: [
    {
      title: '攻击 fixture',
      timeRange: '10:00-10:01',
      heat: '高' as const,
      participants: [],
      summary: '用于触发报告窗口资源请求',
      keywords: [],
      image: { imageUrl, note: 'fixture' }
    }
  ],
  resources: [],
  importantMessages: [],
  quotes: [],
  qa: [],
  todos: [],
  unresolved: [],
  storylines: [],
  reversals: [],
  participantChains: [],
  analytics: { topicHeat: [], activeTimeline: '', topSpeakers: [], voiceLeaderboard: [] },
  keywords: [],
  media: { gallery: [], voiceHighlights: [], funBadges: [] }
})

const runtimeAttackMetadata = {
  groupName: '虚构攻击测试群',
  reportDate: '2026-09-07',
  dateRange: '今日',
  messageCount: 1,
  activeUsers: 1,
  timeSpan: '10:00-10:01',
  generatedAt: '2026-09-07 10:01',
  recordNote: 'fixture',
  footerNote: 'fixture security probe',
  heroParticipants: [],
  avatars: {}
}

const startProbeServer = async (): Promise<{
  server: ReturnType<typeof createServer>
  port: number
  httpRequests: string[]
  wsRequests: string[]
}> => {
  const httpRequests: string[] = []
  const wsRequests: string[] = []
  const server = createServer((request, response) => {
    httpRequests.push(request.url || '')
    response.statusCode = 200
    response.end('unexpected fixture response')
  })
  server.on('upgrade', (request, socket) => {
    wsRequests.push(request.url || '')
    socket.destroy()
  })
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolvePromise()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('本地安全探针监听器未分配端口')
  }
  return { server, port: address.port, httpRequests, wsRequests }
}

test('REPORT-TEMPLATE-E2E-01 installs and renders a fixture without author code', async ({}, testInfo) => {
  const userData = mkdtempSync(join(tmpdir(), 'tracememo-template-user-'))
  const outputDir = mkdtempSync(join(tmpdir(), 'tracememo-template-output-'))
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
  let page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  try {
    const installed = await page.evaluate(
      async (p) => window.api.installReportTemplate(p),
      resolve('examples/report-template-basic.zip')
    )
    expect(installed.success).toBe(true)
    expect(installed.template?.id).toBe('community.github.example.basic-feed')
    expect(installed.template?.version).toBe('1.0.0')
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const reloaded = await page.evaluate(() => window.api.listReportTemplates())
    expect(
      reloaded.some(
        (item) => item.id === installed.template?.id && item.version === installed.template?.version
      )
    ).toBe(true)
    const exported = await page.evaluate(
      async ({ id, version }) =>
        window.api.exportGroupReport({
          templateRef: { id, version },
          metadata: {
            groupName: '虚构测试群',
            reportDate: '2026-09-07',
            dateRange: '今日',
            messageCount: 3,
            activeUsers: 2,
            timeSpan: '09:00-10:00',
            generatedAt: '2026-09-07 10:00',
            recordNote: 'fixture',
            footerNote: 'fixture export',
            heroParticipants: [],
            avatars: []
          },
          report: {
            overview: '虚构日报概览',
            topics: [],
            resources: [],
            importantMessages: [],
            quotes: [],
            qa: [],
            todos: [],
            unresolved: [],
            storylines: [],
            reversals: [],
            participantChains: [],
            analytics: { topicHeat: [], activeTimeline: '', topSpeakers: [], voiceLeaderboard: [] },
            keywords: [],
            media: { gallery: [], voiceHighlights: [], funBadges: [] }
          }
        }),
      { id: installed.template!.id, version: installed.template!.version }
    )
    expect(exported.success).toBe(true)
    expect(readFileSync(exported.htmlPath!, 'utf8')).toContain('Content-Security-Policy')
    expect(readFileSync(exported.htmlPath!, 'utf8')).toContain('虚构日报概览')
    const png = readFileSync(exported.pngPath!)
    expect(png.length).toBeGreaterThan(1000)
    expect(png.readUInt32BE(16)).toBe(430)
    expect(png.readUInt32BE(20)).toBeGreaterThan(100)
    await testInfo.attach('report-png', { path: exported.pngPath!, contentType: 'image/png' })
    const removed = await page.evaluate(
      async ({ id, version }) => window.api.uninstallReportTemplate(id, version),
      { id: installed.template!.id, version: installed.template!.version }
    )
    expect(removed.success).toBe(true)
    expect(readFileSync(exported.htmlPath!, 'utf8')).toContain('虚构日报概览')
    expect(readFileSync(exported.pngPath!).length).toBeGreaterThan(1000)
  } finally {
    await app.close()
    rmSync(outputDir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  }
})

test('REPORT-TEMPLATE-E2E-CAPTURE-01 enforces manifest maxHeight in the production capture path', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tracememo-template-capture-user-'))
  const outputDir = mkdtempSync(join(tmpdir(), 'tracememo-template-capture-output-'))
  const fixtureDir = mkdtempSync(join(tmpdir(), 'tracememo-template-capture-fixture-'))
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
  let page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  try {
    const packagePath = await makeZip(fixtureDir, {
      'manifest.json': templateManifest({
        id: 'community.github.example.capture-cap',
        name: '截图高度限制测试',
        templateVersion: '1.0.0',
        capture: { width: 430, maxWidth: 430, maxHeight: 800 }
      }),
      'template.html': `<!doctype html><html><head><style>html,body{margin:0;min-height:3000px}</style></head><body><h1>{{REPORT_TITLE}}</h1></body></html>`
    })
    const installed = await page.evaluate(
      async (path) => window.api.installReportTemplate(path),
      packagePath
    )
    expect(installed.success, installed.error).toBe(true)
    const exported = await page.evaluate(
      async ({ id, version }) =>
        window.api.exportGroupReport({
          templateRef: { id, version },
          metadata: {
            groupName: '虚构截图限制群',
            reportDate: '2026-09-07',
            dateRange: '今日',
            messageCount: 1,
            activeUsers: 1,
            timeSpan: '10:00-10:01',
            generatedAt: '2026-09-07 10:01',
            recordNote: 'fixture',
            footerNote: 'capture fixture',
            heroParticipants: [],
            avatars: {}
          },
          report: {
            overview: '虚构截图高度限制',
            topics: [],
            resources: [],
            importantMessages: [],
            quotes: [],
            qa: [],
            todos: [],
            unresolved: [],
            storylines: [],
            reversals: [],
            participantChains: [],
            analytics: { topicHeat: [], activeTimeline: '', topSpeakers: [], voiceLeaderboard: [] },
            keywords: [],
            media: { gallery: [], voiceHighlights: [], funBadges: [] }
          }
        }),
      { id: installed.template!.id, version: installed.template!.version }
    )
    expect(exported.success, exported.error).toBe(true)
    const png = readFileSync(exported.pngPath!)
    expect(png.readUInt32BE(16)).toBe(430)
    expect(png.readUInt32BE(20)).toBe(800)
  } finally {
    await app.close()
    rmSync(fixtureDir, { recursive: true, force: true })
    rmSync(outputDir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  }
})

test('REPORT-TEMPLATE-E2E-SECURITY-01 blocks runtime attacks in a real Electron report window', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tracememo-template-security-user-'))
  const outputDir = mkdtempSync(join(tmpdir(), 'tracememo-template-security-output-'))
  const fixtureDir = mkdtempSync(join(tmpdir(), 'tracememo-template-security-fixture-'))
  const securityLog = join(outputDir, 'security-blocks.ndjson')
  const probeServer = await startProbeServer()
  const outsideImage = join(userData, 'outside.png')
  writeFileSync(
    outsideImage,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
  )
  const launch = () =>
    electron.launch({
      args: [resolve('out/main/reportTemplateTest.js')],
      env: {
        ...process.env,
        TRACEMEMO_TEMPLATE_TEST_USER_DATA: userData,
        TRACEMEMO_REPORT_OUTPUT_DIR: outputDir,
        TRACEMEMO_TEMPLATE_SECURITY_LOG: securityLog
      }
    })
  let app = await launch()
  let page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  try {
    const runtimeZip = await makeZip(fixtureDir, {
      'manifest.json': templateManifest(),
      'template.html': `<!doctype html><html><head><style>body{font-family:sans-serif;padding:24px}</style></head><body><h1>{{REPORT_TITLE}}</h1><main>{{TOPIC_CARDS}}</main></body></html>`
    })
    const maliciousZip = await makeZip(fixtureDir, {
      'manifest.json': templateManifest({ templateVersion: '1.0.1' }),
      'template.html': '<script>window.__templateAuthorCode = true</script>'
    })

    const rejected = await page.evaluate(
      async (packagePath) => window.api.installReportTemplate(packagePath),
      maliciousZip
    )
    expect(rejected.success).toBe(false)
    expect(rejected.code).toBe('unsafe_html')

    const installed = await page.evaluate(
      async (packagePath) => window.api.installReportTemplate(packagePath),
      runtimeZip
    )
    expect(installed.success).toBe(true)
    expect(installed.template?.id).toBe('community.github.example.runtime-attack')

    const outsideFileUrl = pathToFileURL(outsideImage).toString()
    const targets = {
      http: `http://127.0.0.1:${probeServer.port}/http-probe`,
      https: `https://127.0.0.1:${probeServer.port}/https-probe`,
      ws: `ws://127.0.0.1:${probeServer.port}/ws-probe`,
      wss: `wss://127.0.0.1:${probeServer.port}/wss-probe`
    }
    await app.evaluate(
      ({ app: electronApp }, { fileUrl, targets }) => {
        const state = {
          hiddenWindows: 0,
          createdWindows: 0,
          navigations: [] as string[],
          childWindowUrls: [] as string[],
          probeStarted: false,
          probeDone: false,
          probe: undefined as
            | {
                http: boolean
                https: boolean
                ws: boolean
                wss: boolean
                localResource: boolean
                windowOpen: boolean
                targetBlankClicked: boolean
                targetBlank: boolean
                navigation: boolean
              }
            | undefined
        }
        ;(
          globalThis as typeof globalThis & { __tmTemplateSecurity?: typeof state }
        ).__tmTemplateSecurity = state
        electronApp.on('browser-window-created', (_event, browserWindow) => {
          state.createdWindows += 1
          if (browserWindow.isVisible()) return
          state.hiddenWindows += 1
          browserWindow.webContents.on('will-navigate', (_navigationEvent, url) => {
            state.navigations.push(url)
          })
          browserWindow.webContents.on('did-create-window', (_childWindow, details) => {
            state.childWindowUrls.push(details.url)
          })
          browserWindow.webContents.on('did-finish-load', () => {
            if (state.probeStarted) return
            state.probeStarted = true
            const serializedFileUrl = JSON.stringify(fileUrl)
            const serializedTargets = JSON.stringify(targets)
            const requestViaSession = async (url: string): Promise<boolean> => {
              try {
                await Promise.race([
                  browserWindow.webContents.session.fetch(url, { cache: 'no-store' }),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('network probe timeout')), 2000)
                  )
                ])
                return false
              } catch {
                return true
              }
            }
            const networkProbe = Promise.all([
              requestViaSession(targets.http),
              requestViaSession(targets.https),
              requestViaSession(targets.ws),
              requestViaSession(targets.wss),
              requestViaSession(fileUrl)
            ]).then(([http, https, ws, wss, localResource]) => ({
              http,
              https,
              ws,
              wss,
              localResource
            }))
            const rendererProbe = browserWindow.webContents.executeJavaScript(
              `(() => {
              const targets = ${serializedTargets}
              const originalUrl = location.href
              const rejectedSocket = (url) => new Promise((resolve) => {
                let settled = false
                let socket
                const finish = (rejected) => {
                  if (settled) return
                  settled = true
                  socket?.close()
                  resolve(rejected)
                }
                try {
                  socket = new WebSocket(url)
                  socket.onerror = () => finish(true)
                  socket.onopen = () => finish(false)
                  setTimeout(() => finish(true), 1000)
                } catch {
                  finish(true)
                }
              })
              const rejectedLocalImage = new Promise((resolve) => {
                  const outside = new Image()
                  outside.onload = () => resolve(outside.naturalWidth === 0)
                  outside.onerror = () => resolve(true)
                  setTimeout(() => resolve(false), 500)
                  outside.src = ${serializedFileUrl}
                })
                const windowOpen = window.open(targets.https + '/new-window') === null
                const target = document.createElement('a')
                target.href = targets.https + '/target-blank'
                target.target = '_blank'
                target.textContent = 'open'
              document.body.append(target)
              const targetBlankClicked = target.target === '_blank' && target.href === targets.https + '/target-blank'
              target.click()
              target.remove()
              try { location.assign(targets.ws + '/renderer-navigation') } catch { /* will-navigate 事件会阻止导航 */ }
              try { location.assign(targets.https + '/navigation') } catch { /* will-navigate 事件会阻止导航 */ }
              return Promise.all([
                rejectedLocalImage,
                rejectedSocket(targets.ws + '/renderer-probe'),
                rejectedSocket(targets.wss + '/renderer-probe'),
                new Promise((resolve) => setTimeout(resolve, 100))
              ]).then(([localResource, rendererWs, rendererWss]) => ({ localResource, rendererWs, rendererWss, windowOpen, targetBlankClicked, navigation: location.href === originalUrl }))
              })()`
            )
            void Promise.all([networkProbe, rendererProbe])
              .then(([network, result]) => {
                const values = result as {
                  localResource: boolean
                  rendererWs: boolean
                  rendererWss: boolean
                  windowOpen: boolean
                  targetBlankClicked: boolean
                  navigation: boolean
                }
                state.probe = {
                  ...network,
                  localResource: values.localResource,
                  windowOpen: values.windowOpen,
                  navigation: values.navigation,
                  ws: network.ws || values.rendererWs,
                  wss: network.wss || values.rendererWss,
                  targetBlankClicked: values.targetBlankClicked,
                  targetBlank:
                    values.targetBlankClicked &&
                    state.createdWindows === 1 &&
                    !state.childWindowUrls.includes(`${targets.https}/target-blank`)
                }
                state.probeDone = true
              })
              .catch(() => undefined)
          })
        })
      },
      { fileUrl: outsideFileUrl, targets }
    )

    const reportWindowPromise = app.waitForEvent('window', {
      predicate: (candidate) => candidate !== page
    })
    const exportPromise = page.evaluate(
      async ({ id, version, metadata, report }) =>
        window.api.exportGroupReport({
          templateRef: { id, version },
          metadata,
          report
        }),
      {
        id: installed.template!.id,
        version: installed.template!.version,
        metadata: runtimeAttackMetadata,
        report: runtimeAttackReport(`${targets.https}/render-image`)
      }
    )
    await reportWindowPromise
    const exported = await exportPromise
    expect(exported.success).toBe(true)
    expect(readFileSync(exported.htmlPath!, 'utf8')).toContain('虚构攻击测试群日报')
    expect(readFileSync(exported.pngPath!).length).toBeGreaterThan(1000)

    await expect
      .poll(
        async () =>
          app.evaluate(() => {
            const state = (
              globalThis as typeof globalThis & { __tmTemplateSecurity?: { probeDone: boolean } }
            ).__tmTemplateSecurity
            return state?.probeDone ?? false
          }),
        { timeout: 3000 }
      )
      .toBe(true)

    const securityLogLines = readFileSync(securityLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { url: string; reason: string })
    const blockedUrls = securityLogLines.map((entry) => entry.url)
    for (const url of [targets.http, targets.https, targets.ws, targets.wss, outsideFileUrl]) {
      expect(blockedUrls, `缺少运行时拦截记录: ${url}`).toContain(url)
      const block = securityLogLines.find((entry) => entry.url === url)
      expect(block?.reason, `运行时拦截 reason 缺失: ${url}`).toBe(
        url.startsWith('file:') ? 'file-path-not-allowed' : 'scheme-not-allowed'
      )
    }
    expect(probeServer.httpRequests).toEqual([])
    expect(probeServer.wsRequests).toEqual([])

    const securityState = await app.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & {
          __tmTemplateSecurity?: {
            hiddenWindows: number
            navigations: string[]
            createdWindows: number
            childWindowUrls: string[]
            probeDone: boolean
            probe?: {
              http: boolean
              https: boolean
              ws: boolean
              wss: boolean
              localResource: boolean
              windowOpen: boolean
              targetBlankClicked: boolean
              targetBlank: boolean
              navigation: boolean
            }
          }
        }
      ).__tmTemplateSecurity
      return state
    })
    expect(securityState?.hiddenWindows).toBe(1)
    expect(securityState?.createdWindows).toBe(1)
    expect(securityState?.childWindowUrls).toEqual([])
    expect(securityState?.navigations).toContain(`${targets.https}/navigation`)
    expect(securityState?.probe, JSON.stringify(securityState)).toEqual({
      http: true,
      https: true,
      ws: true,
      wss: true,
      localResource: true,
      windowOpen: true,
      targetBlankClicked: true,
      targetBlank: true,
      navigation: true
    })
    expect(app.windows().length).toBe(1)
  } finally {
    await app.close()
    if (probeServer.server.listening) {
      await new Promise<void>((resolvePromise, reject) => {
        probeServer.server.close((error) => (error ? reject(error) : resolvePromise()))
      })
    }
    rmSync(fixtureDir, { recursive: true, force: true })
    rmSync(outputDir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  }
})
