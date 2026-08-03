const safe = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ||
      character
  )

export const exportStyles = `
:root {
  color-scheme: light;
  --page: #edf2f0;
  --panel: #ffffff;
  --text: #1d2a25;
  --muted: #68766f;
  --border: #d8e2dc;
  --mine: #d9f0e2;
  --accent: #176b57;
  --accent-soft: #e2f1eb;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  overflow: hidden;
  background: var(--page);
  color: var(--text);
  font: 14px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
button, input { font: inherit; }
.page {
  width: min(100%, 1440px);
  height: 100vh;
  margin: auto;
  padding: 22px 28px;
  display: flex;
  flex-direction: column;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex: 0 0 auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  box-shadow: 0 8px 24px #29483b12;
}
.heading { min-width: 0; }
.title { font-size: 18px; font-weight: 750; }
.meta { color: var(--muted); margin-left: 12px; font-size: 13px; }
.controls { display: flex; gap: 10px; align-items: center; min-width: 0; }
.segment {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: #f4f7f5;
  flex: 0 0 auto;
}
.segment button {
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
}
.segment button.active { color: #fff; background: var(--accent); }
.controls input[type=search] {
  width: 250px;
  min-width: 150px;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: #fff;
  color: var(--text);
  outline: none;
}
.controls input[type=search]:focus { border-color: var(--accent); }
.workspace {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: 146px minmax(0, 1fr);
  gap: 18px;
  margin-top: 18px;
}
.timeline {
  overflow: auto;
  padding: 14px 8px 30px 15px;
  border-right: 1px solid #cbd7d1;
}
.timeline-list { position: relative; display: grid; gap: 2px; }
.timeline-list::before {
  content: "";
  position: absolute;
  top: 17px;
  bottom: 17px;
  left: 8px;
  width: 2px;
  background: #a8b4ae;
}
.timeline-item {
  position: relative;
  width: 100%;
  min-height: 36px;
  padding: 5px 8px 5px 28px;
  border: 0;
  color: var(--muted);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.timeline-item::before {
  content: "";
  position: absolute;
  z-index: 1;
  left: 2px;
  top: 14px;
  width: 12px;
  height: 12px;
  border: 3px solid #7c8882;
  border-radius: 50%;
  background: var(--page);
}
.timeline-item.all { min-height: 32px; font-size: 13px; font-weight: 650; }
.timeline-item.year { min-height: 32px; font-size: 15px; font-weight: 700; }
.timeline-item.month { min-height: 30px; padding-left: 38px; font-size: 13px; }
.timeline-item.month::before { left: 5px; top: 13px; width: 6px; height: 6px; border-width: 2px; }
.timeline-item.active { color: var(--accent); font-weight: 750; }
.timeline-item.active::before { border-color: var(--accent); background: #f0c928; }
.conversation { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.period-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 32px;
  padding: 0 8px 8px;
  color: var(--muted);
  font-size: 13px;
}
.period { color: var(--text); font-weight: 700; }
.scroll {
  overflow: auto;
  flex: 1;
  padding: 8px 8px 30px;
  scroll-behavior: smooth;
}
.message { display: flex; flex-direction: column; gap: 6px; width: min(100%, 820px); margin: 0 auto 22px; }
.message.sent { align-items: flex-end; }
.message.system { align-items: center; }
.message.system .row { justify-content: center; }
.message.system .bubble {
  max-width: 92%;
  padding: 6px 10px;
  border: 0;
  border-radius: 5px;
  background: #dde5e1;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
  box-shadow: none;
}
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
  max-width: min(78vw, 760px);
  padding: 13px 15px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 4px 12px #29483b0d;
}
.sent .bubble { background: var(--mine); border-color: #c7e6d4; }
.sender { color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.content { line-height: 1.7; word-break: break-word; white-space: pre-wrap; }
.audio-wrap, .audio { width: 260px; max-width: 100%; }
.audio { display: block; height: 38px; }
.media-image {
  display: block;
  max-width: 100%;
  max-height: 420px;
  border-radius: 7px;
  object-fit: contain;
  background: #eef2f5;
}
img.media-image { cursor: zoom-in; }
.structured-card, .file-card {
  display: grid;
  gap: 4px;
  min-width: min(260px, 65vw);
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: #f7faf8;
  color: var(--text);
  text-decoration: none;
}
.structured-card strong, .file-card strong { font-size: 14px; word-break: break-word; }
.structured-card span, .structured-card small, .file-card span { color: var(--muted); line-height: 1.5; }
.structured-card small { word-break: break-all; }
.file-action { color: var(--accent); font-weight: 650; }
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
.media-error {
  margin-top: 6px;
  padding: 8px 10px;
  border: 1px solid #e6c98f;
  border-radius: 6px;
  background: #fff8e8;
  color: #7a5314;
  font-size: 12px;
}
.empty { padding: 80px 20px; color: var(--muted); text-align: center; }
.load-more {
  display: block;
  min-width: 140px;
  height: 38px;
  margin: 4px auto 22px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: #fff;
  color: var(--accent);
  cursor: pointer;
}
.lightbox { position: fixed; inset: 0; display: none; place-items: center; background: #14231ddd; z-index: 10; padding: 24px; overflow: auto; }
.lightbox.open { display: grid; }
.lightbox img { width: auto; height: auto; max-width: 92vw; max-height: 88vh; object-fit: contain; cursor: zoom-in; transform: scale(var(--zoom, 1)); transform-origin: center; transition: transform .12s ease; }
@media (max-width: 800px) {
  .page { padding: 10px; }
  .toolbar { align-items: stretch; flex-direction: column; gap: 12px; padding: 14px; }
  .controls { width: 100%; }
  .controls input[type=search] { width: 100%; flex: 1; }
  .workspace { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); gap: 8px; margin-top: 10px; }
  .timeline { overflow-x: auto; overflow-y: hidden; padding: 4px 0 8px; border-right: 0; border-bottom: 1px solid #cbd7d1; }
  .timeline-list { display: flex; gap: 4px; min-width: max-content; }
  .timeline-list::before, .timeline-item::before { display: none; }
  .timeline-item { width: auto; min-height: 34px; padding: 6px 10px; border-radius: 5px; }
  .timeline-item.year, .timeline-item.month, .timeline-item.all { padding-left: 10px; }
  .timeline-item.year { font-size: 14px; }
  .timeline-item.month, .timeline-item.all { font-size: 12px; }
  .timeline-item.active { background: var(--accent-soft); }
  .bubble { max-width: calc(100vw - 90px); }
}
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
      <div class="heading"><span class="title" id="title">${safe(name)}</span><span class="meta" id="meta"></span></div>
      <div class="controls">
        <div class="segment" role="group" aria-label="消息类型筛选">
          <button type="button" class="active" data-mode="all">全部</button>
          <button type="button" data-mode="media">图片与视频</button>
        </div>
        <input id="query" type="search" placeholder="搜索消息..." aria-label="搜索消息">
      </div>
    </header>
    <div class="workspace">
      <nav class="timeline" aria-label="消息时间轴"><div class="timeline-list" id="timeline"></div></nav>
      <section class="conversation">
        <div class="period-bar"><span class="period" id="period"></span><span id="count"></span></div>
        <div class="scroll" id="messages"></div>
      </section>
    </div>
  </main>
  <div class="lightbox" id="lightbox"><img id="lightbox-image" alt="预览"></div>
  <script src="data/messages.js"></script>
  <script>
  (() => {
    'use strict';
    const archive = window.__WECHAT_EXPORT__;
    const timeline = document.querySelector('#timeline');
    const container = document.querySelector('#messages');
    const query = document.querySelector('#query');
    const count = document.querySelector('#count');
    const period = document.querySelector('#period');
    const meta = document.querySelector('#meta');
    const title = document.querySelector('#title');
    const lightbox = document.querySelector('#lightbox');
    const preview = document.querySelector('#lightbox-image');
    const PAGE_SIZE = 240;
    let selectedYear = 0;
    let selectedMonth = 0;
    let loadedThroughPeriod = 0;
    let mode = 'all';
    let visibleLimit = PAGE_SIZE;
    let zoom = 1;
    let periodKeys = [];
    let scrollLoadPending = false;

    const make = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    };
    const messageTime = (message) => {
      const seconds = Number(message.createTime || 0);
      if (seconds > 0) return new Date(seconds * 1000);
      const fallback = new Date(message.datetime || '');
      return Number.isNaN(fallback.getTime()) ? null : fallback;
    };
    const messagePeriod = (message) => {
      const date = messageTime(message);
      return date ? { year: date.getFullYear(), month: date.getMonth() + 1 } : null;
    };
    const periodKey = (value) => value ? value.year * 100 + value.month : 0;
    const periodLabel = (key) => Math.floor(key / 100) + '年 ' + (key % 100) + '月';
    const isMedia = (message) => {
      const type = message.exportMediaType || (message.contentData && message.contentData.type);
      return type === 'image' || type === 'video';
    };
    const searchText = (message) => {
      const data = message.contentData || {};
      return [message.name, message.content, message.type, data.title, data.des, message.exportFileName]
        .filter(Boolean).join(' ').toLocaleLowerCase();
    };
    const formatBytes = (size) => {
      const value = Number(size || 0);
      if (!value) return '';
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
      if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
      return (value / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    };
    const httpUrl = (value) => {
      const url = String(value || '').trim();
      return url.startsWith('https://') || url.startsWith('http://') ? url : '';
    };

    function appendStructured(bubble, message) {
      const data = message.contentData;
      if (!data) return false;
      if (data.type === 'share') {
        const href = httpUrl(data.url);
        const card = make(href ? 'a' : 'div', 'structured-card');
        if (href) { card.href = href; card.target = '_blank'; card.rel = 'noreferrer'; }
        card.append(make('strong', '', data.title || '分享消息'));
        if (data.des) card.append(make('span', '', data.des));
        if (data.appname) card.append(make('small', '', data.appname));
        if (href) card.append(make('small', '', href));
        bubble.append(card);
        return true;
      }
      if (data.type === 'location') {
        const card = make('div', 'structured-card');
        card.append(make('strong', '', data.poiname || '位置'));
        if (data.label) card.append(make('span', '', data.label));
        if (Number.isFinite(data.lat) && Number.isFinite(data.lng)) {
          card.append(make('small', '', Number(data.lat).toFixed(6) + ', ' + Number(data.lng).toFixed(6)));
        }
        bubble.append(card);
        return true;
      }
      if (data.type === 'miniProgram' || data.type === 'redPacket' || data.type === 'card' || data.type === 'voip') {
        const card = make('div', 'structured-card');
        const primary = data.title || data.nickname || (data.type === 'voip' ? '通话记录' : '消息');
        const secondary = data.description || data.username || data.status || data.appName;
        card.append(make('strong', '', primary));
        if (secondary) card.append(make('span', '', secondary));
        bubble.append(card);
        return true;
      }
      return false;
    }

    function renderMessage(message) {
      const data = message.contentData || {};
      const system = data.type === 'system';
      const article = make('article', 'message' + (message.isSender ? ' sent' : '') + (system ? ' system' : ''));
      article.append(make('div', 'time', message.datetime || ''));
      const row = make('div', 'row');
      const bubble = make('div', 'bubble');
      if (!system && message.exportShowAvatar !== false) {
        const avatar = make('div', 'avatar');
        if (message.exportAvatarUrl) {
          const image = make('img'); image.src = message.exportAvatarUrl; image.alt = '';
          avatar.append(image);
        } else {
          avatar.textContent = String(message.name || (message.isSender ? '我' : '友')).slice(0, 1);
        }
        row.append(avatar);
      }
      if (!system) bubble.append(make('div', 'sender', message.name || (message.isSender ? '我' : '联系人')));

      let rendered = false;
      if (message.exportMediaUrl && (message.exportMediaType === 'image' || message.exportMediaType === 'sticker')) {
        const image = make('img', 'media-image');
        image.src = message.exportMediaUrl; image.alt = message.exportMediaType === 'sticker' ? '表情包' : '图片';
        bubble.append(image); rendered = true;
      } else if (message.exportMediaUrl && message.exportMediaType === 'video') {
        const video = make('video', 'media-image'); video.src = message.exportMediaUrl; video.controls = true; video.preload = 'metadata';
        bubble.append(video); rendered = true;
      }
      if (message.voiceDataUrl) {
        const wrap = make('div', 'audio-wrap');
        const audio = make('audio', 'audio'); audio.src = message.voiceDataUrl; audio.controls = true; audio.preload = 'metadata';
        wrap.append(audio); bubble.append(wrap); rendered = true;
      }
      if (message.exportFileUrl) {
        const file = make('a', 'file-card'); file.href = message.exportFileUrl; file.download = message.exportFileName || '';
        file.append(make('strong', '', message.exportFileName || (data && data.title) || '附件'));
        const size = formatBytes(message.exportFileSize);
        if (size) file.append(make('span', '', size));
        file.append(make('span', 'file-action', '下载文件'));
        bubble.append(file); rendered = true;
      } else if (data.type === 'quote') {
        const quote = make('div', 'quote-reference');
        quote.append(make('strong', '', data.quotedSender || '引用消息'));
        quote.append(make('span', '', data.quotedContent || '[引用消息]'));
        bubble.append(quote); rendered = true;
      } else if (!system && appendStructured(bubble, message)) {
        rendered = true;
      }
      if (message.exportMediaError) bubble.append(make('div', 'media-error', message.exportMediaError));

      const content = String(message.content || (system ? data.content || '' : '')).trim();
      const placeholder = new RegExp('^\\\\[(?:图片|视频|语音消息|表情包)\\\\]$').test(content);
      if (content && (!rendered || !placeholder) && !message.exportMediaError) {
        bubble.append(make('div', 'content', content));
        rendered = true;
      }
      if (!rendered && !message.exportMediaError) bubble.append(make('div', 'content', '[' + (message.type || '消息') + ']'));
      row.append(bubble); article.append(row);
      return article;
    }

    function availablePeriods(messages) {
      const result = new Map();
      messages.forEach((message) => {
        const value = messagePeriod(message);
        if (!value) return;
        if (!result.has(value.year)) result.set(value.year, new Set());
        result.get(value.year).add(value.month);
      });
      return result;
    }

    function renderTimeline(periods) {
      timeline.replaceChildren();
      const allButton = make('button', 'timeline-item all' + (!selectedYear ? ' active' : ''), '全部时间');
      allButton.type = 'button';
      allButton.addEventListener('click', () => {
        selectedYear = 0; selectedMonth = 0; loadedThroughPeriod = 0;
        visibleLimit = PAGE_SIZE; container.scrollTop = 0;
        renderTimeline(periods); renderMessages();
      });
      timeline.append(allButton);
      const years = Array.from(periods.keys()).sort((a, b) => a - b);
      years.forEach((year) => {
        const yearButton = make('button', 'timeline-item year' + (year === selectedYear ? ' active' : ''), year);
        yearButton.type = 'button';
        yearButton.addEventListener('click', () => {
          selectedYear = year;
          selectedMonth = Math.max(...Array.from(periods.get(year)));
          loadedThroughPeriod = selectedYear * 100 + selectedMonth;
          visibleLimit = PAGE_SIZE;
          container.scrollTop = 0;
          renderTimeline(periods); renderMessages();
        });
        timeline.append(yearButton);
        if (year === selectedYear) {
          Array.from(periods.get(year)).sort((a, b) => a - b).forEach((month) => {
            const monthButton = make('button', 'timeline-item month' + (month === selectedMonth ? ' active' : ''), month + '月');
            monthButton.type = 'button';
            monthButton.addEventListener('click', () => {
              selectedYear = year; selectedMonth = month;
              loadedThroughPeriod = year * 100 + month;
              visibleLimit = PAGE_SIZE; container.scrollTop = 0;
              renderTimeline(periods); renderMessages();
            });
            timeline.append(monthButton);
          });
        }
      });
    }

    function filteredMessages() {
      const term = query.value.trim().toLocaleLowerCase();
      const selectedKey = selectedYear * 100 + selectedMonth;
      return archive.messages.filter((message) => {
        const value = messagePeriod(message);
        const key = periodKey(value);
        const inSelectedPeriod = !selectedYear ||
          (key >= selectedKey && key <= loadedThroughPeriod);
        return inSelectedPeriod &&
          (mode === 'all' || isMedia(message)) && (!term || searchText(message).includes(term));
      });
    }

    function hasNextPeriod() {
      if (!selectedYear) return false;
      const index = periodKeys.indexOf(loadedThroughPeriod);
      return index >= 0 && index < periodKeys.length - 1;
    }

    function loadNextBatch() {
      const messages = filteredMessages();
      if (visibleLimit < messages.length) {
        visibleLimit += PAGE_SIZE;
        renderMessages();
        return true;
      }
      if (!hasNextPeriod()) return false;
      const currentIndex = periodKeys.indexOf(loadedThroughPeriod);
      loadedThroughPeriod = periodKeys[currentIndex + 1];
      visibleLimit += PAGE_SIZE;
      renderMessages();
      return true;
    }

    function renderMessages() {
      const messages = filteredMessages();
      const shown = messages.slice(0, visibleLimit);
      container.replaceChildren(...shown.map(renderMessage));
      const selectedKey = selectedYear * 100 + selectedMonth;
      period.textContent = !selectedYear
        ? '全部时间'
        : loadedThroughPeriod === selectedKey
          ? periodLabel(selectedKey)
          : periodLabel(selectedKey) + ' - ' + periodLabel(loadedThroughPeriod);
      count.textContent = '已显示 ' + shown.length.toLocaleString() + ' / ' + messages.length.toLocaleString() + ' 条';
      if (!messages.length) container.append(make('div', 'empty', '没有符合条件的消息'));
      if (shown.length < messages.length || hasNextPeriod()) {
        const more = make('button', 'load-more', '加载更多'); more.type = 'button';
        more.addEventListener('click', loadNextBatch);
        container.append(more);
      }
    }

    if (!archive || !Array.isArray(archive.messages)) {
      container.append(make('div', 'empty', '消息数据文件未找到，请确认 data/messages.js 与 index.html 位于同一导出目录。'));
      return;
    }

    title.textContent = archive.name || title.textContent;
    meta.textContent = archive.messages.length.toLocaleString() + ' 条消息';
    const periods = availablePeriods(archive.messages);
    const years = Array.from(periods.keys()).sort((a, b) => a - b);
    periodKeys = years.flatMap((year) =>
      Array.from(periods.get(year)).sort((a, b) => a - b).map((month) => year * 100 + month)
    );
    if (years.length) {
      selectedYear = years[years.length - 1];
      selectedMonth = Math.max(...Array.from(periods.get(selectedYear)));
      loadedThroughPeriod = selectedYear * 100 + selectedMonth;
      renderTimeline(periods);
      renderMessages();
    } else {
      container.append(make('div', 'empty', '没有可显示的消息'));
    }

    query.addEventListener('input', () => {
      loadedThroughPeriod = selectedYear * 100 + selectedMonth;
      visibleLimit = PAGE_SIZE; container.scrollTop = 0; renderMessages();
    });
    document.querySelectorAll('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        mode = button.dataset.mode;
        document.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
        loadedThroughPeriod = selectedYear * 100 + selectedMonth;
        visibleLimit = PAGE_SIZE; container.scrollTop = 0; renderMessages();
      });
    });
    container.addEventListener('scroll', () => {
      if (scrollLoadPending || container.scrollHeight - container.scrollTop - container.clientHeight > 160) return;
      scrollLoadPending = true;
      requestAnimationFrame(() => {
        loadNextBatch();
        scrollLoadPending = false;
      });
    });
    container.addEventListener('click', (event) => {
      const image = event.target.closest('img.media-image');
      if (!image) return;
      preview.src = image.src; zoom = 1; preview.style.setProperty('--zoom', zoom); lightbox.classList.add('open');
    });
    preview.addEventListener('wheel', (event) => {
      event.preventDefault(); zoom = Math.min(5, Math.max(.5, zoom + (event.deltaY < 0 ? .2 : -.2)));
      preview.style.setProperty('--zoom', zoom);
    }, { passive: false });
    preview.addEventListener('dblclick', () => { zoom = 1; preview.style.setProperty('--zoom', zoom); });
    lightbox.addEventListener('click', (event) => { if (event.target === lightbox) lightbox.classList.remove('open'); });
  })();
  </script>
</body>
</html>`
}
