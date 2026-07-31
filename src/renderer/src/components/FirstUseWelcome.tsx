import React from 'react'

interface FirstUseWelcomeProps {
  onDismiss: () => void
  onOpenSearch: () => void
  onOpenReport: () => void
  onOpenAISettings: () => void
}

const GUIDE_URL =
  'https://github.com/Wxw-Gu/WechatExplorer/blob/main/docs/user-guide/getting-started.md'

export function FirstUseWelcome({
  onDismiss,
  onOpenSearch,
  onOpenReport,
  onOpenAISettings
}: FirstUseWelcomeProps): React.ReactElement {
  return (
    <div className="first-use-welcome-overlay" role="presentation">
      <section
        className="first-use-welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-use-welcome-title"
      >
        <button
          type="button"
          className="first-use-welcome-close"
          onClick={onDismiss}
          aria-label="关闭欢迎提示"
        >
          ×
        </button>
        <div className="first-use-welcome-mark" aria-hidden="true">
          ✦
        </div>
        <p className="first-use-welcome-eyebrow">微信已连接</p>
        <h2 id="first-use-welcome-title">开始探索你的微信</h2>
        <p className="first-use-welcome-lead">
          最关键的一步已经完成。现在，让 AI 帮你看看最近的聊天都发生了什么。
        </p>

        <button type="button" className="first-use-welcome-feature" onClick={onOpenReport}>
          <span className="first-use-welcome-feature-icon" aria-hidden="true">
            ✦
          </span>
          <span className="first-use-welcome-feature-copy">
            <strong>试试 AI 群聊日报</strong>
            <small>选择一个群聊，看看最近聊了什么</small>
          </span>
          <span className="first-use-welcome-feature-arrow" aria-hidden="true">
            立即体验 →
          </span>
        </button>

        <div className="first-use-welcome-secondary-actions">
          <button type="button" onClick={onDismiss}>
            查看聊天记录
          </button>
          <button type="button" onClick={onOpenSearch}>
            问问你的微信
          </button>
        </div>

        <div className="first-use-welcome-footer">
          <span>还没有配置 AI？</span>
          <button type="button" onClick={onOpenAISettings}>
            配置 AI 模型
          </button>
          <a href={GUIDE_URL} target="_blank" rel="noreferrer">
            查看完整使用教程
          </a>
        </div>
      </section>
    </div>
  )
}
