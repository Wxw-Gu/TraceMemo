export const EXPORT_PAGE_SIZE = 240

export const exportStyles = `
:root {
  color-scheme: light;
  --page: #edf2f0;
  --panel: #fff;
  --text: #1d2a25;
  --muted: #68766f;
  --border: #d8e2dc;
  --mine: #d9f0e2;
  --accent: #176b57;
  --accent-soft: #e4f2ec;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--page);
  color: var(--text);
  font: 14px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.page {
  max-width: 1380px;
  height: 100vh;
  margin: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
}
.toolbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 14px 24px;
  align-items: center;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 16px 20px;
  box-shadow: 0 8px 24px #29483b12;
}
.title { font-size: 18px; font-weight: 750; }
.meta { color: var(--muted); margin-left: 12px; font-size: 13px; }
.controls { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
.controls input, .filter-button {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 11px;
  background: #fff;
  color: var(--text);
  font: inherit;
}
.controls input[type=search] { width: min(320px, 34vw); }
.filters {
  grid-column: 1 / -1;
  display: flex;
  gap: 7px;
  align-items: center;
  flex-wrap: wrap;
}
.filter-button { cursor: pointer; }
.filter-button.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.count { margin-left: auto; color: var(--muted); font-size: 13px; }
.archive-layout {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 18px;
  min-height: 0;
  flex: 1;
  margin-top: 16px;
}
.timeline {
  overflow: auto;
  background: #f7faf8;
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 12px 9px;
}
.timeline-empty { padding: 10px; color: var(--muted); font-size: 12px; }
.timeline-year { margin: 6px 7px 5px; color: var(--text); font-size: 13px; font-weight: 700; }
.timeline-month {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  border: 0;
  border-left: 3px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  padding: 7px 8px;
  cursor: pointer;
  text-align: left;
}
.timeline-month:hover, .timeline-month.active {
  border-left-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.timeline-month small { color: inherit; }
.scroll { overflow: auto; min-width: 0; padding: 10px 8px 36px; }
.lazy-hint {
  width: min(100%, 820px);
  margin: 0 auto 12px;
  padding: 7px 12px;
  border-radius: 999px;
  background: #e4ece8;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
.message {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: min(100%, 820px);
  margin: 0 auto 22px;
}
.message.sent { align-items: flex-end; }
.message.system { align-items: center; }
.message.system .row { justify-content: center; }
.message.system .avatar { display: none; }
.message.system .bubble {
  max-width: 92%;
  padding: 5px 10px;
  border: 0;
  border-radius: 5px;
  background: #e9eeeb;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
  box-shadow: none;
}
.message.system .sender { display: none; }
.time { color: var(--muted); font-size: 11px; margin: 0 12px; }
.row { display: flex; gap: 12px; align-items: flex-end; max-width: 100%; }
.sent .row { flex-direction: row-reverse; }
.avatar {
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border-radius: 50%;
  overflow: hidden;
  background: #dcebe4;
  display: grid;
  place-items: center;
}
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.bubble {
  min-width: 0;
  max-width: min(78%, 760px);
  padding: 13px 15px;
  border: 1px solid var(--border);
  border-radius: 10px 18px 18px 18px;
  background: #fff;
  box-shadow: 0 4px 12px #29483b0d;
}
.sent .bubble { background: var(--mine); border-color: #c7e6d4; border-radius: 18px 10px 18px 18px; }
.sender { color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.content { line-height: 1.7; word-break: break-word; white-space: pre-wrap; }
.audio-wrap { width: 260px; max-width: 100%; min-width: 0; }
.audio { display: block; width: 100%; max-width: 100%; height: 38px; }
.media-status {
  margin-top: 8px;
  padding: 6px 8px;
  border-left: 3px solid #b27a18;
  background: #fff8e8;
  color: #79530f;
  font-size: 12px;
  line-height: 1.5;
}
.file-attachment {
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: 320px;
  margin: 2px 0 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #f7faf8;
  color: var(--accent);
  font-weight: 650;
  text-decoration: none;
  word-break: break-all;
}
.file-attachment:hover { text-decoration: underline; }
.quote-reference {
  margin-top: 10px;
  padding: 8px 11px;
  border-left: 3px solid #8eb4a3;
  background: #f1f6f3;
  color: var(--muted);
  display: grid;
  gap: 3px;
}
.quote-reference strong { font-weight: 650; color: var(--text); }
.quote-reference span { white-space: pre-wrap; }
.media-image {
  display: block;
  max-width: 100%;
  max-height: 420px;
  margin-bottom: 8px;
  border-radius: 12px;
  object-fit: contain;
  background: #eef2f5;
}
.media-image[data-preview] { cursor: zoom-in; }
.empty { display: grid; place-items: center; min-height: 260px; color: var(--muted); text-align: center; }
.lightbox {
  position: fixed;
  inset: 0;
  display: none;
  place-items: center;
  background: #14231ddd;
  z-index: 10;
  padding: 24px;
  overflow: auto;
}
.lightbox.open { display: grid; }
.lightbox img {
  width: min(86vw, 980px);
  max-height: 88vh;
  object-fit: contain;
  cursor: zoom-in;
  transform: scale(var(--zoom, 1));
  transform-origin: center;
  transition: transform .12s ease;
}
.lightbox-close {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 11;
  width: 42px;
  height: 42px;
  border: 1px solid #ffffff66;
  border-radius: 50%;
  background: #14231dcc;
  color: #fff;
  font-size: 30px;
  line-height: 1;
  cursor: pointer;
}
@media (max-width: 760px) {
  .page { padding: 10px; }
  .toolbar { grid-template-columns: 1fr; padding: 13px; }
  .controls { justify-content: flex-start; }
  .controls input[type=search] { width: 100%; }
  .filters { grid-column: 1; }
  .count { width: 100%; margin-left: 0; }
  .archive-layout { grid-template-columns: 1fr; margin-top: 10px; }
  .timeline { display: flex; gap: 6px; overflow: auto; padding: 8px; }
  .timeline-year { display: none; }
  .timeline-month {
    flex: 0 0 auto;
    width: auto;
    border-left: 0;
    border-bottom: 3px solid transparent;
  }
  .timeline-month:hover, .timeline-month.active {
    border-left-color: transparent;
    border-bottom-color: var(--accent);
  }
  .bubble { max-width: calc(100vw - 92px); }
  .audio-wrap { width: min(260px, calc(100vw - 130px)); }
}
`

