import type { Message, ParsedContent } from '../shared/types'
import {
  emoticonDisplayText,
  emoticonItemToContent,
  parseEmoticonPackageRow,
  parseNonStoreEmoticonRow
} from '../shared/emoticon'
import type { Wcdb4Client } from './wcdb4-client'

/** 表情目录只读服务：emoticon.db。 */
export class EmoticonCatalogService {
  constructor(private readonly wcdb4Client: Wcdb4Client) {}

  async listItems(limit = 200): Promise<ParsedContent[]> {
    const rows = await this.wcdb4Client.listNonStoreEmoticons(limit)
    return rows.map((row) => emoticonItemToContent(parseNonStoreEmoticonRow(row)) as ParsedContent)
  }

  async listExportMessages(limit = 200): Promise<Message[]> {
    const rows = await this.wcdb4Client.listNonStoreEmoticons(limit)
    return rows.map((row, index) => {
      const item = parseNonStoreEmoticonRow(row)
      const contentData = emoticonItemToContent(item) as ParsedContent
      // HTML 导出直接可预览：优先缩略图 URL；本地复制走 sticker 解析链。
      const previewUrl = item.thumbUrl || item.cdnUrl || item.encryptUrl
      return {
        id: `emo-${item.md5 || index}`,
        from: 'emoticon',
        type: '表情包',
        datetime: '',
        content: emoticonDisplayText(item),
        isSender: false,
        createTime: 0,
        name: '表情包',
        contentData,
        exportMediaType: 'sticker' as const,
        exportMediaName: item.caption || item.md5 || 'sticker',
        exportMediaUrl: previewUrl
      } as Message
    })
  }

  async searchHits(query: string, limit = 20): Promise<Array<{ text: string; timestamp?: number }>> {
    const needle = String(query || '').trim().toLowerCase()
    if (!needle) return []
    const rows = await this.wcdb4Client.listNonStoreEmoticons(500)
    return rows
      .map((row) => ({ text: emoticonDisplayText(parseNonStoreEmoticonRow(row)) }))
      .filter((hit) => hit.text.toLowerCase().includes(needle))
      .slice(0, limit)
  }

  async listPackages(): Promise<string[]> {
    const rows = await this.wcdb4Client.listEmoticonPackages(100)
    return rows
      .map((row) => parseEmoticonPackageRow(row).packageName || '')
      .filter(Boolean)
  }
}
