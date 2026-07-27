import type { Message } from '../shared/types'

export const exportStyles = `:root{color-scheme:light;--page:#edf2f0;--panel:#fff;--text:#1d2a25;--muted:#68766f;--border:#d8e2dc;--mine:#d9f0e2;--accent:#176b57}*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--text);font:14px system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}.page{max-width:1240px;height:100vh;margin:auto;padding:22px 28px;display:flex;flex-direction:column}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:18px 24px;box-shadow:0 8px 24px #29483b12}.title{font-size:18px;font-weight:750}.meta{color:var(--muted);margin-left:12px;font-size:13px}.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:0}.controls input,.controls button{border:1px solid var(--border);border-radius:10px;padding:9px 12px;background:#fff;font:inherit}.controls input[type=search]{width:260px}.controls input[type=datetime-local],.controls #jump{display:none}.controls button{background:var(--accent);border-color:var(--accent);color:#fff;cursor:pointer}.count{margin-left:8px;color:var(--muted);font-size:13px}.scroll{margin-top:18px;overflow:auto;flex:1;padding:10px 6px 30px}.message{display:flex;flex-direction:column;gap:6px;max-width:820px;margin:0 0 22px}.message.hidden{display:none}.message.sent{align-items:flex-end;margin-left:auto}.time{color:var(--muted);font-size:11px;margin:0 12px}.row{display:flex;gap:12px;align-items:flex-end}.sent .row{flex-direction:row-reverse}.avatar{width:38px;height:38px;flex:0 0 auto;border-radius:50%;overflow:hidden;background:#dcebe4;display:grid;place-items:center}.avatar img{width:100%;height:100%;object-fit:cover}.bubble{max-width:min(78%,760px);padding:13px 15px;border:1px solid var(--border);border-radius:10px 18px 18px 18px;background:#fff;box-shadow:0 4px 12px #29483b0d}.sent .bubble{background:var(--mine);border-color:#c7e6d4;border-radius:18px 10px 18px 18px}.sender{color:var(--muted);font-size:12px;margin-bottom:5px}.content{line-height:1.7;word-break:break-word;white-space:pre-wrap}.audio-wrap{width:260px;min-width:260px}.audio{display:block;width:260px;height:38px}.quote-reference{margin-top:10px;padding:8px 11px;border-left:3px solid #8eb4a3;background:#f1f6f3;color:var(--muted);display:grid;gap:3px}.quote-reference strong{font-weight:650;color:var(--text)}.quote-reference span{white-space:pre-wrap}.media-image{display:block;max-width:100%;max-height:360px;border-radius:12px;object-fit:contain;background:#eef2f5;cursor:zoom-in}.lightbox{position:fixed;inset:0;display:none;place-items:center;background:#14231ddd;z-index:10;padding:24px;overflow:auto}.lightbox.open{display:grid}.lightbox img{width:min(86vw,980px);max-height:88vh;object-fit:contain;cursor:zoom-in;transform:scale(var(--zoom,1));transform-origin:center;transition:transform .12s ease}`
const safe = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c
  )

export function renderExportPage(name: string, messages: Message[]): string {
  const body = messages
    .map((m) => {
      const avatar = m.img
        ? `<img src="${safe(m.img)}" alt="">`
        : safe((m.name || (m.isSender ? '我' : '友')).slice(0, 1))
      const audio = m.voiceDataUrl
        ? `<div class="audio-wrap"><audio class="audio" controls preload="metadata" src="${m.voiceDataUrl}"></audio></div>`
        : ''
      const quote =
        m.contentData?.type === 'quote'
          ? `<div class="quote-reference"><strong>${safe(m.contentData.quotedSender || '引用消息')}</strong><span>${safe(m.contentData.quotedContent || '[引用消息]')}</span></div>`
          : ''
      const media =
        m.exportMediaUrl && m.exportMediaType === 'image'
          ? `<img class="media-image" src="${safe(m.exportMediaUrl)}" alt="图片">`
          : m.exportMediaUrl && m.exportMediaType === 'video'
            ? `<video class="media-image" controls src="${safe(m.exportMediaUrl)}"></video>`
            : m.exportMediaUrl && m.exportMediaType === 'sticker'
              ? `<img class="media-image" src="${safe(m.exportMediaUrl)}" alt="表情包">`
              : ''
      const avatarMarkup =
        m.exportShowAvatar === false
          ? ''
          : `<div class="avatar">${m.exportAvatarUrl ? `<img src="${safe(m.exportAvatarUrl)}" alt="">` : avatar}</div>`
      const text = m.content || (m.contentData?.type === 'quote' ? m.contentData.title : '')
      return `<article class="message${m.isSender ? ' sent' : ''}" data-time="${m.createTime || 0}" data-search="${safe(`${m.name || ''} ${m.content || ''} ${m.type}`.toLowerCase())}"><div class="time">${safe(m.datetime)}</div><div class="row">${avatarMarkup}<div class="bubble"><div class="sender">${safe(m.name || (m.isSender ? '我' : '联系人'))}</div>${media}${audio}${quote}<div class="content">${safe(text || (!media && !audio && !quote ? `[${m.type}]` : ''))}</div></div></div></article>`
    })
    .join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe(name)} - 聊天记录</title><style>${exportStyles}</style></head><body><main class="page"><header class="toolbar"><div><span class="title">${safe(name)}</span><span class="meta">${messages.length.toLocaleString()} 条消息</span></div><div class="controls"><input id="query" type="search" placeholder="搜索消息..."><input id="point" type="datetime-local"><button id="jump">跳转</button><span class="count" id="count"></span></div></header><section class="scroll" id="messages">${body}</section></main><div class="lightbox" id="lightbox"><img id="lightbox-image" alt="预览"></div><script>(()=>{const all=[...document.querySelectorAll('.message')],q=document.querySelector('#query'),d=document.querySelector('#point'),c=document.querySelector('#count'),box=document.querySelector('#lightbox'),preview=document.querySelector('#lightbox-image');let zoom=1;const updateZoom=()=>preview.style.setProperty('--zoom',zoom);const update=()=>{const term=q.value.trim().toLowerCase(),at=d.value?new Date(d.value).getTime()/1000:0;let n=0;all.forEach(x=>{const ok=(!term||x.dataset.search.includes(term))&&(!at||Number(x.dataset.time)>=at);x.classList.toggle('hidden',!ok);if(ok)n++});c.textContent='共 '+n+' 条'};q.addEventListener('input',update);d.addEventListener('change',update);document.querySelector('#jump').onclick=()=>{const at=d.value?new Date(d.value).getTime()/1000:0;all.find(x=>Number(x.dataset.time)>=at)?.scrollIntoView({behavior:'smooth',block:'center'})};document.querySelectorAll('.media-image').forEach(image=>image.addEventListener('click',()=>{if(image.tagName==='IMG'){preview.src=image.src;zoom=1;updateZoom();box.classList.add('open')}}));preview.addEventListener('wheel',event=>{event.preventDefault();zoom=Math.min(5,Math.max(.5,zoom+(event.deltaY<0?.2:-.2)));updateZoom()},{passive:false});preview.addEventListener('dblclick',()=>{zoom=1;updateZoom()});box.addEventListener('click',event=>{if(event.target===box)box.classList.remove('open')});update()})()</script></body></html>`
}