const safe = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ||
      character
  )

const renderExportScript = (name: string): string => `
(() => {
  'use strict'
  const PAGE_SIZE = ${EXPORT_PAGE_SIZE}
  const WINDOW_STEP = Math.floor(PAGE_SIZE / 2)
  const archive = window.__WECHAT_EXPORT__ || { name: ${JSON.stringify(name)}, messages: [] }
  const allMessages = Array.isArray(archive.messages) ? archive.messages : []
  const list = document.querySelector('#messages')
  const timeline = document.querySelector('#timeline')
  const query = document.querySelector('#query')
  const count = document.querySelector('#count')
  const meta = document.querySelector('#archive-meta')
  const title = document.querySelector('#archive-title')
  const filters = document.querySelector('#filters')
  const box = document.querySelector('#lightbox')
  const preview = document.querySelector('#lightbox-image')
  const closeButton = document.querySelector('#lightbox-close')
  let activeKind = 'all'
  let filtered = []
  let windowStart = 0
  let windowEnd = 0
  let scrollLoadPending = false
  let scrollLoadSuppressed = false
  let lastScrollTop = 0
  let zoom = 1

  const nextFrame = (callback) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(callback)
    } else {
      window.setTimeout(callback, 0)
    }
  }

  const esc = (value) => String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character
  )
  const pad = (value) => String(value).padStart(2, '0')
  const fullTime = (message) => {
    const timestamp = Number(message.createTime || 0)
    if (!timestamp) return String(message.datetime || '')
    const date = new Date(timestamp * 1000)
    if (Number.isNaN(date.getTime())) return String(message.datetime || '')
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  }
  const monthKey = (message) => {
    const timestamp = Number(message.createTime || 0)
    if (!timestamp) return 'unknown'
    const date = new Date(timestamp * 1000)
    return date.getFullYear() + '-' + pad(date.getMonth() + 1)
  }
  const kindOf = (message) => {
    const data = message.contentData || {}
    if (message.exportMediaType === 'file' || (data.type === 'share' && String(data.typeVal) === '6')) return 'file'
    if (
      message.exportMediaType === 'image' || message.exportMediaType === 'video' ||
      message.exportMediaType === 'sticker' || data.type === 'image' ||
      data.type === 'video' || data.type === 'sticker'
    ) return 'media'
    if (message.voiceDataUrl || data.type === 'voice' || message.type === '语音') return 'voice'
    if (
      data.type === 'share' || data.type === 'location' ||
      data.type === 'miniProgram' || data.type === 'forwardBundle'
    ) return 'share'
    if (data.type === 'system' || data.type === 'unknown' || message.from === 'system') return 'system'
    return 'text'
  }
  const searchText = (message) => [
    message.name,
    message.senderId,
    message.content,
    message.type,
    message.contentData && message.contentData.title,
    message.contentData && message.contentData.quotedSender,
    message.contentData && message.contentData.quotedContent,
    message.exportMediaName
  ].filter(Boolean).join(' ').toLowerCase()

  const renderMessage = (message, archiveIndex) => {
    const data = message.contentData || {}
    const mediaUrl = message.exportMediaUrl ? esc(message.exportMediaUrl) : ''
    const mediaType = message.exportMediaType || data.type
    let media = ''
    if (mediaUrl && mediaType === 'image') {
      media = '<img class="media-image" data-preview src="' + mediaUrl + '" alt="图片">'
    } else if (mediaUrl && mediaType === 'video') {
      media = '<video class="media-image" controls preload="metadata" src="' + mediaUrl + '"></video>'
    } else if (mediaUrl && mediaType === 'sticker') {
      media = '<img class="media-image" data-preview src="' + mediaUrl + '" alt="表情包">'
    } else if (mediaUrl && mediaType === 'file') {
      const fileName = esc(message.exportMediaName || data.title || '下载文件')
      media = '<a class="file-attachment" href="' + mediaUrl + '" download><span>📎</span><span>' + fileName + '</span></a>'
    }
    const audio = message.voiceDataUrl
      ? '<div class="audio-wrap"><audio class="audio" controls preload="metadata" src="' + esc(message.voiceDataUrl) + '"></audio></div>'
      : ''
    const mediaStatus = message.exportMediaError
      ? '<div class="media-status">' + esc(message.exportMediaError) + '</div>'
      : ''
    const quote = data.type === 'quote'
      ? '<div class="quote-reference"><strong>' + esc(data.quotedSender || '引用消息') + '</strong><span>' + esc(data.quotedContent || '[引用消息]') + '</span></div>'
      : ''
    const isSystem = data.type === 'system' && data.pat
    const sender = message.name || (message.isSender ? '我' : '联系人')
    const avatarFallback = esc(String(sender || '友').slice(0, 1))
    const avatar = message.exportShowAvatar === false
      ? ''
      : '<div class="avatar">' + (message.exportAvatarUrl
          ? '<img src="' + esc(message.exportAvatarUrl) + '" alt="">'
          : avatarFallback) + '</div>'
    const text = message.content || (data.type === 'quote' ? data.title : '')
    const content = esc(text || (!media && !audio && !quote ? '[' + (message.type || '消息') + ']' : ''))
    return '<article class="message' + (message.isSender ? ' sent' : '') + (isSystem ? ' system' : '') +
      '" data-index="' + archiveIndex + '" data-month="' + esc(monthKey(message)) + '">' +
      '<div class="time">' + esc(fullTime(message)) + '</div><div class="row">' +
      (isSystem ? '' : avatar) + '<div class="bubble"><div class="sender">' +
      (isSystem ? '' : esc(sender)) + '</div>' + media + audio + quote +
      '<div class="content">' + content + '</div>' + mediaStatus + '</div></div></article>'
  }

  const renderTimeline = () => {
    if (filtered.length === 0) {
      timeline.innerHTML = '<div class="timeline-empty">没有可跳转的月份</div>'
      return
    }
    const groups = new Map()
    for (const message of filtered) {
      const key = monthKey(message)
      if (key === 'unknown') continue
      groups.set(key, (groups.get(key) || 0) + 1)
    }
    let currentYear = ''
    let html = ''
    for (const [key, total] of groups) {
      const parts = key.split('-')
      if (parts[0] !== currentYear) {
        currentYear = parts[0]
        html += '<div class="timeline-year">' + esc(currentYear) + ' 年</div>'
      }
      html += '<button class="timeline-month" type="button" data-month="' + esc(key) + '">' +
        '<span>' + Number(parts[1]) + ' 月</span><small>' + total + '</small></button>'
    }
    timeline.innerHTML = html || '<div class="timeline-empty">时间信息不可用</div>'
  }

  const updateActiveMonth = () => {
    const first = list.querySelector('.message')
    const key = first && first.dataset.month
    timeline.querySelectorAll('.timeline-month').forEach((button) => {
      button.classList.toggle('active', button.dataset.month === key)
    })
  }
  const updateCount = () => {
    const shown = Math.max(0, windowEnd - windowStart)
    count.textContent = '已显示 ' + shown + ' / 筛选 ' + filtered.length + ' / 全部 ' + allMessages.length
  }
  const setScrollTop = (value) => {
    scrollLoadSuppressed = true
    const previousBehavior = list.style.scrollBehavior
    list.style.scrollBehavior = 'auto'
    list.scrollTop = value
    lastScrollTop = list.scrollTop
    nextFrame(() => {
      list.style.scrollBehavior = previousBehavior
      lastScrollTop = list.scrollTop
      scrollLoadSuppressed = false
    })
  }
  const renderWindow = (anchorIndex, anchorOffset) => {
    const visible = filtered.slice(windowStart, windowEnd)
    const before = windowStart > 0 ? '<div class="lazy-hint">向上滚动加载更早消息</div>' : ''
    const after = windowEnd < filtered.length ? '<div class="lazy-hint">向下滚动加载更多消息</div>' : ''
    list.innerHTML = visible.length
      ? before + visible.map((message, index) => renderMessage(message, windowStart + index)).join('') + after
      : '<div class="empty">没有符合条件的消息<br><small>可以更换筛选条件或关键词</small></div>'
    if (Number.isInteger(anchorIndex)) {
      const anchor = list.querySelector('.message[data-index="' + anchorIndex + '"]')
      if (anchor) setScrollTop(anchor.offsetTop - anchorOffset)
    }
    updateCount()
    updateActiveMonth()
  }
  const resetWindow = (preferLatest) => {
    windowEnd = filtered.length
    windowStart = Math.max(0, windowEnd - PAGE_SIZE)
    if (!preferLatest) {
      windowStart = 0
      windowEnd = Math.min(filtered.length, PAGE_SIZE)
    }
    renderWindow()
    setScrollTop(preferLatest ? list.scrollHeight : 0)
  }
  const applyFilters = () => {
    const term = query.value.trim().toLowerCase()
    filtered = allMessages.filter((message) =>
      (activeKind === 'all' || kindOf(message) === activeKind) &&
      (!term || searchText(message).includes(term))
    )
    renderTimeline()
    resetWindow(true)
  }
  const jumpToMonth = (key) => {
    const index = filtered.findIndex((message) => monthKey(message) === key)
    if (index < 0) return
    windowStart = Math.max(0, index - Math.floor(PAGE_SIZE / 4))
    windowEnd = Math.min(filtered.length, windowStart + PAGE_SIZE)
    windowStart = Math.max(0, windowEnd - PAGE_SIZE)
    renderWindow()
    const target = list.querySelector('.message[data-index="' + index + '"]')
    setScrollTop(target ? Math.max(0, target.offsetTop - 24) : 0)
    timeline.querySelectorAll('.timeline-month').forEach((button) => {
      button.classList.toggle('active', button.dataset.month === key)
    })
  }
  const slideWindow = (direction) => {
    const renderedMessages = list.querySelectorAll('.message')
    const anchor =
      direction < 0 ? renderedMessages[0] : renderedMessages[renderedMessages.length - 1]
    const anchorIndex = anchor ? Number(anchor.dataset.index) : undefined
    const anchorOffset = anchor ? anchor.offsetTop - list.scrollTop : 0
    if (direction < 0) {
      windowStart = Math.max(0, windowStart - WINDOW_STEP)
      windowEnd = Math.min(filtered.length, windowStart + PAGE_SIZE)
    } else {
      windowEnd = Math.min(filtered.length, windowEnd + WINDOW_STEP)
      windowStart = Math.max(0, windowEnd - PAGE_SIZE)
    }
    renderWindow(anchorIndex, anchorOffset)
  }

  const scheduleWindowSlide = (direction) => {
    if (scrollLoadPending) return
    scrollLoadPending = true
    nextFrame(() => {
      if (direction < 0 ? windowStart > 0 : windowEnd < filtered.length) {
        slideWindow(direction)
      }
      scrollLoadPending = false
    })
  }
  list.addEventListener('scroll', () => {
    const currentTop = list.scrollTop
    const movingUp = currentTop < lastScrollTop
    const nearTop = currentTop < 180
    const nearBottom = list.scrollHeight - currentTop - list.clientHeight < 240
    lastScrollTop = currentTop
    if (scrollLoadSuppressed) return
    if (movingUp && nearTop) scheduleWindowSlide(-1)
    else if (!movingUp && nearBottom) scheduleWindowSlide(1)
  })
  list.addEventListener('wheel', (event) => {
    if (!scrollLoadSuppressed && event.deltaY < 0 && list.scrollTop <= 1) {
      scheduleWindowSlide(-1)
    }
  }, { passive: true })
  query.addEventListener('input', applyFilters)
  filters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-kind]')
    if (!button) return
    activeKind = button.dataset.kind
    filters.querySelectorAll('[data-kind]').forEach((item) => item.classList.toggle('active', item === button))
    applyFilters()
  })
  timeline.addEventListener('click', (event) => {
    const button = event.target.closest('[data-month]')
    if (button) jumpToMonth(button.dataset.month)
  })

  const updateZoom = () => preview.style.setProperty('--zoom', zoom)
  const closeLightbox = () => {
    box.classList.remove('open')
    zoom = 1
    updateZoom()
  }
  list.addEventListener('click', (event) => {
    const image = event.target.closest('img[data-preview]')
    if (!image) return
    preview.src = image.src
    zoom = 1
    updateZoom()
    box.classList.add('open')
  })
  preview.addEventListener('wheel', (event) => {
    event.preventDefault()
    zoom = Math.min(5, Math.max(.5, zoom + (event.deltaY < 0 ? .2 : -.2)))
    updateZoom()
  }, { passive: false })
  preview.addEventListener('dblclick', () => {
    zoom = 1
    updateZoom()
  })
  box.addEventListener('click', (event) => {
    if (event.target === box) closeLightbox()
  })
  closeButton.addEventListener('click', closeLightbox)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeLightbox()
  })

  title.textContent = archive.name || ${JSON.stringify(name)}
  meta.textContent = allMessages.length.toLocaleString() + ' 条消息 · 更新于 ' +
    (archive.exportedAt
      ? new Date(archive.exportedAt).toLocaleString('zh-CN', { hour12: false })
      : '未知时间')
  applyFilters()
})()
`

