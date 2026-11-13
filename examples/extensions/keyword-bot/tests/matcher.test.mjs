import test from 'node:test'
import assert from 'node:assert/strict'

import matcher from '../lib/matcher.js'

const { normalizeConfig, matchRule, pickRule, inScope, renderReply, shouldReply } = matcher

const GROUP_ID = 'fixture-room@chatroom'
const NOW = 1_700_000_000_000

/** 构造一份启用状态下的最小配置，参数按需覆盖。 */
function buildConfig(overrides = {}) {
  return normalizeConfig({
    enabled: true,
    rules: [{ id: 'rule-1', keyword: '关键词', mode: 'contains', reply: '默认回复' }],
    scope: { groups: [], includeDirect: true, requireMentionMe: false },
    ...overrides
  })
}

/** 构造一条群聊文本消息事件。 */
function buildEvent(overrides = {}) {
  return {
    eventId: 'event-fixture-1',
    accountId: 'account-fixture',
    conversationId: GROUP_ID,
    messageId: 'message-fixture-1',
    senderId: 'wxid_fixture',
    senderName: '张三',
    isGroup: true,
    isSelf: false,
    type: 'text',
    text: '你好，关键词',
    mentionsMe: false,
    timestamp: NOW,
    ...overrides
  }
}

test('exact 模式比较 trim 后的完整文本', () => {
  const rule = { keyword: '关键词', mode: 'exact' }
  assert.equal(matchRule('  关键词  ', rule), true)
  assert.equal(matchRule('你好，关键词', rule), false)
})

test('exact 模式不匹配大小写不同的关键词之外的差异', () => {
  const rule = { keyword: 'Hello', mode: 'exact' }
  assert.equal(matchRule('hello', rule), true)
  assert.equal(matchRule('hello world', rule), false)
})

test('contains 模式匹配任意位置的子串', () => {
  const rule = { keyword: '关键词', mode: 'contains' }
  assert.equal(matchRule('前面的关键词后面', rule), true)
  assert.equal(matchRule('完全无关', rule), false)
})

test('prefix 模式只匹配开头', () => {
  const rule = { keyword: '你好', mode: 'prefix' }
  assert.equal(matchRule('  你好世界', rule), true)
  assert.equal(matchRule('世界你好', rule), false)
})

test('匹配对大小写不敏感', () => {
  assert.equal(matchRule('Say HELLO now', { keyword: 'hello', mode: 'contains' }), true)
  assert.equal(matchRule('HELLO WORLD', { keyword: 'hello', mode: 'prefix' }), true)
})

test('空关键词在任何模式下都不命中', () => {
  for (const mode of ['contains', 'exact', 'prefix']) {
    assert.equal(matchRule('任意文本', { keyword: '   ', mode }), false)
    assert.equal(matchRule('', { keyword: '', mode }), false)
  }
})

test('pickRule 跳过禁用规则', () => {
  const config = buildConfig({
    rules: [
      { id: 'disabled', keyword: '关键词', reply: '不会发送', enabled: false },
      { id: 'active', keyword: '关键词', reply: '会发送' }
    ]
  })
  const rule = pickRule('关键词', config)
  assert.equal(rule.id, 'active')
})

test('pickRule 按 priority 降序选择', () => {
  const config = buildConfig({
    rules: [
      { id: 'low', keyword: '关键词', reply: '低', priority: 10 },
      { id: 'high', keyword: '关键词', reply: '高', priority: 90 }
    ]
  })
  assert.equal(pickRule('关键词', config).id, 'high')
})

test('同优先级保持数组顺序（先定义先命中）', () => {
  const config = buildConfig({
    rules: [
      { id: 'first', keyword: '关键词', reply: '一', priority: 50 },
      { id: 'second', keyword: '关键词', reply: '二', priority: 50 }
    ]
  })
  assert.equal(pickRule('关键词', config).id, 'first')
})

test('同一条消息只返回一个规则（stopOnMatch）', () => {
  const config = buildConfig({
    rules: [
      { id: 'a', keyword: '关键词', reply: '一', priority: 1 },
      { id: 'b', keyword: '关键词', reply: '二', priority: 2 }
    ]
  })
  const rule = pickRule('关键词 关键词', config)
  assert.equal(rule.id, 'b')
})

test('群范围命中指定群', () => {
  const config = buildConfig({ scope: { groups: [GROUP_ID] } })
  assert.equal(inScope(buildEvent(), config), true)
})

test('群范围排除未列出的群', () => {
  const config = buildConfig({ scope: { groups: ['other-room@chatroom'] } })
  assert.equal(inScope(buildEvent(), config), false)
})

test('groups 为空表示全部群聊', () => {
  const config = buildConfig({ scope: { groups: [] } })
  assert.equal(inScope(buildEvent(), config), true)
})

test('includeDirect 为 false 时不处理私聊', () => {
  const closed = buildConfig({ scope: { groups: [], includeDirect: false } })
  const open = buildConfig({ scope: { groups: [], includeDirect: true } })
  const direct = buildEvent({ isGroup: false, conversationId: 'wxid_fixture' })
  assert.equal(inScope(direct, closed), false)
  assert.equal(inScope(direct, open), true)
})

test('requireMentionMe 只放行真正 @ 我的消息', () => {
  const config = buildConfig({ scope: { groups: [], requireMentionMe: true } })
  assert.equal(shouldReply(buildEvent(), config, new Map(), NOW).reason, 'mention')
  assert.equal(shouldReply(buildEvent({ mentionsMe: true }), config, new Map(), NOW).reason, 'ok')
})

test('自己发的消息不回复', () => {
  const verdict = shouldReply(buildEvent({ isSelf: true }), buildConfig(), new Map(), NOW)
  assert.deepEqual(verdict, { reply: false, rule: null, reason: 'self' })
})

