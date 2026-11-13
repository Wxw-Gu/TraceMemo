const EXTENSION_ID = 'com.example.keyword-bot'
const PAGE_SOURCE = 'tracememo-extension-page'
const HOST_SOURCE = 'tracememo-extension-host'
const CONFIG_KEY = 'config'
const STATS_KEY = 'stats'
const CONFIG_VERSION = 2
const MAX_KEYWORD_LENGTH = 120
const MAX_REPLY_LENGTH = 2000
const STATS_PREVIEW = 5

const DEFAULT_CONFIG = {
  configVersion: CONFIG_VERSION,
  enabled: false,
  rules: [
    {
      id: 'rule-1',
      keyword: '你好',
      mode: 'contains',
      reply: '你好呀，{sender}！',
      cooldownSeconds: 30,
      enabled: true,
      priority: 0
    }
  ],
  scope: { groups: [], includeDirect: true, requireMentionMe: false }
}

const pending = new Map()
let sequence = 0
let config = clone(DEFAULT_CONFIG)

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function callHost(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = `req-${++sequence}`
    pending.set(requestId, { resolve, reject })
    window.parent.postMessage(
      { source: PAGE_SOURCE, extensionId: EXTENSION_ID, requestId, method, params },
      '*'
    )
  })
}

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.source !== HOST_SOURCE) return
  const entry = pending.get(data.requestId)
  if (!entry) return
  pending.delete(data.requestId)
  if (data.ok) entry.resolve(data.result)
  else entry.reject(new Error((data.error && data.error.message) || '调用失败'))
})

const rulesContainer = document.getElementById('rules')
const status = document.getElementById('status')
const statsSummary = document.getElementById('stats-summary')
const statsList = document.getElementById('stats-list')
const groupPicker = document.getElementById('group-picker')
const groupChips = document.getElementById('group-chips')
const groupSearch = document.getElementById('group-search')
const groupOptions = document.getElementById('group-options')

let allGroups = []
let selectedGroupIds = new Set()
let groupLoadError = ''

function groupDisplayName(group) {
  if (!group) return ''
  return group.name && group.name !== group.id ? `${group.name}（${group.id}）` : group.id
}

function renderGroupChips() {
  groupChips.textContent = ''
  groupChips.hidden = selectedGroupIds.size === 0
  for (const id of selectedGroupIds) {
    const group = allGroups.find((item) => item.id === id)
    const chip = document.createElement('span')
    chip.className = 'group-chip'
    const name = document.createElement('span')
    name.textContent = group ? group.name || id : id
    name.title = id
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'group-chip-remove'
    remove.textContent = '×'
    remove.setAttribute('aria-label', `移除 ${group ? group.name || id : id}`)
    remove.addEventListener('click', (event) => {
      event.stopPropagation()
      selectedGroupIds.delete(id)
      renderGroupChips()
      renderGroupOptions()
    })
    chip.append(name, remove)
    groupChips.append(chip)
  }
}

function renderGroupOptions() {
  if (groupOptions.hidden) return
  const query = groupSearch.value.trim().toLowerCase()
  groupOptions.textContent = ''
  if (groupLoadError) {
    groupOptions.append(emptyGroupOption(groupLoadError))
    return
  }
  if (!allGroups.length) {
    groupOptions.append(emptyGroupOption('未读取到群列表（请先连接微信数据库）'))
    return
  }
  const matches = allGroups.filter((group) => {
    if (!query) return true
    return group.id.toLowerCase().includes(query) || group.name.toLowerCase().includes(query)
  })
  if (!matches.length) {
    groupOptions.append(emptyGroupOption('没有匹配的群聊'))
    return
  }
  for (const group of matches.slice(0, 200)) {
    const option = document.createElement('label')
    option.className = 'group-option'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = selectedGroupIds.has(group.id)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedGroupIds.add(group.id)
      else selectedGroupIds.delete(group.id)
      renderGroupChips()
    })
    const text = document.createElement('span')
    text.textContent = groupDisplayName(group)
    option.append(checkbox, text)
    groupOptions.append(option)
  }
}

