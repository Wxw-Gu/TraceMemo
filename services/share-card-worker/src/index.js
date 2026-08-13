const encoder = new TextEncoder()
const DAY_MS = 86_400_000
// Add the TXT filename and content supplied by the WeChat test-account page when
// domain verification is required. Never commit a real verification value.
const WECHAT_DOMAIN_VERIFICATION = new Map()

const json = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) }
  })

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const safeJson = (value) => JSON.stringify(value).replaceAll('<', '\\u003c')

const cardKey = (id) => `cards/${id}/card.json`
const imageKey = (id) => `cards/${id}/report.png`
const thumbnailKey = (id) => `cards/${id}/thumbnail.jpg`

const storageUnavailable = () =>
  json(
    {
      error: '图片存储服务尚未启用，请在 Cloudflare 控制台启用 R2 后重新生成分享卡片'
    },
    { status: 503 }
  )

const readCard = async (env, id) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const object = await env.REPORTS.get(cardKey(id))
  if (!object) return null
  const card = JSON.parse(await object.text())
  if (Date.parse(card.expiresAt) <= Date.now()) {
    await deleteCard(env, id)
    return null
  }
  return card
}

const deleteCard = async (env, id) => {
  await env.REPORTS.delete([cardKey(id), imageKey(id), thumbnailKey(id)])
}

const bearerAuthorized = (request, env) => {
  const value = request.headers.get('authorization') || ''
  return Boolean(env.UPLOAD_TOKEN) && value === `Bearer ${env.UPLOAD_TOKEN}`
}

const publicOrigin = (request, env) =>
  String(env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/+$/, '')

const createCard = async (request, env) => {
  if (!bearerAuthorized(request, env)) return json({ error: '未授权' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (!body) return json({ error: '请求体无效' }, { status: 400 })
  const title = String(body.title || '')
    .trim()
    .slice(0, 64)
  const description = String(body.description || '')
    .trim()
    .slice(0, 120)
  if (!title || !body.imageBase64 || !body.thumbnailBase64) {
    return json({ error: '缺少标题或图片' }, { status: 400 })
  }
  const image = Uint8Array.from(atob(body.imageBase64), (char) => char.charCodeAt(0))
  const thumbnail = Uint8Array.from(atob(body.thumbnailBase64), (char) => char.charCodeAt(0))
  if (image.byteLength > 25 * 1024 * 1024 || thumbnail.byteLength > 2 * 1024 * 1024) {
    return json({ error: '图片超过大小限制' }, { status: 413 })
  }

  const id = crypto.randomUUID()
  const days = Math.max(1, Math.min(30, Number(body.expiresInDays || env.DEFAULT_EXPIRY_DAYS || 7)))
  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + days * DAY_MS).toISOString()
  const card = { id, title, description, createdAt, expiresAt }
  await Promise.all([
    env.REPORTS.put(cardKey(id), JSON.stringify(card), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' }
    }),
    env.REPORTS.put(imageKey(id), image, {
      httpMetadata: { contentType: 'image/png', cacheControl: 'private, max-age=300' }
    }),
    env.REPORTS.put(thumbnailKey(id), thumbnail, {
      httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=300' }
    })
  ])
  const origin = publicOrigin(request, env)
  return json({
    cardId: id,
    shareUrl: `${origin}/s/${id}`,
    viewUrl: `${origin}/v/${id}`,
    expiresAt
  })
}

const serveAsset = async (env, id, kind) => {
  const card = await readCard(env, id)
  if (!card) return new Response('Not found', { status: 404 })
  const object = await env.REPORTS.get(kind === 'thumbnail' ? thumbnailKey(id) : imageKey(id))
  if (!object) return new Response('Not found', { status: 404 })
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('x-content-type-options', 'nosniff')
  headers.set('cache-control', kind === 'thumbnail' ? 'public, max-age=300' : 'private, max-age=60')
  return new Response(object.body, { headers })
}

