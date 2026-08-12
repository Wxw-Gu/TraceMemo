#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const templates = [
  {
    id: 'mobile-feed',
    className: 'template-mobile-feed',
    label: 'Mobile 01',
    name: '微信信息流',
    width: 390
  },
  {
    id: 'mobile-magazine',
    className: 'template-mobile-magazine',
    label: 'Mobile 02',
    name: 'AI Magazine',
    width: 390
  },
  {
    id: 'mobile-dashboard',
    className: 'template-mobile-dashboard',
    label: 'Mobile 03',
    name: 'AI Command Center',
    width: 390
  },
  {
    id: 'desktop-workspace',
    className: 'template-desktop-workspace',
    label: 'Desktop 01',
    name: '三栏 AI 工作台',
    width: 1440
  },
  {
    id: 'desktop-editorial',
    className: 'template-desktop-editorial',
    label: 'Desktop 02',
    name: 'Editorial 科技日报',
    width: 1440
  }
]

const sourcePath = path.resolve(process.argv[2] || '')
const outputDir = path.resolve(
  process.argv[3] || path.join(process.cwd(), '.codex', 'report-template-preview')
)
const templatePath = path.join(process.cwd(), 'resources', 'daily_report_templates.html')

if (!sourcePath || !fs.existsSync(sourcePath)) {
  console.error(
    '用法: node scripts/generate-report-template-preview.cjs <现有日报.html> [输出目录]'
  )
  process.exit(1)
}
if (!fs.existsSync(templatePath)) {
  console.error(`模板资源不存在: ${templatePath}`)
  process.exit(1)
}

const document = new JSDOM(fs.readFileSync(sourcePath, 'utf8')).window.document
const templateHtml = fs.readFileSync(templatePath, 'utf8')

const one = (selector) => document.querySelector(selector)
const html = (selector) => one(selector)?.innerHTML || ''
const childrenAfterTitle = (selector) => {
  const section = one(selector)
  if (!section) return ''
  return Array.from(section.children)
    .filter((child) => !child.classList.contains('section-title'))
    .map((child) => child.outerHTML)
    .join('')
}
const sectionClass = (selector) => {
  const section = one(selector)
  return !section || section.classList.contains('empty-section') ? 'empty-section' : ''
}

const statValues = Array.from(document.querySelectorAll('.stat')).map((node) => {
  const strong = node.querySelector('strong')?.textContent?.trim()
  if (strong) return strong
  return node.textContent?.trim().match(/[\d.]+\s*h?/i)?.[0] || ''
})
const title = one('.hero h1')?.textContent?.trim() || document.title
const subItems = Array.from(document.querySelectorAll('.sub > *'))
const dateTimeRange = subItems[0]?.textContent?.trim() || ''
const reportDate = dateTimeRange.match(/\d{4}-\d{2}-\d{2}/)?.[0] || ''
const recordNote = one('.record-note')?.textContent?.trim() || ''
const overview = one('.overview')?.textContent?.trim() || ''
const footer = one('.footer')?.textContent?.trim().replace(/\s+/g, ' ') || ''
const generatedAt = footer.match(/生成时间[：:]\s*([^基]+?)(?:基于|$)/)?.[1]?.trim() || ''
const activityLine = Array.from(document.querySelectorAll('.analytics > .card')).find((node) =>
  node.textContent?.includes('活跃时间线')
)

const values = {
  REPORT_TITLE: title,
  REPORT_DATE: reportDate,
  DATE_RANGE: '今天',
  TIME_SPAN: statValues[2] || dateTimeRange,
  HERO_SUMMARY: overview,
  HERO_TAKEAWAY: '',
  HERO_PENDING: '',
  HERO_STATUS_LINE: '',
  HERO_AVATARS: html('.avatar-grid'),
  HERO_AVATAR_CLASS: sectionClass('.avatar-grid'),
  MESSAGE_COUNT: statValues[0] || '',
  ACTIVE_USERS: statValues[1] || '',
  TOPIC_COUNT: statValues[3] || '',
  RECORD_NOTE: recordNote,
  GENERATED_AT: generatedAt,
  FOOTER_NOTE: footer,
  TOPIC_CARDS: childrenAfterTitle('.topics'),
  IMPORTANT_MESSAGES: childrenAfterTitle('.messages'),
  QUOTE_BLOCKS: childrenAfterTitle('.quotes'),
  QA_CARDS: childrenAfterTitle('.qa'),
  HEAT_BARS: Array.from(document.querySelectorAll('.analytics > .heat-row'))
    .map((node) => node.outerHTML)
    .join(''),
  RANK_ITEMS: Array.from(document.querySelectorAll('.analytics .rank'))
    .map((node) => node.outerHTML)
    .join(''),
  ACTIVITY_TIMELINE: activityLine?.textContent?.trim() || '',
  CLOUD_TAGS: html('.cloud-tags'),
  RESOURCE_ITEMS: childrenAfterTitle('.resources'),
  TODO_CARDS: '',
  UNRESOLVED_CARDS: '',
  STORYLINE_CARDS: '',
  REVERSAL_CARDS: '',
  CHAIN_CARDS: '',
  VISION_TITLE: 'AI 识别的图片精选',
  VISION_CARDS: childrenAfterTitle('.vision'),
  VOICE_CARDS: '',
  VOICE_RANK_CARDS: '',
  BADGE_CARDS: '',
  KEYWORDS_EMPTY_CLASS: sectionClass('.cloud'),
  ANALYTICS_EMPTY_CLASS: sectionClass('.analytics'),
  MESSAGES_EMPTY_CLASS: sectionClass('.messages'),
  TOPICS_EMPTY_CLASS: sectionClass('.topics'),
  QUOTES_EMPTY_CLASS: sectionClass('.quotes'),
  RESOURCES_EMPTY_CLASS: sectionClass('.resources'),
  QA_EMPTY_CLASS: sectionClass('.qa'),
  ACTIONS_EMPTY_CLASS: 'empty-section',
  STORYLINES_EMPTY_CLASS: 'empty-section',
  REVERSALS_EMPTY_CLASS: 'empty-section',
  CHAINS_EMPTY_CLASS: 'empty-section',
  VISION_EMPTY_CLASS: sectionClass('.vision'),
  VOICE_EMPTY_CLASS: 'empty-section',
  VOICE_RANK_EMPTY_CLASS: 'empty-section',
  BADGES_EMPTY_CLASS: 'empty-section',
  HERO_TAKEAWAY_EMPTY_CLASS: 'empty-section',
  HERO_PENDING_EMPTY_CLASS: 'empty-section',
  HERO_STATUS_EMPTY_CLASS: 'empty-section'
}

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

