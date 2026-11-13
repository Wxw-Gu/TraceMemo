'use strict'

/**
 * 纯函数层测试：不联网、不启动 python、不读真实文件。
 * 运行：node --test examples/extensions/douyin-sender/tests/douyin.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import douyin from '../lib/douyin.js'

const {
  DEFAULT_CONFIG,
  normalizeConfig,
  extractDouyinUrl,
  parseResolveJson,
  parseSavedPath,
  parseDownloadedResult,
  renderCaption,
  shouldHandle,
  isFileTooLarge,
  pickVideoResult
} = douyin

const SHORT_URL = 'https://v.douyin.com/fixture123'
const SHORT_TEXT_URL = 'https://v.douyin.com/fixture123/'
const VIDEO_URL = 'https://www.douyin.com/video/7300000000000000001'
const NOTE_URL = 'https://douyin.com/note/7300000000000000002'

function makeEvent(overrides = {}) {
  return {
    eventId: 'message:fixture-1',
    accountId: 'wxid_fixture',
    conversationId: 'fixture-room@chatroom',
    messageId: 'local-1',
    senderId: 'wxid_fixture',
    senderName: '张三',
    isGroup: true,
    isSelf: false,
    type: 'text',
    text: `@李四 ${SHORT_TEXT_URL}`,
    mentionsMe: true,
    timestamp: 0,
    ...overrides
  }
}

function makeConfig(overrides = {}) {
  return normalizeConfig({ enabled: true, ...overrides })
}

test('从裸短链里提取链接', () => {
  assert.equal(extractDouyinUrl(SHORT_TEXT_URL), SHORT_URL)
})

test('从长链 video 里提取链接', () => {
  assert.equal(extractDouyinUrl(VIDEO_URL), VIDEO_URL)
})

test('从 note 链接里提取链接', () => {
  assert.equal(extractDouyinUrl(NOTE_URL), NOTE_URL)
})

test('从整段分享文案里提取链接', () => {
  const text =
    '7.89 复制打开抖音，看看【张三的作品】很有意思 https://v.douyin.com/fixture123/ 01/02 abc:/'
  assert.equal(extractDouyinUrl(text), SHORT_URL)
})

test('去掉链接尾随的中文标点', () => {
  assert.equal(extractDouyinUrl('看这个 https://v.douyin.com/fixture123/。'), SHORT_URL)
})

test('拒绝非抖音域名', () => {
  assert.equal(extractDouyinUrl('https://example.com/video/7300000000000000001'), null)
  assert.equal(extractDouyinUrl('https://douyin.com.evil.test/video/1'), null)
  assert.equal(extractDouyinUrl('https://foo.douyin.com/video/1'), null)
})

test('拒绝 javascript: 与 ftp:', () => {
  assert.equal(extractDouyinUrl('javascript://v.douyin.com/fixture123/'), null)
  assert.equal(extractDouyinUrl('ftp://v.douyin.com/fixture123/'), null)
})

test('没有链接时返回 null', () => {
  assert.equal(extractDouyinUrl('今天天气不错'), null)
  assert.equal(extractDouyinUrl(''), null)
  assert.equal(extractDouyinUrl(undefined), null)
})

test('JSON 前后有噪声也能解析出数组', () => {
  const stdout = [
    '共 1 个链接',
    '▶ https://v.douyin.com/fixture123/',
    '  ✓ 解析成功：video | 张三 | 标题',
    '',
    '[{"url":"https://v.douyin.com/fixture123/","ok":true,"type":"video","aweme_id":"730"}]',
    '',
    '完成：1/1 成功'
  ].join('\n')
  const parsed = parseResolveJson(stdout)
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].aweme_id, '730')
})

test('缩进的多行 JSON 数组按真实输出解析', () => {
  const stdout = [
    '  ✓ 解析成功：video | 张三 | 标题',
    '==================================================',
    '完成：1/1 成功',
    '[',
    '  {',
    '    "url": "https://v.douyin.com/fixture123/",',
    '    "ok": true,',
    '    "type": "video",',
    '    "quality_options": [',
    '      {"gear": "720p", "rank": 720}',
    '    ]',
    '  }',
    ']'
  ].join('\n')
  const parsed = parseResolveJson(stdout)
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed[0].quality_options[0].rank, 720)
})

test('非法 JSON 返回 null', () => {
  assert.equal(parseResolveJson('不是 JSON'), null)
  assert.equal(parseResolveJson('[{"ok":true,'), null)
  assert.equal(parseResolveJson(''), null)
})

test('进度行里的方括号不会被误认为结果数组', () => {
  const stdout = [
    '    [1] 跳过（无地址）',
    '  ✅ /tmp/fixture-folder  （2 个文件）',
    '[{"url":"https://v.douyin.com/fixture123","ok":true,"type":"image","aweme_id":"730"}]'
  ].join('\n')
  const parsed = parseResolveJson(stdout)
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].type, 'image')
})

test('空数组视为无效结果', () => {
  assert.equal(parseResolveJson('[]'), null)
})

test('合法 JSON 但不是数组时返回 null', () => {
  assert.equal(parseResolveJson('{"ok":true}'), null)
})

test('下载输出里能取到绝对路径', () => {
  const stdout = [
    '  ✓ 解析成功：video | 张三 | 标题',
    '    下载中 → 张三 - 标题 - 730.mp4',
    '  ✅ /tmp/fixture/downloads/张三 - 标题 - 730.mp4',
    '     5.2MB | MP4'
  ].join('\n')
  assert.equal(parseSavedPath(stdout), '/tmp/fixture/downloads/张三 - 标题 - 730.mp4')
})

test('多条 ✅ 时取最后一个', () => {
  const stdout = ['  ✅ /tmp/one.mp4', '  ✅ /tmp/two.mp4', '    1.0MB | MP4'].join('\n')
  assert.equal(parseSavedPath(stdout), '/tmp/two.mp4')
})

test('从 JSON 下载结果同时提取作品元数据和保存路径', () => {
  const parsed = parseDownloadedResult(
    '[{"url":"https://v.douyin.com/fixture123","ok":true,"type":"video","aweme_id":"730","saved":["/tmp/fixture-video.mp4"]}]'
  )
  assert.deepEqual(parsed, {
    ok: true,
    meta: {
      url: 'https://v.douyin.com/fixture123',
      ok: true,
      type: 'video',
      aweme_id: '730',
      saved: ['/tmp/fixture-video.mp4']
    },
    path: '/tmp/fixture-video.mp4'
  })
  assert.equal(
    parseDownloadedResult(
      '[{"url":"https://v.douyin.com/fixture123","ok":true,"type":"video","saved":["relative.mp4"]}]'
    ),
    null
  )
})

test('JSON 下载失败保留脚本错误，图集保持不支持状态', () => {
  assert.deepEqual(
    parseDownloadedResult(
      '[{"url":"https://v.douyin.com/fixture123","ok":false,"error":"fixture platform error"}]'
    ),
    { ok: false, message: 'fixture platform error', errorType: 'RESOLVE_FAILED' }
  )
  assert.deepEqual(
    parseDownloadedResult(
      '[{"url":"https://v.douyin.com/fixture123","ok":true,"type":"image","images":[]}]'
    ),
    { ok: false, message: '暂不支持图集', errorType: 'IMAGE_SET' }
  )
})

test('下载阶段失败时标记为下载错误', () => {
  assert.deepEqual(
    parseDownloadedResult(
      '[{"url":"https://v.douyin.com/fixture123","ok":false,"aweme_id":"730","error":"fixture CDN timeout"}]'
    ),
    { ok: false, message: 'fixture CDN timeout', errorType: 'DOWNLOAD_FAILED' }
  )
})

test('图集目录后面的附注被剥离', () => {
  const stdout = ['  ✅ /tmp/fixture-folder  （5 个文件）'].join('\n')
  assert.equal(parseSavedPath(stdout), '/tmp/fixture-folder')
})

test('没有 ✅ 行时返回 null', () => {
  assert.equal(parseSavedPath('  ✗ 失败：超时\n完成：0/1 成功'), null)
  assert.equal(parseSavedPath(''), null)
})

test('模板替换三个已知变量', () => {
  const caption = renderCaption('{author}：{title}（{awemeId}）', {
    author: '张三',
    title: '测试标题',
    awemeId: '730'
  })
  assert.equal(caption, '张三：测试标题（730）')
})

test('未知变量原样保留', () => {
  const caption = renderCaption('{author} {unknownVar}', { author: '张三' })
  assert.equal(caption, '张三 {unknownVar}')
})

test('超长文案截断到 200 字', () => {
  const caption = renderCaption('{title}', { title: '字'.repeat(400) })
  assert.equal(caption.length, 200)
})

test('默认配置符合约定', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.configVersion, 1)
  assert.equal(config.enabled, false)
  assert.equal(config.pythonPath, 'python3')
  assert.equal(config.scriptPath, 'scripts/douyin.py')
  assert.equal(config.quality, '720')
  assert.equal(config.showUi, false)
  assert.equal(config.sendCaption, false)
  assert.equal(config.captionTemplate, '{author}：{title}')
  assert.equal(config.errorReply, true)
  assert.equal(config.includeDirect, false)
  assert.deepEqual(config.groups, [])
  assert.equal(config.cooldownSeconds, 60)
  assert.equal(config.maxFileMB, 100)
})

test('常规配置不接纳 Cookie 凭证字段', () => {
  const config = normalizeConfig({ cookie: 'must-not-persist', cookieFile: '/tmp/fixture-cookie' })
  assert.equal(Object.hasOwn(config, 'cookie'), false)
  assert.equal(Object.hasOwn(config, 'cookieFile'), false)
})

test('非法画质收敛到 720，空串表示最高', () => {
  assert.equal(normalizeConfig({ quality: '4k' }).quality, '720')
  assert.equal(normalizeConfig({ quality: '' }).quality, '')
  assert.equal(normalizeConfig({ quality: '1080' }).quality, '1080')
})

test('数值型画质按字符串处理', () => {
  assert.equal(normalizeConfig({ quality: 540 }).quality, '540')
})

test('showUi 只接受布尔 true', () => {
  assert.equal(normalizeConfig({ showUi: true }).showUi, true)
  assert.equal(normalizeConfig({ showUi: 'true' }).showUi, false)
  assert.equal(normalizeConfig({ showUi: 1 }).showUi, false)
})

test('ackText 默认有回执，空串表示关闭', () => {
  assert.match(normalizeConfig({}).ackText, /收到/)
  assert.equal(normalizeConfig({ ackText: '' }).ackText, '')
  assert.equal(normalizeConfig({ ackText: '  好的  ' }).ackText, '好的')
  assert.equal(normalizeConfig({ ackText: 'x'.repeat(300) }).ackText.length, 200)
})

test('冷却与文件上限被夹到合法区间', () => {
  assert.equal(normalizeConfig({ cooldownSeconds: -10 }).cooldownSeconds, 0)
  assert.equal(normalizeConfig({ cooldownSeconds: 999999 }).cooldownSeconds, 3600)
  assert.equal(normalizeConfig({ maxFileMB: 0 }).maxFileMB, 1)
  assert.equal(normalizeConfig({ maxFileMB: 500 }).maxFileMB, 100)
})

test('群 id 去空、去重并截断上限', () => {
  const config = normalizeConfig({
    groups: [' fixture-room@chatroom ', '', 'fixture-room@chatroom']
  })
  assert.deepEqual(config.groups, ['fixture-room@chatroom'])
})

test('总开关关闭时拒绝处理', () => {
  const decision = shouldHandle(makeEvent(), makeConfig({ enabled: false }), new Map(), Date.now())
  assert.deepEqual(decision, { handle: false, url: null, reason: 'disabled' })
})

test('自己发的消息拒绝处理', () => {
  const decision = shouldHandle(makeEvent({ isSelf: true }), makeConfig(), new Map(), Date.now())
  assert.equal(decision.handle, false)
  assert.equal(decision.reason, 'self')
})

test('非 text 消息拒绝处理', () => {
  const decision = shouldHandle(makeEvent({ type: 'image' }), makeConfig(), new Map(), Date.now())
  assert.equal(decision.handle, false)
  assert.equal(decision.reason, 'type')
})

test('没有真正 @ 我时拒绝处理', () => {
  const decision = shouldHandle(
    makeEvent({ mentionsMe: false }),
    makeConfig(),
    new Map(),
    Date.now()
  )
  assert.equal(decision.handle, false)
  assert.equal(decision.reason, 'mention')
})

test('消息里没有链接时拒绝处理', () => {
  const decision = shouldHandle(
    makeEvent({ text: '@李四 今天天气不错' }),
    makeConfig(),
    new Map(),
    Date.now()
  )
  assert.equal(decision.handle, false)
  assert.equal(decision.reason, 'no_link')
})

test('群不在白名单里时拒绝处理，但仍返回提取到的链接', () => {
  const decision = shouldHandle(
    makeEvent(),
    makeConfig({ groups: ['other-room@chatroom'] }),
    new Map(),
    Date.now()
  )
  assert.equal(decision.handle, false)
  assert.equal(decision.reason, 'scope')
  assert.equal(decision.url, SHORT_URL)
})

test('群在白名单里时允许处理', () => {
  const decision = shouldHandle(
    makeEvent(),
    makeConfig({ groups: ['fixture-room@chatroom'] }),
    new Map(),
    Date.now()
  )
  assert.deepEqual(decision, { handle: true, url: SHORT_URL, reason: 'ok' })
})

test('私聊默认不处理，开启后处理', () => {
  const direct = makeEvent({ isGroup: false, conversationId: 'wxid_fixture' })
  assert.equal(shouldHandle(direct, makeConfig(), new Map(), Date.now()).reason, 'scope')
  assert.equal(
    shouldHandle(direct, makeConfig({ includeDirect: true }), new Map(), Date.now()).reason,
    'ok'
  )
})

test('冷却未过期时拒绝，过期后放行', () => {
  const now = 1_767_225_600_000
  const cooldown = new Map([['fixture-room@chatroom', now + 30_000]])
  assert.equal(shouldHandle(makeEvent(), makeConfig(), cooldown, now).reason, 'cooldown')
  assert.equal(shouldHandle(makeEvent(), makeConfig(), cooldown, now + 30_001).reason, 'ok')
})

test('图集不算视频', () => {
  const results = [
    { url: SHORT_URL, ok: true, type: 'image', aweme_id: '730' },
    { url: VIDEO_URL, ok: true, type: 'video', aweme_id: '731' }
  ]
  assert.equal(pickVideoResult(results).aweme_id, '731')
  assert.equal(pickVideoResult([results[0]]), null)
})

test('跳过失败项并容忍非数组输入', () => {
  assert.equal(pickVideoResult([{ ok: false, error: '超时' }]), null)
  assert.equal(pickVideoResult(null), null)
  assert.equal(pickVideoResult([]), null)
})

test('文件大小判定覆盖上限与非法值', () => {
  assert.equal(isFileTooLarge(100 * 1024 * 1024, 100), false)
  assert.equal(isFileTooLarge(100 * 1024 * 1024 + 1, 100), true)
  assert.equal(isFileTooLarge(2 * 1024 * 1024, 1), true)
  assert.equal(isFileTooLarge(0, 100), true)
  assert.equal(isFileTooLarge(Number.NaN, 100), true)
  assert.equal(isFileTooLarge(1, 100), false)
})

test('DEFAULT_CONFIG 不被 normalizeConfig 修改', () => {
  const before = JSON.stringify(DEFAULT_CONFIG)
  const config = normalizeConfig({ enabled: true, groups: ['fixture-room@chatroom'] })
  config.groups.push('wxid_fixture')
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before)
})