test('非文本消息不回复', () => {
  const verdict = shouldReply(buildEvent({ type: 'image' }), buildConfig(), new Map(), NOW)
  assert.equal(verdict.reason, 'type')
})

test('总开关关闭时不回复', () => {
  const config = buildConfig({ enabled: false })
  assert.equal(shouldReply(buildEvent(), config, new Map(), NOW).reason, 'disabled')
  assert.equal(shouldReply(buildEvent(), null, new Map(), NOW).reason, 'disabled')
})

test('没有命中规则时 reason 为 no_match', () => {
  const verdict = shouldReply(buildEvent({ text: '无关内容' }), buildConfig(), new Map(), NOW)
  assert.deepEqual(verdict, { reply: false, rule: null, reason: 'no_match' })
})

test('冷却中不回复', () => {
  const cooldown = new Map([[`${GROUP_ID}:rule-1`, NOW + 30_000]])
  const verdict = shouldReply(buildEvent(), buildConfig(), cooldown, NOW)
  assert.deepEqual(verdict, { reply: false, rule: null, reason: 'cooldown' })
})

test('冷却过期后恢复回复', () => {
  const cooldown = new Map([[`${GROUP_ID}:rule-1`, NOW]])
  const verdict = shouldReply(buildEvent(), buildConfig(), cooldown, NOW)
  assert.equal(verdict.reply, true)
  assert.equal(verdict.reason, 'ok')
  assert.equal(verdict.rule.id, 'rule-1')
})

test('冷却表也支持普通对象', () => {
  const cooldown = { [`${GROUP_ID}:rule-1`]: NOW + 1 }
  assert.equal(shouldReply(buildEvent(), buildConfig(), cooldown, NOW).reason, 'cooldown')
  assert.equal(shouldReply(buildEvent(), buildConfig(), {}, NOW).reason, 'ok')
})

test('模板变量按上下文替换', () => {
  const text = renderReply('{sender} 说了 {keyword}，现在是 {time}', {
    senderName: '张三',
    keyword: '关键词',
    time: '09:05'
  })
  assert.equal(text, '张三 说了 关键词，现在是 09:05')
})

test('发送者昵称为空时渲染为「你」', () => {
  assert.equal(renderReply('{sender}', { senderName: '  ' }), '你')
  assert.equal(renderReply('{sender}', {}), '你')
})

test('未知变量原样保留', () => {
  const text = renderReply('{sender} 和 {group}', { senderName: '李四' })
  assert.equal(text, '李四 和 {group}')
})

test('模板缺失的时间变量渲染为空串', () => {
  assert.equal(renderReply('[{time}]', {}), '[]')
})

test('渲染结果 trim 后截断到 2000 字符', () => {
  const input = `  ${'长'.repeat(2100)}  `
  const text = renderReply(input, {})
  assert.equal(text.length, 2000)
  assert.equal(text, '长'.repeat(2000))
})

test('v1 配置迁移补齐 enabled / priority 与 configVersion', () => {
  const config = normalizeConfig({
    enabled: true,
    rules: [{ id: 'old', keyword: '关键词', mode: 'contains', reply: '旧规则' }],
    scope: { groups: ['fixture-room@chatroom'] }
  })
  assert.equal(config.configVersion, 2)
  assert.equal(config.rules.length, 1)
  assert.equal(config.rules[0].enabled, true)
  assert.equal(config.rules[0].priority, 0)
  assert.equal(config.scope.includeDirect, true)
  assert.equal(config.scope.requireMentionMe, false)
})

test('keyword 或 reply 为空的启用规则被丢弃，停用草稿保留', () => {
  const config = normalizeConfig({
    enabled: true,
    rules: [
      { id: 'no-keyword', keyword: '  ', reply: '有回复' },
      { id: 'no-reply', keyword: '有词', reply: '   ' },
      { id: 'draft', keyword: '', reply: '', enabled: false },
      { id: 'ok', keyword: '有词', reply: '有回复' }
    ]
  })
  assert.deepEqual(
    config.rules.map((rule) => rule.id),
    ['draft', 'ok']
  )
})

test('非对象与缺失字段的配置退化为未启用空配置', () => {
  for (const raw of [null, undefined, 'broken', 42, []]) {
    const config = normalizeConfig(raw)
    assert.equal(config.configVersion, 2)
    assert.equal(config.enabled, false)
    assert.deepEqual(config.rules, [])
    assert.deepEqual(config.scope, { groups: [], includeDirect: true, requireMentionMe: false })
  }
})

test('越界数值收敛到边界，非法值按 0', () => {
  const config = normalizeConfig({
    rules: [
      { id: 'clamp-high', keyword: '一', reply: '一', cooldownSeconds: 99_999, priority: 999 },
      { id: 'clamp-low', keyword: '二', reply: '二', cooldownSeconds: -5, priority: -5 },
      { id: 'nan', keyword: '三', reply: '三', cooldownSeconds: 'oops', priority: 'oops' }
    ]
  })
  assert.equal(config.rules[0].cooldownSeconds, 3600)
  assert.equal(config.rules[0].priority, 100)
  assert.equal(config.rules[1].cooldownSeconds, 0)
  assert.equal(config.rules[1].priority, 0)
  assert.equal(config.rules[2].cooldownSeconds, 0)
  assert.equal(config.rules[2].priority, 0)
})

test('群范围过滤先于规则匹配，范围外不产生命中', () => {
  const config = buildConfig({ scope: { groups: ['other-room@chatroom'] } })
  const verdict = shouldReply(buildEvent(), config, new Map(), NOW)
  assert.equal(verdict.reason, 'scope')
  assert.equal(verdict.rule, null)
})
