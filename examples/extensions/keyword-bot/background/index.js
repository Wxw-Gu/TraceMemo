/**
 * 关键词回复机器人。
 *
 * 两条入口共用同一份配置与 `lib/matcher.js` 的同一套判定：
 * 1. `message.received` 事件 → 自己判断范围 / 冷却 → `tm.wechat.send`；
 * 2. 自动化动作 `keyword.reply` → 只返回回复内容，由宿主 Gateway 发送。
 *
 * 发送**永远**经过宿主：本文件里没有任何 socket、dylib 或 HTTP 调用。
 * 匹配/规范化逻辑全部在 `lib/matcher.js`，本文件只负责编排与统计。
 */

const { normalizeConfig, pickRule, renderReply, shouldReply } = require('../lib/matcher.js')

const CONFIG_KEY = 'config'
const STATS_KEY = 'stats'
/** 配置缓存窗口：配置页保存后最多 1 秒生效，避免每条消息都读一次 storage。 */
const CONFIG_TTL_MS = 1000
/** 最近命中记录上限；只保留规则 id、时间与结果，不保留任何会话内容。 */
const STATS_HISTORY_LIMIT = 20
/** 冷却表清理阈值：超过后剔除已过期项，避免长期运行无限增长。 */
const COOLDOWN_PRUNE_SIZE = 500

let tm = null
let cachedConfig = null
let cachedAt = 0
let cachedStats = null
const cooldownUntil = new Map()
/** 统计写入串行化：并发消息不互相覆盖 `stats` 快照。 */
let statsChain = Promise.resolve()

function loadConfig() {
  if (cachedConfig && Date.now() - cachedAt < CONFIG_TTL_MS) return Promise.resolve(cachedConfig)
  return Promise.resolve(tm.storage.get(CONFIG_KEY))
    .then((stored) => {
      cachedConfig = normalizeConfig(stored)
      cachedAt = Date.now()
      return cachedConfig
    })
    .catch((error) => {
      tm.log.warn(`读取配置失败，本次按未启用处理：${describeError(error)}`)
      // 读失败也要缓存一小段时间，避免每条消息都打一次失败日志。
      cachedConfig = normalizeConfig(null)
      cachedAt = Date.now()
      return cachedConfig
    })
}

/** 本地时区的 `YYYY-MM-DD`，用于判定「今日」。 */
function statsDateKey(timestamp) {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 本地时区的 `HH:mm`，模板变量 `{time}` 与统计展示共用。 */
function formatClock(timestamp) {
  const date = new Date(timestamp)
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${hour}:${minute}`
}

function emptyStats(timestamp) {
  return { dateKey: statsDateKey(timestamp), todayCount: 0, lastHits: [] }
}

/**
 * 规范化统计快照。
 *
 * 跨日后 `todayCount` 归零；`lastHits` 作为滚动历史保留（它记的是「最近命中」，
 * 不是「今日命中」）。任何字段缺失或类型不对都退化为空值，统计损坏不能影响回复。
 */
function normalizeStats(raw, timestamp) {
  const base = emptyStats(timestamp)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const lastHits = Array.isArray(raw.lastHits)
    ? raw.lastHits
        .filter((hit) => hit && typeof hit === 'object')
        .map((hit) => ({
          at: Number(hit.at),
          ruleId: String(hit.ruleId == null ? '' : hit.ruleId).slice(0, 64),
          ok: hit.ok === true
        }))
        .filter((hit) => Number.isFinite(hit.at) && hit.at > 0 && hit.ruleId)
        .slice(-STATS_HISTORY_LIMIT)
    : []
  const sameDay = raw.dateKey === base.dateKey
  const count = sameDay ? Math.max(0, Math.floor(Number(raw.todayCount) || 0)) : 0
  return { dateKey: base.dateKey, todayCount: count, lastHits }
}

function loadStats() {
  if (cachedStats) return Promise.resolve(cachedStats)
  return Promise.resolve(tm.storage.get(STATS_KEY))
    .then((stored) => {
      cachedStats = normalizeStats(stored, Date.now())
      return cachedStats
    })
    .catch(() => {
      cachedStats = emptyStats(Date.now())
      return cachedStats
    })
}

/**
 * 追加一条命中记录并落库。
 *
 * 成功与失败都记；只写 `ruleId` / `at` / `ok`，绝不写会话 id、正文或昵称。
 * 写失败只 warn：统计是旁路，不能因为 storage 异常把回复一起吞掉。
 */
function recordHit(ruleId, ok) {
  statsChain = statsChain
    .then(async () => {
      const stats = await loadStats()
      const now = Date.now()
      const dateKey = statsDateKey(now)
      if (stats.dateKey !== dateKey) {
        stats.dateKey = dateKey
        stats.todayCount = 0
      }
      stats.todayCount += 1
      stats.lastHits = stats.lastHits
        .concat({ at: now, ruleId: String(ruleId || '').slice(0, 64), ok: ok === true })
        .slice(-STATS_HISTORY_LIMIT)
      await tm.storage.set(STATS_KEY, stats)
    })
    .catch((error) => {
      tm.log.warn(`命中统计写入失败：${describeError(error)}`)
    })
  return statsChain
}

/** 冷却只在真正发送成功后写入；发送失败不占冷却，下一条可以立刻重试。 */
function markCooldown(conversationId, rule, timestamp) {
  const seconds = Number(rule.cooldownSeconds) || 0
  cooldownUntil.set(`${conversationId}:${rule.id}`, timestamp + seconds * 1000)
  if (cooldownUntil.size > COOLDOWN_PRUNE_SIZE) {
    for (const [key, until] of cooldownUntil) {
      if (until <= timestamp) cooldownUntil.delete(key)
    }
  }
}

function describeError(error) {
  return error && error.message ? error.message : String(error)
}

async function onMessage(event) {
  try {
    const config = await loadConfig()
    const now = Date.now()
    const verdict = shouldReply(event, config, cooldownUntil, now)
    if (!verdict.reply || !verdict.rule) return

    const rule = verdict.rule
    const text = renderReply(rule.reply, {
      senderName: event.senderName,
      keyword: rule.keyword,
      time: formatClock(now)
    })

    try {
      await tm.wechat.send({
        to: event.conversationId,
        text,
        // 同一条微信消息在补投/重启后 eventId 不变，交给 Gateway 幂等短路。
        dedupeKey: event.eventId
      })
    } catch (error) {
      await recordHit(rule.id, false)
      throw error
    }

    markCooldown(event.conversationId, rule, Date.now())
    await recordHit(rule.id, true)
    tm.log.info(`关键词命中，已发送回复（规则 ${rule.id}）`)
  } catch (error) {
    tm.log.error(`自动回复失败：${describeError(error)}`)
  }
}

module.exports = function activate(api) {
  tm = api
  tm.events.on('message.received', onMessage)

  tm.automation.registerAction({
    id: 'keyword.reply',
    title: '关键词回复',
    description: '按机器人配置匹配关键词并返回回复内容',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    },
    async handler(input) {
      const config = await loadConfig()
      if (!config.enabled) {
        return { success: false, error: '机器人未启用' }
      }
      const rule = pickRule(input.text, config)
      if (!rule) {
        return { success: true, output: { matched: false } }
      }
      return {
        success: true,
        output: { matched: true, ruleId: rule.id },
        // 动作路径没有发送者上下文，`{sender}` 会渲染成「你」。
        reply: {
          type: 'text',
          text: renderReply(rule.reply, {
            keyword: rule.keyword,
            time: formatClock(Date.now())
          })
        }
      }
    }
  })

  tm.log.info('关键词回复机器人已加载')
}
