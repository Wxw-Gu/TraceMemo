import type { Message, ParsedContent } from '../shared/types'
import { favoriteRowToContent } from '../shared/favorites'
import type { Wcdb4Client } from './wcdb4-client'

/** 收藏只读服务：favorite.db → 可读卡片 / 导出消息。 */
export class FavoritesService {
  constructor(private readonly wcdb4Client: Wcdb4Client) {}

  async listContents(limit = 200): Promise<ParsedContent[]> {
    const rows = await this.wcdb4Client.listFavoriteItems(limit)
    return rows.map((row) => favoriteRowToContent(row))
  }

  /** 收藏转成导出/搜索可用的 Message 列表（合成会话「收藏」）。 */
  async listExportMessages(limit = 200): Promise<Message[]> {
    const rows = await this.wcdb4Client.listFavoriteItems(limit)
    return rows.map((row, index) => {
      const contentData = favoriteRowToContent(row)
      const createTime = Number(row.update_time) || 0
      return {
        id: `fav-${row.local_id ?? index}`,
        from: 'favorite',
        type: '收藏',
        datetime: createTime ? new Date(createTime * 1000).toISOString() : '',
        content: textOf(contentData),
        isSender: false,
        createTime,
        name: '收藏',
        contentData
      } as Message
    })
  }

  /** 只读关键词搜索收藏文本（title/desc/正文）。 */
  async search(query: string, limit = 50): Promise<ParsedContent[]> {
    const needle = String(query || '').trim().toLowerCase()
    if (!needle) return []
    const items = await this.listContents(500)
    return items.filter((item) => textOf(item).toLowerCase().includes(needle)).slice(0, limit)
  }

  /** Local Query API 适配：只要文本与时间戳。 */
  async searchHits(
    query: string,
    limit = 20
  ): Promise<Array<{ text: string; timestamp?: number }>> {
    const rows = await this.wcdb4Client.listFavoriteItems(500)
    const needle = String(query || '').trim().toLowerCase()
    if (!needle) return []
    return rows
      .map((row) => {
        const content = favoriteRowToContent(row)
        return {
          text: textOf(content),
          timestamp: Number(row.update_time) || undefined
        }
      })
      .filter((hit) => hit.text.toLowerCase().includes(needle))
      .slice(0, limit)
  }
}

function textOf(content: ParsedContent): string {
  if (content.type === 'text') return content.content
  if (content.type === 'system') return content.content
  if (content.type === 'share') return [content.title, content.des].filter(Boolean).join(' · ')
  if (content.type === 'location') return content.poiname || content.label || '[位置]'
  if (content.type === 'miniProgram') return content.title || '[小程序]'
  if (content.type === 'forwardBundle') return content.title || '[聊天记录]'
  return '[收藏]'
}
