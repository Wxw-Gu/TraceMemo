'use strict'

/**
 * 关键词回复的纯函数层：配置规范化、匹配、范围判定、模板渲染、决策。
 *
 * 契约：
 * - 全部函数无副作用、不读写 storage、不打印日志，便于单测与后台进程复用；
 * - 输入一律容忍 `undefined` / 错误类型，坏配置退化为「不回复」而不是抛错；
 * - `enabled` 在任何一层都是硬开关：配置损坏时不能自动对外发送。
 */

/** 当前配置结构版本。v1 没有该字段，读取时按 v1 迁移。 */
const CONFIG_VERSION = 2

/** 与 UI、宿主动作输出保持一致的长度上限（字符）。 */
const MAX_RULE_ID_LENGTH = 64
const MAX_KEYWORD_LENGTH = 120
const MAX_REPLY_LENGTH = 2000
const MAX_GROUPS = 200

const MODES = new Set(['contains', 'exact', 'prefix'])

/**
 * 把任意来源的配置规范化为 `configVersion: 2`。
 *
 * 启用中的空规则丢弃，停用的空规则保留为草稿；顶层 `enabled` 缺省 `false`，
 * 配置缺失或损坏时宁可静默，也不能自动群发。
 *
 * @param {unknown} raw storage 里读出的原始值
 */
function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const sourceRules = Array.isArray(input.rules) ? input.rules : []
  const rules = sourceRules
    .filter((rule) => rule && typeof rule === 'object' && !Array.isArray(rule))
    .map((rule, index) => ({
      id: String(rule.id || `rule-${index + 1}`).slice(0, MAX_RULE_ID_LENGTH),
      keyword: String(rule.keyword == null ? '' : rule.keyword).slice(0, MAX_KEYWORD_LENGTH),
      mode: MODES.has(rule.mode) ? rule.mode : 'contains',
      reply: String(rule.reply == null ? '' : rule.reply).slice(0, MAX_REPLY_LENGTH),
      cooldownSeconds: clampNumber(rule.cooldownSeconds, 0, 3600),
      // v1 规则没有该字段；只有显式 false 才算禁用。
      enabled: rule.enabled !== false,
      priority: clampNumber(rule.priority, 0, 100)
    }))
    .filter((rule) => rule.enabled === false || (rule.keyword.trim() && rule.reply.trim()))

  const scope = input.scope && typeof input.scope === 'object' ? input.scope : {}
  return {
    configVersion: CONFIG_VERSION,
    enabled: input.enabled === true,
    rules,
    scope: {
      groups: Array.isArray(scope.groups)
        ? scope.groups
            .map((id) => String(id == null ? '' : id).trim())
            .filter(Boolean)
            .slice(0, MAX_GROUPS)
        : [],
      includeDirect: scope.includeDirect !== false,
      requireMentionMe: scope.requireMentionMe === true
    }
  }
}

/**
 * 单条规则是否命中文本：大小写不敏感；`exact` / `prefix` 先 trim，
 * `contains` 只 trim 关键词；空关键词恒为 false。
 *
 * @param {unknown} text 消息正文
 * @param {{ keyword?: unknown, mode?: unknown }} rule
 * @returns {boolean}
 */
function matchRule(text, rule) {
  const keyword = String((rule && rule.keyword) == null ? '' : rule.keyword)
    .trim()
    .toLowerCase()
  if (!keyword) return false
  const haystack = String(text == null ? '' : text).toLowerCase()
  const mode = rule && MODES.has(rule.mode) ? rule.mode : 'contains'
  if (mode === 'exact') return haystack.trim() === keyword
  if (mode === 'prefix') return haystack.trim().startsWith(keyword)
  return haystack.includes(keyword)
}

/**
 * 选出唯一命中的规则：`priority` 降序、同优先级保持数组顺序，取第一个命中。
 *
 * 这就是 stopOnMatch 语义：一条消息最多回复一次，命中即停。
 * 禁用规则（`enabled === false`）不参与匹配。
 *
 * @param {unknown} text
 * @param {object} config normalizeConfig 的产物
 */
function pickRule(text, config) {
  const rules = config && Array.isArray(config.rules) ? config.rules : []
  const candidates = rules
    .map((rule, index) => ({ rule, index }))
    .filter((item) => item.rule && item.rule.enabled !== false)
    // 显式带下标排序，避免依赖引擎排序稳定性。
    .sort((a, b) => (b.rule.priority || 0) - (a.rule.priority || 0) || a.index - b.index)
  for (const item of candidates) {
    if (matchRule(text, item.rule)) return item.rule
  }
  return null
}

