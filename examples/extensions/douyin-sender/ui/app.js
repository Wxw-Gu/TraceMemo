'use strict'

/**
 * 扩展页面桥。
 *
 * 页面只能通过宿主白名单能力与宿主通信，
 * 没有发送能力，也没有 `require`。
 */

const EXTENSION_ID = 'com.example.douyin-sender'
const PAGE_SOURCE = 'tracememo-extension-page'
const HOST_SOURCE = 'tracememo-extension-host'
const CONFIG_KEY = 'config'
const STATS_KEY = 'stats'
const PROGRESS_KEY = 'progress'
const TEST_RESULT_KEY = 'testResult'

const ALLOWED_METHODS = new Set([
  'storage.get',
  'storage.set',
  'storage.remove',
  'storage.list',
  'capabilities.get',
  'contacts.listGroups',
  'test.send',
  'douyin.cookie.get',
  'douyin.cookie.set',
  'douyin.cookie.clear',
  'extension.info'
])

const DEFAULT_CONFIG = {
  configVersion: 1,
  enabled: false,
  pythonPath: 'python3',
  scriptPath: 'scripts/douyin.py',
  quality: '720',
  showUi: false,
  ackText: '收到，正在解析，请稍候…',
  sendCaption: false,
  captionTemplate: '{author}：{title}',
  errorReply: true,
  includeDirect: false,
  groups: [],
  cooldownSeconds: 60,
  maxFileMB: 100
}

const STAGE_LABELS = {
  accepted: '已接收',
  resolve: '解析',
  resolveDownload: '解析并下载',
  download: '下载',
  send: '发送',
  caption: '补发文案',
  done: '完成',
  failed: '失败'
}

const pending = new Map()
let sequence = 0
let config = clone(DEFAULT_CONFIG)

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function callHost(method, params) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_METHODS.has(method)) {
      reject(new Error(`不支持的调用：${method}`))
      return
    }
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

const status = document.getElementById('status')
const rows = document.getElementById('job-rows')
const todayTotal = document.getElementById('today-total')
const todaySuccess = document.getElementById('today-success')
const todayFailure = document.getElementById('today-failure')
const progressBadge = document.getElementById('progress-badge')
const progressStage = document.getElementById('progress-stage')
const progressTime = document.getElementById('progress-time')
const progressDetail = document.getElementById('progress-detail')
const testGroup = document.getElementById('test-group')
const testUrl = document.getElementById('test-url')
const cookieHeader = document.getElementById('cookie-header')
const cookieState = document.getElementById('cookie-state')
const testResult = document.getElementById('test-result')
const groupPicker = document.getElementById('group-picker')
const groupChips = document.getElementById('group-chips')
const groupSearch = document.getElementById('group-search')
const groupOptions = document.getElementById('group-options')

let allGroups = []
let selectedGroupIds = new Set()
let groupLoadError = ''

function setStatus(text, kind) {
  status.textContent = text
  status.dataset.kind = kind || ''
}

function clampInt(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(Math.trunc(numeric), max))
}

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const quality = ['', '1080', '720', '540'].includes(String(input.quality))
    ? String(input.quality)
    : DEFAULT_CONFIG.quality
  return {
    configVersion: 1,
    enabled: input.enabled === true,
    pythonPath: String(input.pythonPath || DEFAULT_CONFIG.pythonPath).trim(),
    scriptPath: String(input.scriptPath || DEFAULT_CONFIG.scriptPath).trim(),
    quality,
    showUi: input.showUi === true,
    ackText:
      input.ackText === undefined
        ? DEFAULT_CONFIG.ackText
        : String(input.ackText).trim().slice(0, 200),
    sendCaption: false,
    captionTemplate: String(input.captionTemplate || DEFAULT_CONFIG.captionTemplate).slice(0, 200),
    errorReply: input.errorReply !== false,
    includeDirect: input.includeDirect === true,
    groups: Array.isArray(input.groups)
      ? input.groups
          .map((id) => String(id).trim())
          .filter(Boolean)
          .slice(0, 200)
      : [],
    cooldownSeconds: clampInt(input.cooldownSeconds, DEFAULT_CONFIG.cooldownSeconds, 0, 3600),
    maxFileMB: clampInt(input.maxFileMB, DEFAULT_CONFIG.maxFileMB, 1, 100)
  }
}