const sharePage = (request, env, card) => {
  const origin = publicOrigin(request, env)
  const viewUrl = `${origin}/v/${card.id}`
  const cardLinkUrl = `${origin}/l/${card.id}`
  const imageUrl = `${origin}/a/${card.id}/thumbnail`
  const share = { title: card.title, desc: card.description, link: cardLinkUrl, imgUrl: imageUrl }
  return new Response(
    `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta property="og:title" content="${escapeHtml(card.title)}">
  <meta property="og:description" content="${escapeHtml(card.description)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <title>${escapeHtml(card.title)}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f3f6f5;color:#17201d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{min-height:100vh;padding:48px 24px;display:flex;align-items:center;justify-content:center}
    .card{width:min(100%,440px);background:#fff;border-radius:24px;padding:30px;box-shadow:0 18px 60px rgba(23,32,29,.10);text-align:center}
    .arrow{font-size:52px;color:#16a66a;transform:rotate(-20deg);margin:-10px 0 12px}
    h1{font-size:23px;margin:0 0 12px}.desc{color:#61706a;line-height:1.7;margin:0 0 28px}
    .hint{background:#ecf8f2;border:1px solid #cdebdc;border-radius:16px;padding:18px;line-height:1.7}
    .open{display:inline-block;margin-top:22px;color:#08794c;text-decoration:none;font-weight:650}
    #status{font-size:13px;color:#7f8d87;margin-top:18px}
  </style>
</head>
<body><main><section class="card">
  <div class="arrow">↗</div>
  <h1>点击右上角 ··· 分享</h1>
  <p class="desc">${escapeHtml(card.description)}</p>
  <div class="hint">发送给好友或群聊后，将显示为标题、描述和缩略图组成的微信卡片。</div>
  <a class="open" href="${escapeHtml(viewUrl)}">先查看完整日报</a>
  <p id="status">正在准备微信分享信息…</p>
</section></main>
<script src="https://res.wx.qq.com/open/js/jweixin-1.6.0.js"></script>
<script>
const share=${safeJson(share)};
const status=document.getElementById('status');
fetch('/api/wx-signature?url='+encodeURIComponent(location.href.split('#')[0]))
  .then(r=>r.json().then(data=>({ok:r.ok,data})))
  .then(({ok,data})=>{
    if(!ok) throw new Error(data.error||'签名失败');
    wx.config({...data,debug:false,jsApiList:['updateAppMessageShareData','updateTimelineShareData']});
    wx.ready(()=>{
      wx.updateAppMessageShareData({...share,success:()=>status.textContent='分享卡片已准备好'});
      wx.updateTimelineShareData({title:share.title,link:share.link,imgUrl:share.imgUrl});
      status.textContent='分享卡片已准备好';
    });
    wx.error(err=>{status.textContent='微信分享配置失败：'+(err.errMsg||'未知错误')});
  })
  .catch(err=>{status.textContent='微信分享配置失败：'+err.message});
</script></body></html>`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline' https://res.wx.qq.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'"
      }
    }
  )
}

const viewPage = (env, card) => {
  const origin = String(env.PUBLIC_ORIGIN).replace(/\/+$/, '')
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(card.title)}</title><style>*{box-sizing:border-box}body{margin:0;background:#eef2f0;color:#17201d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{padding:20px;background:#fff;position:sticky;top:0;box-shadow:0 1px 8px #0001}h1{font-size:18px;margin:0 0 6px}p{margin:0;color:#68746f;font-size:13px}.image{display:block;width:min(100%,900px);height:auto;margin:20px auto;background:#fff}</style></head><body><header><h1>${escapeHtml(card.title)}</h1><p>${escapeHtml(card.description)} · 有效期至 ${escapeHtml(card.expiresAt.slice(0, 10))}</p></header><img class="image" src="${origin}/a/${card.id}/report" alt="${escapeHtml(card.title)}"></body></html>`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'"
      }
    }
  )
}

const cachedWechatValue = async (cacheKey, ttl, loader) => {
  const cache = caches.default
  const request = new Request(`https://wechat-cache.invalid/${cacheKey}`)
  const cached = await cache.match(request)
  if (cached) return cached.json()
  const value = await loader()
  await cache.put(request, json(value, { headers: { 'cache-control': `public, max-age=${ttl}` } }))
  return value
}