/**
 * 会话是否在生效范围内。
 *
 * - 群聊：`groups` 为空表示全部群；非空时必须包含 `event.conversationId`；
 * - 私聊：只看 `includeDirect`。
 *
 * 范围在规则匹配之前判定：范围外的会话连匹配都不做，避免误触统计。
 */
function inScope(event, config) {
  const scope = (config && config.scope) || {}
  if (event && event.isGroup) {
    const groups = Array.isArray(scope.groups) ? scope.groups : []
    return groups.length === 0 || groups.includes(event.conversationId)
  }
  return scope.includeDirect !== false
}

/**
 * 渲染回复模板。
 *
 * 支持 `{sender}`（发送者昵称，空则「你」）、`{keyword}`（命中关键词）、
 * `{time}`（调用方给的本地时间字符串，缺省空串）。未知 `{xxx}` 原样保留，
 * 方便用户在模板里写其它占位而不是被静默吃掉。结果 trim 后截断到 2000 字符。
 */
function renderReply(template, ctx) {
  const source = String(template == null ? '' : template)
  const context = ctx && typeof ctx === 'object' ? ctx : {}
  const sender = String(context.senderName == null ? '' : context.senderName).trim() || '你'
  const keyword = String(context.keyword == null ? '' : context.keyword)
  const time = String(context.time == null ? '' : context.time)
  const rendered = source.replace(/\{(sender|keyword|time)\}/g, (match, token) => {
    if (token === 'sender') return sender
    if (token === 'keyword') return keyword
    if (token === 'time') return time
    return match
  })
  return rendered.trim().slice(0, MAX_REPLY_LENGTH)
}

/**
 * 综合决策：是否回复、用哪条规则、为什么。
 *
 * `reason` 取值固定，可直接用于日志/统计口径：
 * `disabled` | `self` | `type` | `scope` | `mention` | `no_match` | `cooldown` | `ok`。
 *
 * 判断顺序固定为：总开关 → 自己发的 → 消息类型 → 会话范围 → @ 要求 → 规则匹配 → 冷却。
 * 冷却键为 `conversationId:ruleId`，值为到期时间戳（epoch 毫秒），`now < until` 即冷却中。
 * 冷却表允许是 `Map` 或普通对象，后台进程重启后自然清空（宁可多回一条，也不跨重启误拦）。
 *
 * @param {object} event 宿主的 message.received 事件
 * @param {object} config normalizeConfig 的产物
 * @param {Map<string, number>|Record<string, number>} [cooldownUntil]
 * @param {number} [now] epoch 毫秒，缺省取当前时间
 */
function shouldReply(event, config, cooldownUntil, now) {
  if (!config || config.enabled !== true) {
    return { reply: false, rule: null, reason: 'disabled' }
  }
  if (!event || event.isSelf === true) {
    return { reply: false, rule: null, reason: 'self' }
  }
  if (event.type !== 'text') {
    return { reply: false, rule: null, reason: 'type' }
  }
  if (!inScope(event, config)) {
    return { reply: false, rule: null, reason: 'scope' }
  }
  if (config.scope && config.scope.requireMentionMe === true && event.mentionsMe !== true) {
    return { reply: false, rule: null, reason: 'mention' }
  }
  const rule = pickRule(event.text, config)
  if (!rule) {
    return { reply: false, rule: null, reason: 'no_match' }
  }
  const currentTime = Number.isFinite(now) ? now : Date.now()
  const key = `${event.conversationId}:${rule.id}`
  if (currentTime < readCooldown(cooldownUntil, key)) {
    return { reply: false, rule: null, reason: 'cooldown' }
  }
  return { reply: true, rule, reason: 'ok' }
}

/** 冷却表读取：兼容 Map 与普通对象，缺失值按 0（永不冷却）。 */
function readCooldown(table, key) {
  if (!table) return 0
  const value = table instanceof Map ? table.get(key) : table[key]
  const until = Number(value)
  return Number.isFinite(until) ? until : 0
}

/** 收敛到 [min, max] 的整数；非数字 / NaN 一律当 0。 */
function clampNumber(value, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.min(Math.max(Math.round(numeric), min), max)
}

module.exports = {
  CONFIG_VERSION,
  normalizeConfig,
  matchRule,
  pickRule,
  inScope,
  renderReply,
  shouldReply
}
