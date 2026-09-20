import React from 'react'

export type IndexStatusTone = 'ok' | 'warn' | 'error' | 'idle'

interface IndexStatusBadgeProps {
  label: string
  tone: IndexStatusTone
}

/**
 * 索引状态徽章（`● 已完成` 这种）。
 *
 * 存在的意义是把**状态**从标题里拆出来：之前状态是和卡片标题混在同一行的文字，
 * 既没有视觉权重差、也无法一眼扫到。
 *
 * 颜色只用项目既有的 theme token（`--wxex-success` / `--wxex-warning` / `--wxex-danger`），
 * 不另起一套彩虹色 —— 否则主题切换时会和整个应用脱节。
 */
export function IndexStatusBadge({ label, tone }: IndexStatusBadgeProps): React.ReactElement {
  return (
    <span className={`local-index-badge is-${tone}`}>
      <span className="local-index-badge-dot" aria-hidden />
      {label}
    </span>
  )
}
