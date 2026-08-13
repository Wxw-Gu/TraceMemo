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
.archive-loading {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 10px;
  padding: 24px;
  background: var(--page);
  color: var(--text);
  text-align: center;
  transition: opacity .2s ease, visibility .2s ease;
}
.archive-loading.complete {
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
}
.archive-loading-indicator {
  width: 34px;
  height: 34px;
  margin-bottom: 4px;
  border: 3px solid #c9d9d1;
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: archive-loading-spin .8s linear infinite;
}
.archive-loading strong { font-size: 16px; }
.archive-loading span { color: var(--muted); font-size: 13px; }
.archive-loading.error .archive-loading-indicator {
  display: grid;
  border: 0;
  animation: none;
  place-items: center;
  color: #a33b32;
  font-size: 28px;
}
.archive-loading.error .archive-loading-indicator::before { content: '!'; }
@keyframes archive-loading-spin { to { transform: rotate(360deg); } }
.page {
  width: 100%;
  max-width: 1380px;
  min-width: 0;
  height: 100vh;
  margin: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
}
.toolbar {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 14px 24px;
  align-items: center;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 16px 20px;
  box-shadow: 0 8px 24px #29483b12;
}
.archive-heading {
  display: flex;
  align-items: center;
  gap: 8px 12px;
  min-width: 0;
  flex-wrap: wrap;
}
.title { font-size: 18px; font-weight: 750; }
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
  width: 100%;
  max-width: 100%;
  min-width: 0;
  grid-template-columns: 168px minmax(0, 1fr);
  gap: 18px;
  min-height: 0;
  flex: 1;
  margin-top: 16px;
}
.archive-layout.single-conversation { grid-template-columns: 168px minmax(0, 1fr); }
.archive-navigation {
  display: flex;
  width: 100%;
  max-width: 100%;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}
