export const REPORT_TEMPLATE_FRAGMENT_CONTRACT_VERSION = '1'

// 外部模板可以通过变量调整主题，但不允许生产 fragment 失去基本几何约束。
export const REPORT_TEMPLATE_FRAGMENT_CONTRACT_CSS = `
:root {
  --tm-avatar-message-size: 34px;
  --tm-avatar-participant-size: 22px;
  --tm-avatar-ranking-size: 26px;
  --tm-avatar-hero-size: 40px;
  --tm-avatar-radius: 50%;
  --tm-message-gap: 8px;
  --tm-participant-gap: 4px;
}

html,
body {
  min-width: 0 !important;
  max-width: 100%;
}

.tm-fragment { min-width: 0 !important; max-width: 100%; }

.tm-fragment,
.tm-fragment * {
  overflow-wrap: anywhere;
  word-break: break-word;
}

.tm-message {
  display: flex !important;
  align-items: flex-start !important;
  gap: var(--tm-message-gap, 8px);
  min-width: 0 !important;
  max-width: 100%;
}

.tm-message__body {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  max-width: 100%;
}

.tm-message__meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 6px;
  min-width: 0;
  max-width: 100%;
}

.tm-participant {
  display: inline-flex !important;
  align-items: center !important;
  gap: var(--tm-participant-gap, 4px);
  min-width: 0 !important;
  max-width: 100%;
}

.tm-avatar {
  box-sizing: border-box !important;
  aspect-ratio: 1 / 1 !important;
  object-fit: cover !important;
  flex-shrink: 0 !important;
  border-radius: var(--tm-avatar-radius, 50%);
}

img.tm-avatar.tm-avatar--message {
  width: clamp(28px, var(--tm-avatar-message-size, 34px), 44px) !important;
  height: clamp(28px, var(--tm-avatar-message-size, 34px), 44px) !important;
  min-width: clamp(28px, var(--tm-avatar-message-size, 34px), 44px) !important;
  max-width: clamp(28px, var(--tm-avatar-message-size, 34px), 44px) !important;
  min-height: clamp(28px, var(--tm-avatar-message-size, 34px), 44px) !important;
  max-height: clamp(28px, var(--tm-avatar-message-size, 34px), 44px) !important;
  flex-basis: clamp(28px, var(--tm-avatar-message-size, 34px), 44px) !important;
}

img.tm-avatar.tm-avatar--participant {
  width: clamp(18px, var(--tm-avatar-participant-size, 22px), 28px) !important;
  height: clamp(18px, var(--tm-avatar-participant-size, 22px), 28px) !important;
  min-width: clamp(18px, var(--tm-avatar-participant-size, 22px), 28px) !important;
  max-width: clamp(18px, var(--tm-avatar-participant-size, 22px), 28px) !important;
  min-height: clamp(18px, var(--tm-avatar-participant-size, 22px), 28px) !important;
  max-height: clamp(18px, var(--tm-avatar-participant-size, 22px), 28px) !important;
  flex-basis: clamp(18px, var(--tm-avatar-participant-size, 22px), 28px) !important;
}

img.tm-avatar.tm-avatar--ranking {
  width: clamp(20px, var(--tm-avatar-ranking-size, 26px), 34px) !important;
  height: clamp(20px, var(--tm-avatar-ranking-size, 26px), 34px) !important;
  min-width: clamp(20px, var(--tm-avatar-ranking-size, 26px), 34px) !important;
  max-width: clamp(20px, var(--tm-avatar-ranking-size, 26px), 34px) !important;
  min-height: clamp(20px, var(--tm-avatar-ranking-size, 26px), 34px) !important;
  max-height: clamp(20px, var(--tm-avatar-ranking-size, 26px), 34px) !important;
  flex-basis: clamp(20px, var(--tm-avatar-ranking-size, 26px), 34px) !important;
}

img.tm-avatar.tm-avatar--hero {
  width: clamp(28px, var(--tm-avatar-hero-size, 40px), 56px) !important;
  height: clamp(28px, var(--tm-avatar-hero-size, 40px), 56px) !important;
  min-width: clamp(28px, var(--tm-avatar-hero-size, 40px), 56px) !important;
  max-width: clamp(28px, var(--tm-avatar-hero-size, 40px), 56px) !important;
  min-height: clamp(28px, var(--tm-avatar-hero-size, 40px), 56px) !important;
  max-height: clamp(28px, var(--tm-avatar-hero-size, 40px), 56px) !important;
}

.tm-message__author,
.tm-message__time,
.tm-message__text,
.tm-participant__name {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}

@media (max-width: 680px) {
  /* 只折叠承载 production fragment 的主内容网格，避免桌面模板把正文压成多列窄缝。 */
  main > :has(.tm-fragment) {
    grid-template-columns: minmax(0, 1fr) !important;
    min-width: 0 !important;
  }
}
`

export const injectReportTemplateFragmentContract = (html: string): string => {
  const style = `<style id="tm-production-fragment-contract" data-version="${REPORT_TEMPLATE_FRAGMENT_CONTRACT_VERSION}">${REPORT_TEMPLATE_FRAGMENT_CONTRACT_CSS}</style>`
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${style}</head>`)
  return `${style}${html}`
}