function syncForm() {
  document.getElementById('enabled').checked = config.enabled === true
  document.getElementById('python-path').value = config.pythonPath
  document.getElementById('script-path').value = config.scriptPath
  document.getElementById('quality').value = config.quality
  document.getElementById('show-ui').checked = config.showUi === true
  document.getElementById('ack-text').value = config.ackText
  document.getElementById('error-reply').checked = config.errorReply === true
  selectedGroupIds = new Set(config.groups)
  renderGroupChips()
  renderGroupOptions()
  document.getElementById('include-direct').checked = config.includeDirect === true
  document.getElementById('cooldown').value = String(config.cooldownSeconds)
  document.getElementById('max-file-mb').value = String(config.maxFileMB)
}

function readForm() {
  config.enabled = document.getElementById('enabled').checked
  config.pythonPath = document.getElementById('python-path').value.trim()
  config.scriptPath = document.getElementById('script-path').value.trim()
  config.quality = document.getElementById('quality').value
  config.showUi = document.getElementById('show-ui').checked
  config.ackText = document.getElementById('ack-text').value.trim().slice(0, 200)
  config.sendCaption = false
  config.errorReply = document.getElementById('error-reply').checked
  config.groups = [...selectedGroupIds].slice(0, 200)
  config.includeDirect = document.getElementById('include-direct').checked
  config.cooldownSeconds = clampInt(
    document.getElementById('cooldown').value,
    DEFAULT_CONFIG.cooldownSeconds,
    0,
    3600
  )
  config.maxFileMB = clampInt(
    document.getElementById('max-file-mb').value,
    DEFAULT_CONFIG.maxFileMB,
    1,
    100
  )
  config.configVersion = 1
}