.conversation-filter {
  position: relative;
  display: inline-flex;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  height: 42px;
  border-radius: 10px;
  transition: background .15s ease;
}
.conversation-filter[hidden] { display: none; }
.conversation-trigger {
  display: flex;
  width: auto;
  max-width: 280px;
  min-width: 0;
  align-items: center;
  gap: 9px;
  border: 0;
  border-radius: 10px;
  padding: 5px 9px 5px 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background .15s ease;
}
.conversation-trigger:hover, .conversation-trigger[aria-expanded=true] { background: #edf5f1; }
.conversation-trigger:focus-visible { outline: 2px solid #5b9785; outline-offset: 1px; }
.conversation-trigger-avatar {
  position: relative;
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  overflow: hidden;
  border-radius: 8px;
  place-items: center;
  background: #dcebe4;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
}
.conversation-trigger-avatar img { width: 100%; height: 100%; object-fit: cover; }
.conversation-trigger-avatar.multiple { overflow: visible; background: transparent; }
.conversation-trigger-avatar.multiple img {
  position: absolute;
  width: 21px;
  height: 21px;
  border: 2px solid #f7fbf9;
  border-radius: 6px;
}
.conversation-trigger-avatar.multiple img:first-child { top: 0; left: 0; }
.conversation-trigger-avatar.multiple img:last-child { right: 0; bottom: 0; }
.conversation-trigger-name {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 220px;
  overflow: hidden;
  color: var(--text);
  font-size: 15px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conversation-switch-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  color: #5c6963;
  stroke-width: 2;
}
.conversation-menu {
  position: absolute;
  z-index: 12;
  top: calc(100% + 7px);
  left: 0;
  width: max(100%, 240px);
  max-width: calc(100vw - 32px);
  max-height: min(360px, 55vh);
  overflow-y: auto;
  border: 0;
  border-radius: 10px;
  padding: 6px;
  background: #fff;
  box-shadow: 0 10px 30px #19392d2b, 0 2px 8px #19392d14;
}
.conversation-menu[hidden] { display: none; }
.conversation-option {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 7px;
  padding: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.conversation-option:hover, .conversation-option:focus-visible { background: #f0f6f3; outline: 0; }
.conversation-option[aria-selected=true] { background: var(--accent-soft); color: var(--accent); }
.conversation-option-avatar {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  overflow: hidden;
  border-radius: 8px;
  place-items: center;
  background: #dcebe4;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
}
.conversation-option-avatar img { width: 100%; height: 100%; object-fit: cover; }
.conversation-option-avatar.multiple { position: relative; overflow: visible; background: transparent; }
.conversation-option-avatar.multiple img {
  position: absolute;
  width: 21px;
  height: 21px;
  border: 2px solid #fff;
  border-radius: 6px;
}
.conversation-option-avatar.multiple img:first-child { top: 0; left: 0; }
.conversation-option-avatar.multiple img:last-child { right: 0; bottom: 0; }
.conversation-option-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conversation-option-check { width: 16px; flex: 0 0 16px; color: var(--accent); text-align: center; }
.timeline {
  flex: 1;
  overflow: auto;
  background: #f7faf8;
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 12px 9px;
}
.timeline-empty { padding: 10px; color: var(--muted); font-size: 12px; }
.timeline-year-group + .timeline-year-group { margin-top: 4px; }
.timeline-year {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0;
  padding: 7px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  text-align: left;
}
.timeline-year::after {
  content: '⌄';
  color: var(--muted);
  font-size: 16px;
  font-weight: 400;
  line-height: 1;
  transform: rotate(-90deg);
  transition: transform .15s ease;
}
.timeline-year:hover { background: #eaf2ee; }
.timeline-year[aria-expanded=true]::after { transform: rotate(0); }
.timeline-months[hidden] { display: none; }
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
.scroll { width: 100%; max-width: 100%; overflow: auto; min-width: 0; padding: 10px 8px 36px; }
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
  min-width: 0;
  margin: 0 auto 22px;
}
.locate-all {
  position: relative;
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border: 1px solid #b8d4c7;
  border-radius: 50%;
  padding: 0;
  place-items: center;
  background: #fff;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  box-shadow: 0 3px 10px #29483b1a;
  transition: opacity .15s ease, background .15s ease;
}
.locate-icon { font-size: 16px; line-height: 1; }
.locate-label {
  position: absolute;
  z-index: 3;
  top: 50%;
  left: calc(100% + 7px);
  border: 1px solid #b8d4c7;
  border-radius: 7px;
  padding: 5px 8px;
  background: #fff;
  color: var(--accent);
  font-size: 11px;
  font-weight: 650;
  line-height: 1.4;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transform: translate(-2px, -50%);
  box-shadow: 0 3px 10px #29483b1a;
  transition: opacity .15s ease, transform .15s ease;
}
.message.sent .locate-label { right: calc(100% + 7px); left: auto; transform: translate(2px, -50%); }
.message:hover .locate-all, .locate-all:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
.locate-all:hover, .locate-all:focus-visible { background: var(--accent-soft); outline: none; }
.locate-all:hover .locate-label, .locate-all:focus-visible .locate-label {
  opacity: 1;
  transform: translate(0, -50%);
}
@media (hover: none) {
  .locate-all { opacity: 1; pointer-events: auto; }
  .locate-label { display: none; }
}
.message.located .bubble { animation: locate-message 1.5s ease-out; }
@keyframes locate-message {
  0%, 32% { outline: 3px solid #36a477; outline-offset: 3px; }
  100% { outline: 3px solid transparent; outline-offset: 3px; }
}
@media (prefers-reduced-motion: reduce) {
  .message.located .bubble { animation: none; outline: 3px solid #36a477; outline-offset: 3px; }
  .archive-loading-indicator { animation: none; }
}
.message.sent { align-items: flex-end; }
.message.system { align-items: center; }
.message.system .row {
  position: relative;
  width: fit-content;
  max-width: 92%;
  justify-content: center;
}
.message.system .locate-all {
  position: absolute;
  top: 50%;
  left: calc(100% + 10px);
  transform: translateY(-50%);
}
.message.system .avatar { display: none; }
.message.system .message-stack {
  width: max-content;
  max-width: 100%;
}
.message.system .bubble {
  width: max-content;
  max-width: 100%;
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
.conversation-source {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--accent-soft);
  color: var(--accent);
}
.row { display: flex; width: 100%; min-width: 0; gap: 12px; align-items: flex-end; max-width: 100%; }
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
.message-stack {
  min-width: 0;
  max-width: min(78%, 760px);
  display: grid;
  gap: 6px;
}
.bubble {
  min-width: 0;
  max-width: 100%;
  padding: 13px 15px;
  border: 1px solid var(--border);
  border-radius: 10px 18px 18px 18px;
  background: #fff;
  box-shadow: 0 4px 12px #29483b0d;
}
.sent .bubble { background: var(--mine); border-color: #c7e6d4; border-radius: 18px 10px 18px 18px; }
.sender { color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.content { line-height: 1.7; word-break: break-word; white-space: pre-wrap; }
.audio-wrap { width: 380px; max-width: 100%; min-width: 0; }
.search-highlight {
  border-radius: 3px;
  padding: 0 1px;
  background: #ffe58f;
  color: inherit;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.audio { display: block; width: 100%; max-width: 100%; height: 38px; }
.voice-transcript {
  width: 100%;
  max-width: 100%;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #cad8d1;
  color: #3c4742;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.voice-transcript.error { color: #8a5a16; border-top-color: #e4c88f; }
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
.structured-content {
  display: grid;
  gap: 7px;
  width: min(420px, 100%);
  min-width: min(240px, 100%);
}
.structured-kicker {
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
}
.structured-title {
  color: var(--text);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.structured-description {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.structured-footer {
  display: flex;
  gap: 6px;
  align-items: center;
  padding-top: 6px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
}
.structured-link { color: inherit; text-decoration: none; }
.structured-link:hover .structured-title { color: var(--accent); }
.structured-share-articles { display: flex; flex-direction: column; }
.structured-share-article {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 10px 0;
  border-top: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
}
.structured-share-article:first-child { border-top: 0; }
.structured-share-article img { width: 54px; height: 54px; border-radius: 4px; object-fit: cover; }
.location-content {
  gap: 8px;
  padding-top: 8px;
  border-top: 3px solid #3f8f76;
}
.location-content .structured-footer { justify-content: space-between; }
.location-coordinates {
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.location-action { color: var(--accent); font-weight: 650; }
.mini-program-content { border-top: 3px solid #4d9d75; padding-top: 8px; }
.mini-program-preview {
  display: block;
  width: 100%;
  max-height: 260px;
  border-radius: 8px;
  object-fit: cover;
  cursor: zoom-in;
}
.mini-program-icon {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  border-radius: 4px;
  object-fit: cover;
}
.forward-content details { margin-top: 2px; }
.forward-content summary {
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
}
.forward-list, .forward-list ol {
  display: grid;
  gap: 7px;
  margin: 8px 0 0;
  padding-left: 18px;
}
.forward-item { color: var(--muted); font-size: 12px; line-height: 1.5; }
.forward-item strong { color: var(--text); font-weight: 650; }
.forward-item time { margin-left: 6px; font-size: 10px; }
.forward-item span { display: block; white-space: pre-wrap; word-break: break-word; }
.payment-content {
  gap: 4px;
  padding-left: 12px;
  border-left: 4px solid #d15246;
}
.payment-content.transfer { border-left-color: var(--accent); }
.payment-content .structured-title { font-size: 16px; }
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
  html, body { width: 100%; max-width: 100%; overflow-x: hidden; overscroll-behavior-x: none; }
  .page { padding: 10px; }
  .toolbar {
    grid-template-columns: minmax(112px, .7fr) minmax(0, 1.3fr);
    gap: 8px;
    padding: 10px;
    border-radius: 14px;
  }
  .archive-heading {
    grid-column: 1;
    min-height: 36px;
    gap: 4px;
    align-items: center;
    flex-wrap: nowrap;
  }
  .archive-heading .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .conversation-filter:not([hidden]) {
    display: inline-flex;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    flex: 1 1 auto;
    height: 36px;
  }
  .conversation-trigger { width: 100%; max-width: none; gap: 6px; padding: 4px 6px 4px 4px; }
  .conversation-trigger-avatar { width: 26px; height: 26px; flex-basis: 26px; border-radius: 7px; }
  .conversation-trigger-avatar.multiple img { width: 18px; height: 18px; border-radius: 5px; }
  .conversation-trigger-name { flex: 1; max-width: none; font-size: 12px; }
  .conversation-switch-icon { width: 13px; height: 13px; flex-basis: 13px; }
  .conversation-menu {
    width: min(250px, calc(100vw - 20px));
    max-width: none;
  }
  .controls { grid-column: 2; min-width: 0; justify-content: flex-start; }
  .controls input[type=search] {
    width: 100%;
    min-width: 0;
    height: 36px;
    padding: 0 10px;
    font-size: 16px;
  }
  .filters {
    grid-column: 1 / -1;
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .filter-button {
    min-height: 30px;
    border-radius: 8px;
    padding: 4px 6px;
    font-size: 12px;
    line-height: 1.2;
  }
  .count {
    display: block;
    width: 100%;
    flex: 0 0 100%;
    margin-left: 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }
  .archive-layout { grid-template-columns: 1fr; align-content: start; margin-top: 10px; }
  .archive-layout.single-conversation { grid-template-columns: 1fr; }
  .archive-navigation { align-self: start; gap: 8px; }
  .timeline {
    align-self: stretch;
    display: flex;
    width: 100%;
    max-width: 100%;
    gap: 6px;
    overflow: auto;
    padding: 8px;
  }
  .timeline-year-group {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .timeline-year-group + .timeline-year-group { margin-top: 0; }
  .timeline-year {
    flex: 0 0 auto;
    width: auto;
    gap: 6px;
    padding: 7px 8px;
    white-space: nowrap;
  }
  .timeline-months { display: flex; gap: 6px; }
  .timeline-months[hidden] { display: none; }
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
  .scroll {
    overflow-x: hidden;
    overscroll-behavior-x: none;
    touch-action: pan-y;
  }
  .message:not(.system) .message-stack { max-width: calc(100% - 50px); }
  .message:not(.system) .row.has-locate .message-stack { max-width: calc(100% - 90px); }
  .audio-wrap { width: min(260px, 100%); }
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
  const loadingOverlay = document.querySelector('#archive-loading')
  const loadingTitle = document.querySelector('#archive-loading-title')
  const loadingDetail = document.querySelector('#archive-loading-detail')
  const finishLoading = () => {
    if (!loadingOverlay) return
    loadingOverlay.setAttribute('aria-busy', 'false')
    loadingOverlay.classList.add('complete')
    window.setTimeout(() => loadingOverlay.remove(), 250)
  }
  const failLoading = (message) => {
    if (!loadingOverlay) return
    loadingOverlay.setAttribute('aria-busy', 'false')
    loadingOverlay.setAttribute('role', 'alert')
    loadingOverlay.classList.add('error')
    if (loadingTitle) loadingTitle.textContent = '无法加载聊天档案'
    if (loadingDetail) loadingDetail.textContent = message
  }
  const initializeArchive = () => {
    try {
  const PAGE_SIZE = ${EXPORT_PAGE_SIZE}
  const WINDOW_STEP = Math.floor(PAGE_SIZE / 2)
  const archive = window.__WECHAT_EXPORT__ || { name: ${JSON.stringify(name)}, messages: [] }
  const legacyConversation = archive.sourceId
    ? [{ id: archive.sourceId, name: archive.name || ${JSON.stringify(name)}, type: 'user', messageCount: 0 }]
    : []
  const conversations = Array.isArray(archive.conversations) && archive.conversations.length
    ? archive.conversations
    : legacyConversation
  const allMessages = (Array.isArray(archive.messages) ? archive.messages : []).map((message) =>
    message.exportConversationId || conversations.length !== 1
      ? message
      : Object.assign({}, message, {
          exportConversationId: conversations[0].id,
          exportConversationName: conversations[0].name
        })
  )
  const list = document.querySelector('#messages')
  const layout = document.querySelector('.archive-layout')
  const conversationFilter = document.querySelector('#conversation-filter')
  const conversationTrigger = document.querySelector('#conversation-trigger')
  const conversationTriggerAvatar = document.querySelector('#conversation-trigger-avatar')
  const conversationTriggerName = document.querySelector('#conversation-trigger-name')
  const conversationMenu = document.querySelector('#conversation-menu')
  const timeline = document.querySelector('#timeline')
  const query = document.querySelector('#query')
  const count = document.querySelector('#count')
  const title = document.querySelector('#archive-title')
  const filters = document.querySelector('#filters')
  const box = document.querySelector('#lightbox')
  const preview = document.querySelector('#lightbox-image')
  const closeButton = document.querySelector('#lightbox-close')
  let activeKind = 'all'
  let activeConversation = 'all'
  let filtered = []
  let windowStart = 0
  let windowEnd = 0
  let scrollLoadPending = false
  let scrollLoadSuppressed = false
  let activeMonthUpdatePending = false
  let expandedTimelineYear = ''
  const tabPositions = new Map()
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
  const decodeEntities = (value) => {
    const textarea = document.createElement('textarea')
    textarea.innerHTML = String(value ?? '')
    return textarea.value
  }
  const displayText = (value) => esc(decodeEntities(value))
  const externalUrl = (value) => {
    const decoded = decodeEntities(value).trim()
    if (!decoded) return ''
    try {
      const parsed = new URL(decoded)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? esc(decoded) : ''
    } catch {
      return ''
    }
  }
  const imageUrl = (value) => {
    const decoded = decodeEntities(value).trim()
    if (decoded.toLowerCase().startsWith('data:image/')) return esc(decoded)
    return ''
  }
  const urlHost = (value) => {
    const decoded = decodeEntities(value).trim()
    if (!decoded) return ''
    try {
      const parsed = new URL(decoded)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : ''
    } catch {
      return ''
    }
  }
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
    const shareType = String(data.typeVal || '')
    if (
      message.exportMediaType === 'file' ||
      (data.type === 'share' && (shareType === '6' || shareType === '74'))
    ) return 'file'
    if (
      message.exportMediaType === 'image' || message.exportMediaType === 'video' ||
      message.exportMediaType === 'sticker' || data.type === 'image' ||
      data.type === 'video' || data.type === 'sticker'
    ) return 'media'
    if (message.voiceDataUrl || data.type === 'voice' || message.type === '语音') return 'voice'
    if (
      data.type === 'system' || data.type === 'unknown' || data.type === 'redPacket' ||
      data.type === 'voip' || data.type === 'card' || message.from === 'system' ||
      (data.type === 'share' && shareType === '2000') ||
      message.type === '微信红包' || message.type === '转账'
    ) return 'system'
    if (
      data.type === 'share' || data.type === 'location' ||
      data.type === 'miniProgram' || data.type === 'forwardBundle'
    ) return 'share'
    return 'text'
  }
  const forwardedSearchText = (items) => Array.isArray(items)
    ? items.flatMap((item) => [
        item.sender,
        item.sentAt,
        item.text,
        forwardedSearchText(item.nested)
      ]).flat().filter(Boolean)
    : []
  const searchText = (message) => [
    message.exportConversationName,
    message.name,
    message.content,
    message.type,
    message.contentData && message.contentData.title,
    message.contentData && message.contentData.des,
    message.contentData && message.contentData.description,
    message.contentData && message.contentData.appname,
    message.contentData && message.contentData.appName,
    message.contentData && message.contentData.quotedSender,
    message.contentData && message.contentData.quotedContent,
    message.voiceTranscript,
    message.contentData && message.contentData.nickname,
    message.contentData && message.contentData.username,
    message.contentData && message.contentData.poiname,
    message.contentData && message.contentData.label,
    message.contentData && message.contentData.status,
    message.contentData && forwardedSearchText(message.contentData.items),
    message.exportMediaName
  ].filter(Boolean).join(' ').toLowerCase()
  const exportedImageOrVideoFileStem = (message) => {
    const mediaType = message.exportMediaType || (message.contentData && message.contentData.type)
    if (mediaType !== 'image' && mediaType !== 'video') return ''
    const mediaUrl = String(message.exportMediaUrl || '').split(/[?#]/, 1)[0]
    const fileName = mediaUrl.slice(mediaUrl.lastIndexOf('/') + 1)
    if (!fileName) return ''
    let decodedFileName = fileName
    try {
      decodedFileName = decodeURIComponent(fileName)
    } catch {}
    const extensionIndex = decodedFileName.lastIndexOf('.')
    return (extensionIndex > 0 ? decodedFileName.slice(0, extensionIndex) : decodedFileName).toLowerCase()
  }

  const shareLabel = (typeVal) => {
    if (String(typeVal) === '5') return '公众号链接'
    if (String(typeVal) === '51') return '视频号'
    return '分享'
  }
  const renderShareContent = (data) => {
    const label = shareLabel(data.typeVal)
    const articles = Array.isArray(data.articles) ? data.articles : []
    if (articles.length) {
      const articleMarkup = articles.map((article) => {
        const href = externalUrl(article.url)
        const cover = imageUrl(article.coverUrl)
        const body = '<span><div class="structured-title">' + displayText(article.title || '公众号文章') + '</div>' +
          (article.description ? '<div class="structured-description">' + displayText(article.description) + '</div>' : '') +
          '</span>' + (cover ? '<img src="' + cover + '" alt="">' : '')
        return href
          ? '<a class="structured-share-article" href="' + href + '" target="_blank" rel="noreferrer noopener">' + body + '</a>'
          : '<div class="structured-share-article">' + body + '</div>'
      }).join('')
      return '<div class="structured-content share-content" data-rich-kind="share">' +
        '<div class="structured-kicker">' + displayText(data.appname || label) + '</div>' +
        '<div class="structured-share-articles">' + articleMarkup + '</div></div>'
    }
    let title = decodeEntities(data.title || label)
    let description = decodeEntities(data.des || '')
    if (String(data.typeVal) === '51' && /当前微信版本不支持展示该内容/.test(title) && description) {
      const lines = description.split(/\\n+/).map((line) => line.trim()).filter(Boolean)
      title = lines.shift() || label
      description = lines.join('\\n')
    }
    const href = externalUrl(data.url)
    const host = urlHost(data.url)
    const appName = displayText(data.appname || label)
    const titleMarkup = '<div class="structured-title">' + esc(title) + '</div>'
    return '<div class="structured-content share-content" data-rich-kind="share">' +
      '<div class="structured-kicker">' + displayText(label) + '</div>' +
      (href
        ? '<a class="structured-link" href="' + href + '" target="_blank" rel="noreferrer noopener">' + titleMarkup + '</a>'
        : titleMarkup) +
      (description ? '<div class="structured-description">' + esc(description) + '</div>' : '') +
      '<div class="structured-footer"><span>' + appName + '</span>' +
      (host ? '<span>·</span><span>' + esc(host) + '</span>' : '') + '</div></div>'
  }
  const renderMiniProgramContent = (data) => {
    const previewUrl = imageUrl(data.thumbDataUrl)
    const iconUrl = imageUrl(data.iconUrl)
    return '<div class="structured-content mini-program-content" data-rich-kind="miniProgram">' +
      '<div class="structured-kicker">小程序</div>' +
      '<div class="structured-title">' + displayText(data.title || '小程序') + '</div>' +
      (data.description
        ? '<div class="structured-description">' + displayText(data.description) + '</div>'
        : '') +
      (previewUrl
        ? '<img class="mini-program-preview" data-preview src="' + previewUrl + '" alt="">'
        : '') +
      '<div class="structured-footer">' +
      (iconUrl ? '<img class="mini-program-icon" src="' + iconUrl + '" alt="">' : '') +
      '<span>' + displayText(data.appName || '小程序') + '</span></div></div>'
  }
  const renderForwardItems = (items, depth = 0) => {
    if (!Array.isArray(items) || !items.length || depth > 4) return ''
    return '<ol class="forward-list">' + items.map((item) =>
      '<li class="forward-item">' +
      (item.sender ? '<strong>' + displayText(item.sender) + '</strong>' : '') +
      (item.sentAt ? '<time>' + displayText(item.sentAt) + '</time>' : '') +
      '<span>' + displayText(item.text || '[消息]') + '</span>' +
      renderForwardItems(item.nested, depth + 1) + '</li>'
    ).join('') + '</ol>'
  }
  const renderForwardContent = (data) => {
    const items = Array.isArray(data.items) ? data.items : []
    return '<div class="structured-content forward-content" data-rich-kind="forwardBundle">' +
      '<div class="structured-kicker">聊天记录</div>' +
      '<div class="structured-title">' + displayText(data.title || '聊天记录') + '</div>' +
      (!items.length && data.description
        ? '<div class="structured-description">' + displayText(data.description) + '</div>'
        : '') +
      (items.length
        ? '<details><summary>展开 ' + items.length + ' 条消息</summary>' + renderForwardItems(items) + '</details>'
        : '') + '</div>'
  }
  const renderLocationContent = (data) => {
    const latitude = Number(data.lat)
    const longitude = Number(data.lng)
    const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude) &&
      (latitude !== 0 || longitude !== 0)
    const title = data.poiname || data.label || '位置'
    const address = data.label && data.label !== data.poiname ? data.label : ''
    const coordinates = hasCoordinates
      ? latitude.toFixed(6) + ', ' + longitude.toFixed(6)
      : ''
    const mapUrl = hasCoordinates
      ? externalUrl('https://maps.apple.com/?q=' + encodeURIComponent(title) +
          '&ll=' + latitude + ',' + longitude)
      : ''
    const card = '<div class="structured-content location-content" data-rich-kind="location">' +
      '<div class="structured-kicker">位置</div>' +
      '<div class="structured-title">' + displayText(title) + '</div>' +
      (address ? '<div class="structured-description">' + displayText(address) + '</div>' : '') +
      (coordinates
        ? '<div class="structured-footer"><span class="location-coordinates">' +
          esc(coordinates) + '</span><span class="location-action">在地图中打开</span></div>'
        : '') + '</div>'
    return mapUrl
      ? '<a class="structured-link" href="' + mapUrl +
        '" target="_blank" rel="noreferrer noopener">' + card + '</a>'
      : card
  }
  const renderPaymentContent = (data, kind) => {
    const isTransfer = kind === 'transfer'
    return '<div class="structured-content payment-content ' + (isTransfer ? 'transfer' : 'red-packet') +
      '" data-rich-kind="' + (isTransfer ? 'transfer' : 'redPacket') + '">' +
      '<div class="structured-kicker">' + (isTransfer ? '微信转账' : '微信红包') + '</div>' +
      '<div class="structured-title">' + displayText(data.title || (isTransfer ? '微信转账' : '微信红包')) + '</div>' +
      '<div class="structured-description">' +
      displayText(data.description || data.des || (isTransfer ? '转账消息' : '恭喜发财，大吉大利')) +
      '</div></div>'
  }
  const renderVoipContent = (data) => {
    const title = Number(data.roomType) === 1 ? '视频通话' : '语音通话'
    const duration = Number(data.duration || 0)
    const minutes = Math.floor(duration / 60)
    const seconds = duration % 60
    const durationText = duration
      ? (minutes ? minutes + '分' : '') + seconds + '秒'
      : ''
    return '<div class="structured-content" data-rich-kind="voip">' +
      '<div class="structured-kicker">通话</div>' +
      '<div class="structured-title">' + title + '</div>' +
      '<div class="structured-description">' +
      displayText([data.status, durationText].filter(Boolean).join(' · ') || '通话消息') +
      '</div></div>'
  }
  const renderStructuredContent = (data) => {
    if (data.type === 'share') {
      const typeVal = String(data.typeVal || '')
      if (typeVal === '6' || typeVal === '74') return ''
      if (typeVal === '2000') return renderPaymentContent(data, 'transfer')
      return renderShareContent(data)
    }
    if (data.type === 'miniProgram') return renderMiniProgramContent(data)
    if (data.type === 'forwardBundle') return renderForwardContent(data)
    if (data.type === 'location') return renderLocationContent(data)
    if (data.type === 'redPacket') return renderPaymentContent(data, 'redPacket')
    if (data.type === 'voip') return renderVoipContent(data)
    return ''
  }

  const playableAudioPattern = /\\.(?:mp3|wav|m4a|aac|ogg|oga|opus|flac|webm)(?:$|[?#])/i
  const playableAudioFile = (name, url) =>
    playableAudioPattern.test(String(name || '')) || playableAudioPattern.test(String(url || ''))
  const renderAudioPlayer = (source) =>
    '<div class="audio-wrap"><audio class="audio" controls preload="metadata" src="' + source + '"></audio></div>'

  const renderMessage = (message, archiveIndex) => {
    const data = message.contentData || {}
    const rawMediaUrl = message.exportMediaUrl ? String(message.exportMediaUrl) : ''
    const mediaUrl = rawMediaUrl ? esc(rawMediaUrl) : ''
    const mediaType = message.exportMediaType || data.type
    let media = ''
    if (mediaUrl && mediaType === 'image') {
      media = '<img class="media-image" data-preview src="' + mediaUrl + '" alt="图片">'
    } else if (mediaUrl && mediaType === 'video') {
      media = '<video class="media-image" controls preload="metadata" src="' + mediaUrl + '"></video>'
    } else if (mediaUrl && mediaType === 'sticker') {
      media = '<img class="media-image" data-preview src="' + mediaUrl + '" alt="表情包">'
    } else if (mediaUrl && mediaType === 'file') {
      const rawFileName = message.exportMediaName || data.title || '打开文件'
      const fileName = esc(rawFileName)
      media = '<a class="file-attachment" href="' + mediaUrl + '" target="_blank" rel="noreferrer noopener"><span>📎</span><span>' + fileName + '</span></a>' +
        (playableAudioFile(rawFileName, rawMediaUrl) ? renderAudioPlayer(mediaUrl) : '')
    }
    const audio = message.voiceDataUrl
      ? renderAudioPlayer(esc(message.voiceDataUrl))
      : ''
    const voiceTranscript = message.voiceTranscript
      ? '<div class="voice-transcript">' + esc(message.voiceTranscript) + '</div>'
      : message.voiceTranscriptError
        ? '<div class="voice-transcript error">' + esc(message.voiceTranscriptError) + '</div>'
        : ''
    const mediaStatus = message.exportMediaError
      ? '<div class="media-status">' + esc(message.exportMediaError) + '</div>'
      : ''
    const quote = data.type === 'quote'
      ? '<div class="quote-reference"><strong>' + esc(data.quotedSender || '引用消息') + '</strong><span>' + esc(data.quotedContent || '[引用消息]') + '</span></div>'
      : ''
    const structured = renderStructuredContent(data)
    const isSystem = data.type === 'system'
    const sender = message.name || (message.isSender ? '我' : '联系人')
    const avatarFallback = esc(String(sender || '友').slice(0, 1))
    const avatar = message.exportShowAvatar === false
      ? ''
      : '<div class="avatar">' + (message.exportAvatarUrl
          ? '<img src="' + esc(message.exportAvatarUrl) + '" alt="">'
          : avatarFallback) + '</div>'
    const rawText = message.content || (data.type === 'quote' ? data.title : '')
    const text = kindOf(message) === 'voice' && /^\\[语音(?:消息)?\\]$/.test(String(rawText).trim())
      ? ''
      : rawText
    const content = esc(text || (!media && !audio && !quote && !structured ? '[' + (message.type || '消息') + ']' : ''))
    const contentBlock = content ? '<div class="content">' + content + '</div>' : ''
    const source = conversations.length > 1 && activeConversation === 'all'
      ? '<span class="conversation-source">' + esc(message.exportConversationName || '聊天') + '</span>'
      : ''
    const locateAction = activeKind === 'all' && !query.value.trim()
      ? ''
      : '<button class="locate-all" type="button" data-locate-index="' + archiveIndex +
        '" aria-label="定位到聊天位置"><span class="locate-icon" aria-hidden="true">⌖</span>' +
        '<span class="locate-label" aria-hidden="true">定位到聊天位置</span></button>'
    return '<article class="message' + (message.isSender ? ' sent' : '') + (isSystem ? ' system' : '') +
      '" data-index="' + archiveIndex + '" data-month="' + esc(monthKey(message)) + '">' +
      '<div class="time">' + esc(fullTime(message)) + source + '</div><div class="row' +
      (locateAction ? ' has-locate' : '') + '">' +
      (isSystem ? '' : avatar) + '<div class="message-stack"><div class="bubble"><div class="sender">' +
      (isSystem ? '' : esc(sender)) + '</div>' + media + audio + voiceTranscript + quote +
      structured + contentBlock + mediaStatus + '</div></div>' + locateAction + '</div></article>'
  }

  const renderConversations = () => {
    if (conversations.length <= 1) {
      conversationFilter.hidden = true
      title.hidden = false
      layout.classList.add('single-conversation')
      return
    }
    title.hidden = true
    conversationFilter.hidden = false
    const allAvatarUrls = conversations.map((item) => item.avatarUrl).filter(Boolean).slice(0, 2)
    const avatar = (conversation, urls) => {
      if (urls.length) {
        return '<span class="conversation-option-avatar' + (urls.length > 1 ? ' multiple' : '') + '">' +
          urls.map((url) => '<img src="' + esc(url) + '" alt="">').join('') + '</span>'
      }
      return '<span class="conversation-option-avatar">' +
        esc(conversation ? String(conversation.name || '聊').slice(0, 1) : '全') + '</span>'
    }
    const option = (id, label, avatarMarkup) =>
      '<button class="conversation-option" type="button" role="option" data-conversation-id="' +
      esc(id) + '" aria-selected="' + String(id === activeConversation) + '">' + avatarMarkup +
      '<span class="conversation-option-name">' + esc(label) + '</span>' +
      '<span class="conversation-option-check" aria-hidden="true">' +
      (id === activeConversation ? '&#10003;' : '') + '</span></button>'
    conversationMenu.innerHTML = option('all', '全部聊天', avatar(null, allAvatarUrls)) +
      conversations.map((conversation) => option(
        conversation.id,
        conversation.name,
        avatar(conversation, conversation.avatarUrl ? [conversation.avatarUrl] : [])
      )).join('')
    updateConversationTrigger()
  }

  const updateConversationTrigger = () => {
    const conversation = conversations.find((item) => item.id === activeConversation)
    const avatarUrls = activeConversation === 'all'
      ? conversations.map((item) => item.avatarUrl).filter(Boolean).slice(0, 2)
      : conversation && conversation.avatarUrl ? [conversation.avatarUrl] : []
    const label = conversation ? conversation.name : '全部聊天'
    conversationTriggerName.textContent = label
    conversationTriggerAvatar.classList.toggle('multiple', avatarUrls.length > 1)
    if (avatarUrls.length) {
      conversationTriggerAvatar.innerHTML = avatarUrls.map((url) =>
        '<img src="' + esc(url) + '" alt="">'
      ).join('')
    } else {
      conversationTriggerAvatar.textContent = conversation
        ? String(conversation.name || '聊').slice(0, 1)
        : '全'
    }
    conversationMenu.querySelectorAll('[data-conversation-id]').forEach((option) => {
      const selected = option.dataset.conversationId === activeConversation
      option.setAttribute('aria-selected', String(selected))
      const check = option.querySelector('.conversation-option-check')
      if (check) check.innerHTML = selected ? '&#10003;' : ''
    })
  }

  const setConversationMenuOpen = (open, focusSelected = false) => {
    conversationMenu.hidden = !open
    conversationTrigger.setAttribute('aria-expanded', String(open))
    if (open && focusSelected) {
      nextFrame(() => {
        const selected = conversationMenu.querySelector('[aria-selected=true]')
        if (selected) selected.focus()
      })
    }
  }

  const selectConversation = (id) => {
    if (id !== 'all' && !conversations.some((item) => item.id === id)) return
    if (id !== activeConversation) {
      rememberTabPosition()
      activeConversation = id
      updateConversationTrigger()
      applyFilters(true)
    }
    setConversationMenuOpen(false)
    conversationTrigger.focus()
  }

  const setExpandedTimelineYear = (year) => {
    expandedTimelineYear = year || ''
    timeline.querySelectorAll('.timeline-year').forEach((button) => {
      const expanded = button.dataset.year === expandedTimelineYear
      button.setAttribute('aria-expanded', String(expanded))
      const months = button.nextElementSibling
      if (months) months.hidden = !expanded
    })
  }
  const renderTimeline = () => {
    if (filtered.length === 0) {
      expandedTimelineYear = ''
      timeline.innerHTML = '<div class="timeline-empty">没有可跳转的月份</div>'
      return
    }
    const groups = new Map()
    for (const message of filtered) {
      const key = monthKey(message)
      if (key === 'unknown') continue
      groups.set(key, (groups.get(key) || 0) + 1)
    }
    const yearGroups = new Map()
    for (const [key, total] of groups) {
      const parts = key.split('-')
      if (!yearGroups.has(parts[0])) yearGroups.set(parts[0], [])
      yearGroups.get(parts[0]).push({ key, month: Number(parts[1]), total })
    }
    const years = Array.from(yearGroups.keys())
    if (!years.includes(expandedTimelineYear)) {
      expandedTimelineYear = years[years.length - 1] || ''
    }
    let html = ''
    for (const year of years) {
      const expanded = year === expandedTimelineYear
      const monthsId = 'timeline-months-' + year
      html += '<section class="timeline-year-group" data-year-group="' + esc(year) + '">' +
        '<button class="timeline-year" type="button" data-year="' + esc(year) +
        '" aria-expanded="' + String(expanded) + '" aria-controls="' + esc(monthsId) + '">' +
        esc(year) + ' 年</button>' +
        '<div class="timeline-months" id="' + esc(monthsId) + '"' + (expanded ? '' : ' hidden') + '>' +
        yearGroups.get(year).map((entry) =>
          '<button class="timeline-month" type="button" data-month="' + esc(entry.key) + '">' +
          '<span>' + entry.month + ' 月</span><small>' + entry.total + '</small></button>'
        ).join('') + '</div></section>'
    }
    timeline.innerHTML = html || '<div class="timeline-empty">时间信息不可用</div>'
  }

  const visibleMessages = () => {
    const messages = Array.from(list.querySelectorAll('.message'))
    const listBounds = list.getBoundingClientRect()
    return messages.filter((message) => {
      const bounds = message.getBoundingClientRect()
      return bounds.bottom > listBounds.top && bounds.top < listBounds.bottom
    })
  }
  const updateActiveMonth = () => {
    const messages = Array.from(list.querySelectorAll('.message'))
    const visible = visibleMessages()
    const listBounds = list.getBoundingClientRect()
    const topAnchor = listBounds.top + Math.min(24, listBounds.height / 4)
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 2
    const anchoredMessage = messages.find((message) => {
      const bounds = message.getBoundingClientRect()
      return bounds.bottom > topAnchor && bounds.top < listBounds.bottom
    })
    const activeMessage = atBottom
      ? visible[visible.length - 1] || messages[messages.length - 1]
      : anchoredMessage || visible[0] || messages[0]
    const key = activeMessage && activeMessage.dataset.month
    let activeButton
    timeline.querySelectorAll('.timeline-month').forEach((button) => {
      const active = button.dataset.month === key
      button.classList.toggle('active', active)
      if (active) activeButton = button
    })
    if (!activeButton) return
    const activeYear = key.split('-')[0]
    if (activeYear !== expandedTimelineYear) setExpandedTimelineYear(activeYear)
    const timelineBounds = timeline.getBoundingClientRect()
    const buttonBounds = activeButton.getBoundingClientRect()
    if (buttonBounds.top < timelineBounds.top) {
      timeline.scrollTop -= timelineBounds.top - buttonBounds.top
    } else if (buttonBounds.bottom > timelineBounds.bottom) {
      timeline.scrollTop += buttonBounds.bottom - timelineBounds.bottom
    }
    if (buttonBounds.left < timelineBounds.left) {
      timeline.scrollLeft -= timelineBounds.left - buttonBounds.left
    } else if (buttonBounds.right > timelineBounds.right) {
      timeline.scrollLeft += buttonBounds.right - timelineBounds.right
    }
  }
  const scheduleActiveMonthUpdate = () => {
    if (activeMonthUpdatePending) return
    activeMonthUpdatePending = true
    nextFrame(() => {
      updateActiveMonth()
      activeMonthUpdatePending = false
    })
  }
  const updateCount = () => {
    const scopeTotal = activeConversation === 'all'
      ? allMessages.length
      : allMessages.filter((message) => message.exportConversationId === activeConversation).length
    count.textContent = '筛选 ' + filtered.length + ' / 全部 ' + scopeTotal
  }
  const setScrollTop = (value) => {
    scrollLoadSuppressed = true
    const previousBehavior = list.style.scrollBehavior
    list.style.scrollBehavior = 'auto'
    list.scrollTop = value
    lastScrollTop = list.scrollTop
    updateActiveMonth()
    nextFrame(() => {
      list.style.scrollBehavior = previousBehavior
      lastScrollTop = list.scrollTop
      updateActiveMonth()
      scrollLoadSuppressed = false
    })
  }
  const scrollTopForTarget = (target, offset) => {
    const targetBounds = target.getBoundingClientRect()
    const listBounds = list.getBoundingClientRect()
    return list.scrollTop + targetBounds.top - listBounds.top - offset
  }
  const highlightSearchMatches = () => {
    const term = query.value.trim().toLowerCase()
    if (!term) return
    list.querySelectorAll('.message').forEach((message) => {
      const walker = document.createTreeWalker(message, window.NodeFilter.SHOW_TEXT)
      const matches = []
      while (walker.nextNode()) {
        const node = walker.currentNode
        const parent = node.parentElement
        if (
          node.nodeValue && parent && !parent.closest('.locate-all, .search-highlight') &&
          node.nodeValue.toLowerCase().includes(term)
        ) matches.push(node)
      }
      matches.forEach((node) => {
        const text = node.nodeValue
        const normalized = text.toLowerCase()
        const fragment = document.createDocumentFragment()
        let start = 0
        let index = normalized.indexOf(term, start)
        while (index >= 0) {
          fragment.append(text.slice(start, index))
          const mark = document.createElement('mark')
          mark.className = 'search-highlight'
          mark.textContent = text.slice(index, index + term.length)
          fragment.append(mark)
          start = index + term.length
          index = normalized.indexOf(term, start)
        }
        fragment.append(text.slice(start))
        node.replaceWith(fragment)
      })
    })
  }
  const renderWindow = (anchorIndex, anchorOffset) => {
    const visible = filtered.slice(windowStart, windowEnd)
    const before = windowStart > 0 ? '<div class="lazy-hint">向上滚动加载更早消息</div>' : ''
    const after = windowEnd < filtered.length ? '<div class="lazy-hint">向下滚动加载更多消息</div>' : ''
    list.innerHTML = visible.length
      ? before + visible.map((message, index) => renderMessage(message, windowStart + index)).join('') + after
      : '<div class="empty">没有符合条件的消息<br><small>可以更换筛选条件或关键词</small></div>'
    highlightSearchMatches()
    if (Number.isInteger(anchorIndex)) {
      const anchor = list.querySelector('.message[data-index="' + anchorIndex + '"]')
      if (anchor) setScrollTop(scrollTopForTarget(anchor, anchorOffset))
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
  const tabPositionKey = () => [
    activeConversation,
    activeKind,
    query.value.trim().toLowerCase()
  ].join('\u0000')
  const rememberTabPosition = () => {
    const anchor = visibleMessages()[0]
    const index = anchor ? Number(anchor.dataset.index) : -1
    const message = Number.isInteger(index) ? filtered[index] : undefined
    if (!anchor || !message) return
    tabPositions.set(tabPositionKey(), {
      message,
      offset: anchor.getBoundingClientRect().top - list.getBoundingClientRect().top
    })
  }
  const restoreTabPosition = () => {
    const position = tabPositions.get(tabPositionKey())
    if (!position) return false
    const index = filtered.indexOf(position.message)
    if (index < 0) {
      tabPositions.delete(tabPositionKey())
      return false
    }
    windowStart = Math.max(0, index - Math.floor(PAGE_SIZE / 2))
    windowEnd = Math.min(filtered.length, windowStart + PAGE_SIZE)
    windowStart = Math.max(0, windowEnd - PAGE_SIZE)
    renderWindow()
    const target = list.querySelector('.message[data-index="' + index + '"]')
    if (!target) return false
    setScrollTop(Math.max(0, scrollTopForTarget(target, position.offset)))
    return true
  }
  const matchingMessages = () => {
    const term = query.value.trim().toLowerCase()
    return allMessages.filter((message) =>
      (activeConversation === 'all' || message.exportConversationId === activeConversation) &&
      (activeKind === 'all' || kindOf(message) === activeKind) &&
      (!term ||
        searchText(message).includes(term) ||
        exportedImageOrVideoFileStem(message) === term)
    )
  }
  const applyFilters = (restorePosition = false) => {
    filtered = matchingMessages()
    renderTimeline()
    if (!restorePosition || !restoreTabPosition()) resetWindow(true)
  }
  const setActiveKind = (kind) => {
    activeKind = kind
    filters.querySelectorAll('[data-kind]').forEach((item) => {
      item.classList.toggle('active', item.dataset.kind === kind)
    })
  }
  const locateInAll = (sourceIndex) => {
    const targetMessage = filtered[sourceIndex]
    if (!targetMessage) return
    rememberTabPosition()
    query.value = ''
    query.blur()
    setActiveKind('all')
    filtered = matchingMessages()
    renderTimeline()
    const targetIndex = filtered.indexOf(targetMessage)
    if (targetIndex < 0) {
      resetWindow(true)
      return
    }
    windowStart = Math.max(0, targetIndex - Math.floor(PAGE_SIZE / 2))
    windowEnd = Math.min(filtered.length, windowStart + PAGE_SIZE)
    windowStart = Math.max(0, windowEnd - PAGE_SIZE)
    renderWindow()
    const target = list.querySelector('.message[data-index="' + targetIndex + '"]')
    if (!target) return
    setScrollTop(Math.max(
      0,
      scrollTopForTarget(target, Math.max(24, (list.clientHeight - target.offsetHeight) / 2))
    ))
    target.classList.add('located')
    window.setTimeout(() => target.classList.remove('located'), 1600)
  }
  const jumpToMonth = (key) => {
    const index = filtered.findIndex((message) => monthKey(message) === key)
    if (index < 0) return
    windowStart = Math.max(0, index - Math.floor(PAGE_SIZE / 4))
    windowEnd = Math.min(filtered.length, windowStart + PAGE_SIZE)
    windowStart = Math.max(0, windowEnd - PAGE_SIZE)
    renderWindow()
    const target = list.querySelector('.message[data-index="' + index + '"]')
    setScrollTop(target ? Math.max(0, scrollTopForTarget(target, 24)) : 0)
    setExpandedTimelineYear(key.split('-')[0])
    timeline.querySelectorAll('.timeline-month').forEach((button) => {
      button.classList.toggle('active', button.dataset.month === key)
    })
  }
  const slideWindow = (direction) => {
    const renderedMessages = list.querySelectorAll('.message')
    const anchor =
      direction < 0 ? renderedMessages[0] : renderedMessages[renderedMessages.length - 1]
    const anchorIndex = anchor ? Number(anchor.dataset.index) : undefined
    const anchorOffset = anchor
      ? anchor.getBoundingClientRect().top - list.getBoundingClientRect().top
      : 0
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
    scheduleActiveMonthUpdate()
    if (scrollLoadSuppressed) return
    if (movingUp && nearTop) scheduleWindowSlide(-1)
    else if (!movingUp && nearBottom) scheduleWindowSlide(1)
  })
  list.addEventListener('wheel', (event) => {
    if (!scrollLoadSuppressed && event.deltaY < 0 && list.scrollTop <= 1) {
      scheduleWindowSlide(-1)
    }
  }, { passive: true })
  query.addEventListener('input', () => applyFilters())
  filters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-kind]')
    if (!button) return
    rememberTabPosition()
    setActiveKind(button.dataset.kind)
    applyFilters(true)
  })
  conversationTrigger.addEventListener('click', () => {
    setConversationMenuOpen(conversationMenu.hidden)
  })
  conversationTrigger.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    setConversationMenuOpen(true, true)
  })
  conversationMenu.addEventListener('click', (event) => {
    const option = event.target.closest('[data-conversation-id]')
    if (option) selectConversation(option.dataset.conversationId)
  })
  conversationMenu.addEventListener('keydown', (event) => {
    const options = Array.from(conversationMenu.querySelectorAll('[data-conversation-id]'))
    const currentIndex = options.indexOf(document.activeElement)
    let nextIndex = currentIndex
    if (event.key === 'ArrowDown') nextIndex = Math.min(options.length - 1, currentIndex + 1)
    else if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1)
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = options.length - 1
    else if (event.key === 'Escape') {
      event.preventDefault()
      setConversationMenuOpen(false)
      conversationTrigger.focus()
      return
    } else return
    event.preventDefault()
    if (options[nextIndex]) options[nextIndex].focus()
  })
  timeline.addEventListener('click', (event) => {
    const yearButton = event.target.closest('[data-year]')
    if (yearButton) {
      setExpandedTimelineYear(
        yearButton.dataset.year === expandedTimelineYear ? '' : yearButton.dataset.year
      )
      return
    }
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
    const locateButton = event.target.closest('[data-locate-index]')
    if (locateButton) {
      locateInAll(Number(locateButton.dataset.locateIndex))
      return
    }
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
    if (event.key === 'Escape') {
      closeLightbox()
      setConversationMenuOpen(false)
    }
  })
  document.addEventListener('click', (event) => {
    if (!conversationFilter.contains(event.target)) setConversationMenuOpen(false)
  })

  title.textContent = archive.name || ${JSON.stringify(name)}
  renderConversations()
  applyFilters()
      finishLoading()
    } catch (error) {
      console.error('初始化聊天档案失败', error)
      failLoading('消息数据解析失败，请确认档案文件完整后重试')
    }
  }

  if (window.__WECHAT_EXPORT__) {
    initializeArchive()
    return
  }

  const loadArchiveData = () => {
    const dataScript = document.createElement('script')
    dataScript.src = 'data/messages.js'
    dataScript.onload = () => {
      if (!window.__WECHAT_EXPORT__) {
        failLoading('消息数据为空或格式不正确，请重新导出聊天档案')
        return
      }
      initializeArchive()
    }
    dataScript.onerror = () => {
      failLoading('未找到消息数据，请确认 data/messages.js 与当前页面在同一档案中')
    }
    document.body.appendChild(dataScript)
  }

  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => window.setTimeout(loadArchiveData, 0))
  } else {
    window.setTimeout(loadArchiveData, 0)
  }
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
  <div class="archive-loading" id="archive-loading" role="status" aria-live="polite" aria-busy="true">
    <div class="archive-loading-indicator" aria-hidden="true"></div>
    <strong id="archive-loading-title">正在加载聊天档案</strong>
    <span id="archive-loading-detail">消息较多时可能需要一些时间</span>
  </div>
  <main class="page">
    <header class="toolbar">
      <div class="archive-heading">
        <span class="title" id="archive-title">${safe(name)}</span>
        <div class="conversation-filter" id="conversation-filter" hidden>
          <button class="conversation-trigger" id="conversation-trigger" type="button" aria-label="筛选聊天" aria-haspopup="listbox" aria-expanded="false" aria-controls="conversation-menu">
            <span class="conversation-trigger-avatar" id="conversation-trigger-avatar">全</span>
            <span class="conversation-trigger-name" id="conversation-trigger-name">全部聊天</span>
            <svg class="conversation-switch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m16 3 4 4-4 4"></path>
              <path d="M20 7H4"></path>
              <path d="m8 21-4-4 4-4"></path>
              <path d="M4 17h16"></path>
            </svg>
          </button>
          <div class="conversation-menu" id="conversation-menu" role="listbox" aria-label="选择聊天" hidden></div>
        </div>
      </div>
      <div class="controls">
        <input id="query" type="search" placeholder="搜索发送者、消息内容或媒体文件名（不含后缀）…" aria-label="搜索消息">
      </div>
      <div class="filters" id="filters">
        <button class="filter-button active" type="button" data-kind="all">全部</button>
        <button class="filter-button" type="button" data-kind="text">文字</button>
        <button class="filter-button" type="button" data-kind="media">图片 / 视频</button>
        <button class="filter-button" type="button" data-kind="voice">语音</button>
        <button class="filter-button" type="button" data-kind="file">文件</button>
        <button class="filter-button" type="button" data-kind="share">分享</button>
        <button class="filter-button" type="button" data-kind="system">系统</button>
        <span class="count" id="count"></span>
      </div>
    </header>
    <section class="archive-layout">
      <aside class="archive-navigation">
        <nav class="timeline" id="timeline" aria-label="聊天时间轴"></nav>
      </aside>
      <section class="scroll" id="messages">
        <div class="empty">正在加载聊天档案…</div>
      </section>
    </section>
  </main>
  <div class="lightbox" id="lightbox">
    <button class="lightbox-close" id="lightbox-close" type="button" aria-label="关闭图片预览">×</button>
    <img id="lightbox-image" alt="预览">
  </div>
  <script>${renderExportScript(name)}</script>
</body>
</html>`
}