const getAccessToken = (env) =>
  cachedWechatValue(`access-token/${env.WECHAT_APP_ID}`, 6900, async () => {
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token')
    url.searchParams.set('grant_type', 'client_credential')
    url.searchParams.set('appid', env.WECHAT_APP_ID)
    url.searchParams.set('secret', env.WECHAT_APP_SECRET)
    const data = await fetch(url).then((response) => response.json())
    if (!data.access_token) throw new Error(data.errmsg || '无法获取 access_token')
    return { value: data.access_token }
  })

const getTicket = async (env) => {
  const token = await getAccessToken(env)
  return cachedWechatValue(`jsapi-ticket/${env.WECHAT_APP_ID}`, 6900, async () => {
    const url = new URL('https://api.weixin.qq.com/cgi-bin/ticket/getticket')
    url.searchParams.set('access_token', token.value)
    url.searchParams.set('type', 'jsapi')
    const data = await fetch(url).then((response) => response.json())
    if (!data.ticket) throw new Error(data.errmsg || '无法获取 jsapi_ticket')
    return { value: data.ticket }
  })
}

const sha1 = async (value) => {
  const digest = await crypto.subtle.digest('SHA-1', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const signature = async (request, env) => {
  if (!env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET) {
    return json({ error: '微信 JS-SDK 尚未配置' }, { status: 503 })
  }
  const pageUrl = new URL(request.url).searchParams.get('url')
  if (!pageUrl) return json({ error: '缺少签名 URL' }, { status: 400 })
  const parsed = new URL(pageUrl)
  if (parsed.origin !== publicOrigin(request, env)) {
    return json({ error: '只能签名当前分享域名' }, { status: 400 })
  }
  const ticket = await getTicket(env)
  const nonceStr = crypto.randomUUID().replaceAll('-', '')
  const timestamp = Math.floor(Date.now() / 1000)
  const source = `jsapi_ticket=${ticket.value}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${pageUrl}`
  return json({
    appId: env.WECHAT_APP_ID,
    timestamp,
    nonceStr,
    signature: await sha1(source)
  })
}

const router = async (request, env) => {
  const url = new URL(request.url)
  const verificationContent = WECHAT_DOMAIN_VERIFICATION.get(url.pathname.slice(1))
  if (request.method === 'GET' && verificationContent) {
    return new Response(verificationContent, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff'
      }
    })
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({
      ok: true,
      service: 'wechatexplorer-share-card',
      storage: env.REPORTS ? 'ready' : 'unavailable'
    })
  }
  if (!env.REPORTS && (url.pathname === '/api/cards' || /^\/(s|l|v|a)\//i.test(url.pathname))) {
    return storageUnavailable()
  }
  if (request.method === 'POST' && url.pathname === '/api/cards') return createCard(request, env)
  if (request.method === 'GET' && url.pathname === '/api/wx-signature') {
    try {
      return await signature(request, env)
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 502 }
      )
    }
  }
  const match = url.pathname.match(/^\/(s|l|v|a)\/([0-9a-f-]{36})(?:\/(report|thumbnail))?$/i)
  if (!match) return new Response('Not found', { status: 404 })
  const [, route, id, asset] = match
  if (route === 'a') return serveAsset(env, id, asset)
  const card = await readCard(env, id)
  if (!card) return new Response('卡片不存在或已过期', { status: 404 })
  if (route === 'l') {
    return Response.redirect(`${publicOrigin(request, env)}/v/${card.id}`, 302)
  }
  return route === 's' ? sharePage(request, env, card) : viewPage(env, card)
}

const cleanup = async (env) => {
  let cursor
  do {
    const listed = await env.REPORTS.list({ prefix: 'cards/', cursor, include: ['httpMetadata'] })
    const metadataObjects = listed.objects.filter((object) => object.key.endsWith('/card.json'))
    for (const item of metadataObjects) {
      const object = await env.REPORTS.get(item.key)
      if (!object) continue
      const card = JSON.parse(await object.text())
      if (Date.parse(card.expiresAt) <= Date.now()) await deleteCard(env, card.id)
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
}

export default {
  fetch: (request, env) => router(request, env),
  scheduled: (_controller, env, ctx) => ctx.waitUntil(cleanup(env))
}

export { escapeHtml, sha1 }