function formatTime(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return '—'
  const date = new Date(numeric)
  const pad = (part) => String(part).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function renderStats(raw) {
  const stats = raw && typeof raw === 'object' ? raw : {}
  const jobs = Array.isArray(stats.lastJobs) ? stats.lastJobs.slice(0, 8) : []
  const total = Math.max(0, Math.trunc(Number(stats.todayTotal ?? stats.todayCount) || 0))
  todayTotal.textContent = String(total)
  todaySuccess.textContent = String(Math.max(0, Math.trunc(Number(stats.todaySuccess) || 0)))
  todayFailure.textContent = String(Math.max(0, Math.trunc(Number(stats.todayFailure) || 0)))
  rows.textContent = ''
  if (!jobs.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 5
    cell.className = 'empty'
    cell.textContent = '暂无记录'
    row.append(cell)
    rows.append(row)
    return
  }
  for (const job of jobs) {
    const row = document.createElement('tr')
    const time = document.createElement('td')
    time.textContent = formatTime(job && job.at)
    const id = document.createElement('td')
    id.className = 'mono'
    id.textContent = (job && job.awemeId) || '—'
    const stage = document.createElement('td')
    stage.textContent = STAGE_LABELS[job && job.stage] || (job && job.stage) || '—'
    const result = document.createElement('td')
    const ok = job && job.ok === true
    result.textContent = ok ? '成功' : '失败'
    result.className = ok ? 'ok' : 'fail'
    const error = document.createElement('td')
    error.className = 'mono'
    error.textContent = (job && job.errorType) || '—'
    row.append(time, id, stage, result, error)
    rows.append(row)
  }
}

/** 进度：运行中显示阶段与已用时间；失败显示失败阶段与错误码。 */
function renderProgress(raw) {
  const progress = raw && typeof raw === 'object' ? raw : null
  if (!progress || !progress.stage) {
    progressBadge.textContent = '空闲'
    progressBadge.dataset.status = 'idle'
    progressStage.textContent = '暂无任务'
    progressTime.textContent = ''
    progressDetail.textContent = '触发后这里会显示解析、下载、发送进行到哪一步。'
    return
  }
  const status =
    progress.status === 'failed' ? 'failed' : progress.status === 'done' ? 'done' : 'running'
  progressBadge.textContent = status === 'failed' ? '失败' : status === 'done' ? '完成' : '进行中'
  progressBadge.dataset.status = status
  progressStage.textContent =
    status === 'failed'
      ? `失败于：${STAGE_LABELS[progress.stage] || progress.stage}`
      : status === 'done'
        ? '已完成'
        : `正在${STAGE_LABELS[progress.stage] || progress.stage}`
  const startedAt = Number(progress.startedAt)
  // 运行中用当前时间计算，脚本卡住时秒数也会继续走，不会看起来停在 0s。
  const updatedAt = status === 'running' ? Date.now() : Number(progress.updatedAt) || Date.now()
  const elapsed =
    Number.isFinite(startedAt) && startedAt > 0
      ? Math.max(0, Math.round((updatedAt - startedAt) / 1000))
      : null
  progressTime.textContent = elapsed === null ? '' : `· ${elapsed}s`
  const parts = []
  if (progress.awemeId) parts.push(`作品 ${progress.awemeId}`)
  if (status === 'failed' && progress.errorType) parts.push(`错误 ${progress.errorType}`)
  if (status === 'failed' && progress.errorMessage) parts.push(progress.errorMessage)
  if (status === 'done') parts.push('视频已发送')
  progressDetail.textContent = parts.join(' · ') || ''
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

async function loadProgress() {
  try {
    const stored = await callHost('storage.get', { key: PROGRESS_KEY })
    renderProgress(stored)
  } catch {
    renderProgress(null)
  }
}

let testPollTimer = null
let activeTestId = ''

function setTestResult(text, kind) {
  testResult.textContent = text
  testResult.dataset.kind = kind || ''
}

function groupDisplayName(group) {
  if (!group) return ''
  return group.name && group.name !== group.id ? `${group.name}（${group.id}）` : group.id
}

function emptyGroupOption(text) {
  const empty = document.createElement('div')
  empty.className = 'group-option-empty'
  empty.textContent = text
  return empty
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

/** 群列表来自宿主通讯录；数据库未连接时给出明确空态，而不是假装有选项。 */
async function loadGroups() {
  const current = testGroup.value
  try {
    const result = await callHost('contacts.listGroups', {})
    allGroups = result && Array.isArray(result.groups) ? result.groups : []
    groupLoadError = ''
    testGroup.textContent = ''
    if (!allGroups.length) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = '未读取到群列表（请先连接微信数据库）'
      testGroup.append(option)
      renderGroupChips()
      renderGroupOptions()
      return
    }
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = '请选择群聊'
    testGroup.append(placeholder)
    for (const group of allGroups) {
      const option = document.createElement('option')
      option.value = group.id
      option.textContent = groupDisplayName(group)
      testGroup.append(option)
    }
    const saved = await callHost('storage.get', { key: 'testGroup' }).catch(() => null)
    const target = current || (typeof saved === 'string' ? saved : '')
    if (target && allGroups.some((group) => group.id === target)) testGroup.value = target
  } catch (error) {
    allGroups = []
    groupLoadError = `群列表读取失败：${error.message}`
    testGroup.textContent = ''
    const option = document.createElement('option')
    option.value = ''
    option.textContent = groupLoadError
    testGroup.append(option)
  }
  renderGroupChips()
  renderGroupOptions()
}

/** 轮询后台写入的测试结果；只认本次请求的 id，避免串台。 */
async function pollTestResult() {
  if (!activeTestId) return
  window.clearTimeout(testPollTimer)
  try {
    const result = await callHost('storage.get', { key: TEST_RESULT_KEY })
    if (result && result.id === activeTestId) {
      if (result.status === 'running') {
        setTestResult(result.message || '处理中…', 'running')
      } else if (result.status === 'done') {
        setTestResult(result.message || '测试发送完成', 'ok')
        activeTestId = ''
        return
      } else if (result.status === 'failed') {
        setTestResult(result.message || '测试发送失败', 'error')
        activeTestId = ''
        return
      }
    }
  } catch {
    // 单次读取失败继续重试。
  }
  testPollTimer = window.setTimeout(() => {
    void pollTestResult()
  }, 1500)
}

async function loadConfig() {
  const stored = await callHost('storage.get', { key: CONFIG_KEY })
  config = normalizeConfig(stored)
  syncForm()
}

async function loadCookieState() {
  try {
    const result = await callHost('douyin.cookie.get', {})
    cookieState.textContent =
      result && result.configured ? '已保存 Cookie（内容不可回显）' : '未配置'
  } catch {
    cookieState.textContent = '安全存储不可用，无法读取状态'
  }
}
void loadCookieState()

async function checkCapabilities() {
  try {
    const snapshot = await callHost('capabilities.get', {})
    const send = snapshot && snapshot.send ? snapshot.send : null
    if (!send || !send.canSendVideo) {
      setStatus('当前环境未就绪：视频发送通道不可用，配置仍可保存。', 'error')
      return true
    }
  } catch {
    // 能力查询失败不阻塞配置编辑。
  }
  return false
}

testGroup.addEventListener('change', () => {
  void callHost('storage.set', { key: 'testGroup', value: testGroup.value }).catch(() => undefined)
})

document.getElementById('test-refresh').addEventListener('click', () => {
  void loadGroups()
})

document.getElementById('test-send').addEventListener('click', async () => {
  const to = testGroup.value
  const text = testUrl.value.trim()
  if (!to) {
    setTestResult('请先选择目标群聊。', 'error')
    return
  }
  if (!text) {
    setTestResult('请粘贴抖音分享链接或整段分享文案。', 'error')
    return
  }
  activeTestId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  setTestResult('已提交，等待后台开始解析…', 'running')
  try {
    const submitted = callHost('test.send', {
      id: activeTestId,
      to,
      text,
      at: Date.now()
    })
    void pollTestResult()
    await submitted
  } catch (error) {
    activeTestId = ''
    setTestResult(`提交失败：${error.message}`, 'error')
  }
})

document.getElementById('cookie-save').addEventListener('click', async () => {
  const value = cookieHeader.value.trim()
  if (!value) {
    setStatus('请先粘贴抖音 Cookie。', 'error')
    return
  }
  try {
    await callHost('douyin.cookie.set', { cookieHeader: value })
    cookieHeader.value = ''
    await loadCookieState()
    setStatus('Cookie 已安全保存。', 'ok')
  } catch (error) {
    setStatus(`Cookie 保存失败：${error.message}`, 'error')
  }
})

document.getElementById('cookie-clear').addEventListener('click', async () => {
  try {
    await callHost('douyin.cookie.clear', {})
    cookieHeader.value = ''
    await loadCookieState()
    setStatus('Cookie 已清除。', 'ok')
  } catch (error) {
    setStatus(`Cookie 清除失败：${error.message}`, 'error')
  }
})

document.getElementById('save').addEventListener('click', async () => {
  readForm()
  if (!config.pythonPath) {
    setStatus('Python 可执行文件不能为空。', 'error')
    return
  }
  if (!config.scriptPath) {
    setStatus('解析脚本路径不能为空。', 'error')
    return
  }
  if (!config.captionTemplate.trim() && config.sendCaption) {
    setStatus('已开启标题文案，模板不能为空。', 'error')
    return
  }
  try {
    await callHost('storage.set', { key: CONFIG_KEY, value: config })
    setStatus('配置已保存，后台 1 秒内生效', 'ok')
  } catch (error) {
    setStatus(`保存失败：${error.message}`, 'error')
  }
})

document.getElementById('reload').addEventListener('click', async () => {
  try {
    await loadConfig()
    await loadStats()
    await loadProgress()
    setStatus('已重新读取配置。', 'ok')
  } catch (error) {
    setStatus(`读取失败：${error.message}`, 'error')
  }
})

async function boot() {
  await loadConfig()
  await Promise.all([loadStats(), loadProgress(), loadGroups()])
  const blocked = await checkCapabilities()
  if (!blocked) setStatus('配置已读取。默认不启用，避免安装后立即对外发送。')
  // 页面打开期间轮询进度，任务跑到哪一步不用猜；统计低频刷新即可。
  window.setInterval(() => {
    void loadProgress()
  }, 2000)
  window.setInterval(() => {
    void loadStats()
  }, 6000)
}

boot().catch((error) => setStatus(`加载失败：${error.message}`, 'error'))
