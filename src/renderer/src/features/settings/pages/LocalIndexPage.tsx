import React from 'react'
import { ImageTextIndexSummary } from '../../../components/search/ImageTextIndexSummary'
import { KnowledgeIndexCard } from '../../../components/search/KnowledgeIndexCard'

interface LocalIndexPageProps {
  onNotice: (message: string) => void
  dbReady: boolean
}

/**
 * 设置 · 本地索引。
 *
 * 把「问问微信」背后的两份索引放到设置里集中管理 —— 之前它们只藏在搜索页，
 * 用户既不知道有这么个东西，也不知道它需要手动同步。
 *
 * 信息层级（从上到下）：页面标题 → 一句话说明 → 两张索引卡片。
 * 卡片本身由 `KnowledgeIndexCard` / `ImageTextIndexSummary` 各自负责，
 * 本页只管**容器宽度与卡片间距**，不碰卡片内部布局。
 */
export function LocalIndexPage({ onNotice, dbReady }: LocalIndexPageProps): React.ReactElement {
  return (
    <div className="local-index-page">
      <header className="local-index-head">
        <h2>本地索引</h2>
        <p>
          TraceMemo 的搜索、问问微信和图片文字识别依赖本地索引。
          所有索引数据仅保存在本机，可随时从微信原始数据重新建立。
        </p>
      </header>
      <div className="local-index-cards">
        <KnowledgeIndexCard dbReady={dbReady} onNotice={onNotice} />
        <ImageTextIndexSummary dbReady={dbReady} onNotice={onNotice} />
      </div>
    </div>
  )
}