function emptyGroupOption(text) {
  const empty = document.createElement('div')
  empty.className = 'group-option-empty'
  empty.textContent = text
  return empty
}

function openGroupOptions() {
  groupOptions.hidden = false
  renderGroupOptions()
}

function closeGroupOptions() {
  groupOptions.hidden = true
  groupSearch.value = ''
}

groupSearch.addEventListener('focus', openGroupOptions)
groupSearch.addEventListener('input', openGroupOptions)
groupSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeGroupOptions()
    groupSearch.blur()
  }
})
document.addEventListener('click', (event) => {
  if (!groupPicker.contains(event.target)) closeGroupOptions()
})

async function loadGroups() {
  try {
    const result = await callHost('contacts.listGroups', {})
    allGroups = result && Array.isArray(result.groups) ? result.groups : []
    groupLoadError = ''
  } catch (error) {
    allGroups = []
    groupLoadError = `群列表读取失败：${error.message}`
  }
  renderGroupChips()
  renderGroupOptions()
}

function setStatus(text, kind) {
  status.textContent = text
  status.dataset.kind = kind || ''
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(Math.max(Math.round(numeric), min), max)
}

function newRuleId() {
  return `rule-${Date.now().toString(36)}`
}

/**
 * 页面侧的轻量规范化：只用于展示与回写，真正的判定在后台 lib/matcher.js。
 * 缺字段一律补默认值，保证 v1 配置打开后能直接编辑。
 */
function normalizeRule(rule, index) {
  const source = rule && typeof rule === 'object' ? rule : {}
  return {
    id: String(source.id || `rule-${index + 1}`).slice(0, 64),
    keyword: String(source.keyword == null ? '' : source.keyword).slice(0, MAX_KEYWORD_LENGTH),
    mode: ['contains', 'exact', 'prefix'].includes(source.mode) ? source.mode : 'contains',
    reply: String(source.reply == null ? '' : source.reply).slice(0, MAX_REPLY_LENGTH),
    cooldownSeconds: clampInteger(source.cooldownSeconds, 0, 3600, 0),
    enabled: source.enabled !== false,
    priority: clampInteger(source.priority, 0, 100, 0)
  }
}

function normalizeStoredConfig(stored) {
  if (!stored || typeof stored !== 'object') return clone(DEFAULT_CONFIG)
  const scope = stored.scope && typeof stored.scope === 'object' ? stored.scope : {}
  return {
    configVersion: CONFIG_VERSION,
    enabled: stored.enabled === true,
    rules: Array.isArray(stored.rules)
      ? stored.rules.map(normalizeRule)
      : clone(DEFAULT_CONFIG.rules),
    scope: {
      groups: Array.isArray(scope.groups)
        ? scope.groups.map((id) => String(id).trim()).filter(Boolean)
        : [],
      includeDirect: scope.includeDirect !== false,
      requireMentionMe: scope.requireMentionMe === true
    }
  }
}

function field(label, control) {
  const wrapper = document.createElement('label')
  wrapper.className = 'field'
  const caption = document.createElement('span')
  caption.textContent = label
  wrapper.append(caption, control)
  return wrapper
}

