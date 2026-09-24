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