const render = (template) => {
  let result = templateHtml
  const replacements = {
    ...values,
    TEMPLATE_CLASS: template.className,
    TEMPLATE_LABEL: template.label,
    TEMPLATE_NAME: template.name
  }
  const htmlKeys = new Set([
    'HERO_AVATARS',
    'TOPIC_CARDS',
    'IMPORTANT_MESSAGES',
    'QUOTE_BLOCKS',
    'QA_CARDS',
    'HEAT_BARS',
    'RANK_ITEMS',
    'CLOUD_TAGS',
    'RESOURCE_ITEMS',
    'TODO_CARDS',
    'UNRESOLVED_CARDS',
    'STORYLINE_CARDS',
    'REVERSAL_CARDS',
    'CHAIN_CARDS',
    'VISION_CARDS',
    'VOICE_CARDS',
    'VOICE_RANK_CARDS',
    'BADGE_CARDS'
  ])
  for (const [key, value] of Object.entries(replacements)) {
    const safeValue = htmlKeys.has(key) ? String(value || '') : escapeHtml(value)
    result = result.replaceAll(`{{${key}}}`, safeValue)
  }
  return result.replace(/\{\{[A-Z0-9_]+\}\}/g, '')
}

fs.mkdirSync(outputDir, { recursive: true })
for (const template of templates) {
  fs.writeFileSync(path.join(outputDir, `${template.id}.html`), render(template), 'utf8')
}

const reportName = title.replace(/日报$/, '')
const buttons = templates
  .map(
    (template, index) => `
  <button class="${index === 0 ? 'active' : ''}" data-src="${template.id}.html" data-width="${template.width}">
    <span>${template.label}</span><b>${template.name}</b>
  </button>`
  )
  .join('')

const indexHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(reportName)} · 五套日报模板预览</title>
  <style>
    *{box-sizing:border-box} body{margin:0;background:#e9eeeb;color:#17211d;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    header{position:sticky;top:0;z-index:2;padding:18px 24px 14px;background:rgba(255,255,255,.95);border-bottom:1px solid #d7e0da;backdrop-filter:blur(14px)}
    h1{margin:0;font-size:20px} p{margin:5px 0 0;color:#68736c;font-size:12px}.toolbar{display:flex;gap:8px;overflow-x:auto;margin-top:14px;padding-bottom:2px}
    button{display:grid;flex:0 0 auto;gap:2px;min-width:142px;padding:9px 12px;border:1px solid #d8e1db;border-radius:9px;background:#fff;color:#24332b;text-align:left;cursor:pointer}
    button span{color:#708078;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}button b{font-size:12px}button.active{border-color:#16835b;background:#eaf6ef;color:#0d6744}
    .stage{display:flex;justify-content:center;min-height:calc(100vh - 132px);padding:24px;overflow:auto}.frame-shell{width:390px;max-width:100%;overflow:hidden;border:1px solid #cbd6cf;border-radius:14px;background:white;box-shadow:0 18px 48px rgba(30,55,43,.15);transition:width .2s ease}
    iframe{display:block;width:100%;height:calc(100vh - 180px);min-height:680px;border:0;background:white}
    @media(max-width:640px){header{padding:14px 12px 12px}.stage{padding:12px}.frame-shell{border-radius:10px}button{min-width:132px}}
  </style>
</head>
<body>
  <header><h1>${escapeHtml(reportName)} · 五套日报模板</h1><p>同一份 2026-08-11 真实日报数据，可直接切换比较布局、排版和信息密度。</p><div class="toolbar">${buttons}</div></header>
  <main class="stage"><div class="frame-shell"><iframe title="日报模板预览" src="mobile-feed.html"></iframe></div></main>
  <script>
    const frame=document.querySelector('iframe');const shell=document.querySelector('.frame-shell');
    document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('button').forEach(item=>item.classList.remove('active'));button.classList.add('active');frame.src=button.dataset.src;shell.style.width=button.dataset.width+'px'}));
  </script>
</body>
</html>`

fs.writeFileSync(path.join(outputDir, 'index.html'), indexHtml, 'utf8')
console.log(path.join(outputDir, 'index.html'))