function renderRules() {
  rulesContainer.textContent = ''
  config.rules.forEach((rule, index) => {
    const card = document.createElement('article')
    card.className = 'rule-card'
    if (!rule.enabled) card.classList.add('is-disabled')

    const head = document.createElement('div')
    head.className = 'rule-head'
    const title = document.createElement('strong')
    title.textContent = `规则 ${index + 1}`
    const toggle = document.createElement('label')
    toggle.className = 'check'
    const enabledInput = document.createElement('input')
    enabledInput.type = 'checkbox'
    enabledInput.checked = rule.enabled
    enabledInput.addEventListener('change', () => {
      rule.enabled = enabledInput.checked
      card.classList.toggle('is-disabled', !rule.enabled)
    })
    const toggleText = document.createElement('span')
    toggleText.textContent = '启用'
    toggle.append(enabledInput, toggleText)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'ghost danger'
    remove.textContent = '删除'
    remove.addEventListener('click', () => {
      config.rules.splice(index, 1)
      renderRules()
    })
    const headActions = document.createElement('div')
    headActions.className = 'rule-head-actions'
    headActions.append(toggle, remove)
    head.append(title, headActions)

    const keywordInput = document.createElement('input')
    keywordInput.type = 'text'
    keywordInput.maxLength = MAX_KEYWORD_LENGTH
    keywordInput.value = rule.keyword
    keywordInput.addEventListener('input', () => {
      rule.keyword = keywordInput.value
    })

    const modeSelect = document.createElement('select')
    ;[
      ['contains', '包含'],
      ['exact', '完全匹配'],
      ['prefix', '以…开头']
    ].forEach(([value, label]) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      option.selected = rule.mode === value
      modeSelect.append(option)
    })
    modeSelect.addEventListener('change', () => {
      rule.mode = modeSelect.value
    })

    const replyInput = document.createElement('textarea')
    replyInput.rows = 2
    replyInput.maxLength = MAX_REPLY_LENGTH
    replyInput.value = rule.reply
    replyInput.addEventListener('input', () => {
      rule.reply = replyInput.value
    })
    const replyBlock = field('回复内容', replyInput)
    const replyHint = document.createElement('p')
    replyHint.className = 'hint'
    replyHint.textContent =
      '可用变量：{sender}（发送者）、{keyword}（命中词）、{time}（当前时间 HH:mm）'
    replyBlock.append(replyHint)

    const cooldownInput = document.createElement('input')
    cooldownInput.type = 'number'
    cooldownInput.min = '0'
    cooldownInput.max = '3600'
    cooldownInput.value = String(rule.cooldownSeconds)
    cooldownInput.addEventListener('change', () => {
      rule.cooldownSeconds = clampInteger(cooldownInput.value, 0, 3600, 0)
      cooldownInput.value = String(rule.cooldownSeconds)
    })

    const priorityInput = document.createElement('input')
    priorityInput.type = 'number'
    priorityInput.min = '0'
    priorityInput.max = '100'
    priorityInput.step = '1'
    priorityInput.value = String(rule.priority)
    priorityInput.addEventListener('change', () => {
      rule.priority = clampInteger(priorityInput.value, 0, 100, 0)
      priorityInput.value = String(rule.priority)
    })

    const numberRow = document.createElement('div')
    numberRow.className = 'field-row'
    const cooldownField = field('冷却时间（秒）', cooldownInput)
    const priorityField = field('优先级（0–100，越大越先匹配）', priorityInput)
    numberRow.append(cooldownField, priorityField)

    card.append(
      head,
      field('关键词', keywordInput),
      field('匹配方式', modeSelect),
      replyBlock,
      numberRow
    )
    rulesContainer.append(card)
  })
}

function syncForm() {
  document.getElementById('enabled').checked = config.enabled === true
  selectedGroupIds = new Set(config.scope.groups)
  renderGroupChips()
  renderGroupOptions()
  document.getElementById('include-direct').checked = config.scope.includeDirect !== false
  document.getElementById('require-mention').checked = config.scope.requireMentionMe === true
  renderRules()
}

function readForm() {
  config.enabled = document.getElementById('enabled').checked
  config.scope.groups = [...selectedGroupIds].slice(0, 200)
  config.scope.includeDirect = document.getElementById('include-direct').checked
  config.scope.requireMentionMe = document.getElementById('require-mention').checked
}