export function renderExportPage(name: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safe(name)} - 聊天记录</title>
  <style>${exportStyles}</style>
</head>
<body>
  <main class="page">
    <header class="toolbar">
      <div>
        <span class="title" id="archive-title">${safe(name)}</span>
        <span class="meta" id="archive-meta">正在读取消息…</span>
      </div>
      <div class="controls">
        <input id="query" type="search" placeholder="搜索发送者或消息内容…" aria-label="搜索消息">
      </div>
      <div class="filters" id="filters">
        <button class="filter-button active" type="button" data-kind="all">全部</button>
        <button class="filter-button" type="button" data-kind="text">文字</button>
        <button class="filter-button" type="button" data-kind="media">图片 / 视频</button>
        <button class="filter-button" type="button" data-kind="voice">语音</button>
        <button class="filter-button" type="button" data-kind="file">文件</button>
        <button class="filter-button" type="button" data-kind="share">分享</button>
        <button class="filter-button" type="button" data-kind="system">系统 / 其他</button>
        <span class="count" id="count"></span>
      </div>
    </header>
    <section class="archive-layout">
      <nav class="timeline" id="timeline" aria-label="聊天时间轴"></nav>
      <section class="scroll" id="messages">
        <div class="empty">正在加载聊天档案…</div>
      </section>
    </section>
  </main>
  <div class="lightbox" id="lightbox">
    <button class="lightbox-close" id="lightbox-close" type="button" aria-label="关闭图片预览">×</button>
    <img id="lightbox-image" alt="预览">
  </div>
  <script src="data/messages.js"></script>
  <script>${renderExportScript(name)}</script>
</body>
</html>`
}
