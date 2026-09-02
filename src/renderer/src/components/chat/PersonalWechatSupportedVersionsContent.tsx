import type React from 'react'

export const WECHAT_VERSION_DOWNLOAD_URL = 'https://github.com/zsbai/wechat-versions/releases'

export const BUNDLED_WECHAT_VERSIONS = [
  '4.1.6.12',
  '4.1.6.46',
  '4.1.6.47',
  '4.1.7.31',
  '4.1.7.55',
  '4.1.7.57',
  '4.1.8.28',
  '4.1.8.29',
  '4.1.8.104',
  '4.1.8.107',
  '4.1.9.52',
  '4.1.9.55',
  '4.1.9.58',
  '4.1.10.53',
  '4.1.11.53'
] as const

export function PersonalWechatSupportedVersionsContent(): React.ReactElement {
  return (
    <>
      <a
        className="w-fit rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary hover:border-primary"
        href={WECHAT_VERSION_DOWNLOAD_URL}
        target="_blank"
        rel="noreferrer"
      >
        下载微信历史版本 ↗
      </a>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {BUNDLED_WECHAT_VERSIONS.map((version) => (
          <span
            className="rounded-md border border-border bg-background px-2 py-2 text-center text-xs text-muted-foreground"
            key={version}
          >
            {version}
          </span>
        ))}
      </div>
    </>
  )
}