function localDateKey(timestamp) {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function formatClock(timestamp) {
  const date = new Date(timestamp)
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${hour}:${minute}`
}

/** 统计展示：只读 storage，不参与任何写入。 */
function renderStats(raw) {
  statsList.textContent = ''
  const now = Date.now()
  const sameDay = raw && raw.dateKey === localDateKey(now)
  const todayCount = sameDay ? Math.max(0, Math.floor(Number(raw.todayCount) || 0)) : 0
  const hits = raw && Array.isArray(raw.lastHits) ? raw.lastHits.filter((hit) => hit && hit.at) : []

  if (!hits.length && todayCount === 0) {
    statsSummary.textContent = '暂无命中记录'
    return
  }
  statsSummary.textContent = `今日命中 ${todayCount} 次`

  hits
    .slice(-STATS_PREVIEW)
    .reverse()
    .forEach((hit) => {
      const item = document.createElement('li')
      item.className = 'stats-item'
      const time = document.createElement('span')
      time.textContent = formatClock(Number(hit.at))
      const ruleId = document.createElement('code')
      ruleId.textContent = String(hit.ruleId || '未知规则')
      const result = document.createElement('span')
      result.className = hit.ok === true ? 'stats-ok' : 'stats-fail'
      result.textContent = hit.ok === true ? '成功' : '失败'
      item.append(time, ruleId, result)
      statsList.append(item)
    })
}

async function loadStats() {
  try {
    const stored = await callHost('storage.get', { key: STATS_KEY })
    renderStats(stored)
  } catch (error) {
    renderStats(null)
    setStatus(`统计读取失败：${error.message}`, 'error')
  }
}

document.getElementById('add-rule').addEventListener('click', () => {
  config.rules.push({
    id: newRuleId(),
    keyword: '',
    mode: 'contains',
    reply: '',
    cooldownSeconds: 30,
    enabled: true,
    priority: 0
  })
  renderRules()
})

document.getElementById('save').addEventListener('click', async () => {
  readForm()
  // 只有启用中的规则必须有内容：停用的草稿允许留空，方便先存后写。
  const invalid = config.rules.find(
    (rule) => rule.enabled && (!rule.keyword.trim() || !rule.reply.trim())
  )
  if (invalid) {
    setStatus('启用中的规则都需要关键词和回复内容；也可以先取消启用再保存。', 'error')
    return
  }
  const payload = {
    configVersion: CONFIG_VERSION,
    enabled: config.enabled === true,
    rules: config.rules.map(normalizeRule),
    scope: {
      groups: config.scope.groups.slice(0, 200),
      includeDirect: config.scope.includeDirect !== false,
      requireMentionMe: config.scope.requireMentionMe === true
    }
  }
  try {
    await callHost('storage.set', { key: CONFIG_KEY, value: payload })
    // 回写规范化结果但保留原对象引用：卡片上的输入事件仍在改这些对象。
    payload.rules.forEach((rule, index) => Object.assign(config.rules[index], rule))
    config.configVersion = CONFIG_VERSION
    setStatus('配置已保存。后台进程会在下一次收到消息时生效。', 'ok')
    loadStats()
  } catch (error) {
    setStatus(`保存失败：${error.message}`, 'error')
  }
})

document.getElementById('reset').addEventListener('click', async () => {
  config = clone(DEFAULT_CONFIG)
  syncForm()
  try {
    await callHost('storage.set', { key: CONFIG_KEY, value: config })
    setStatus('已恢复默认配置。', 'ok')
  } catch (error) {
    setStatus(`重置失败：${error.message}`, 'error')
  }
})

document.getElementById('refresh-stats').addEventListener('click', () => {
  loadStats()
})

async function boot() {
  const stored = await callHost('storage.get', { key: CONFIG_KEY })
  config = normalizeStoredConfig(stored)
  syncForm()
  await loadGroups()
  setStatus('配置已读取。默认不启用，避免安装后立即对外发送。')
  loadStats()
}

boot().catch((error) => setStatus(`加载失败：${error.message}`, 'error'))
