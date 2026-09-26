import { describe, expect, it } from 'vitest'
import {
  emoticonDisplayText,
  emoticonItemToContent,
  parseEmoticonPackageRow,
  parseNonStoreEmoticonRow
} from '../../src/shared/emoticon'
import { EmoticonCatalogService } from '../../src/main/emoticon-catalog-service'

describe('emoticon catalog parse', () => {
  it('maps non-store rows to sticker content', () => {
    const item = parseNonStoreEmoticonRow({
      type: 3,
      md5: 'ab'.repeat(16),
      caption: '笑哭',
      cdn_url: 'https://cdn.example/a',
      thumb_url: 'https://cdn.example/t',
      encrypt_url: 'https://cdn.example/e'
    })
    expect(item).toMatchObject({ md5: 'ab'.repeat(16), caption: '笑哭' })
    expect(emoticonItemToContent(item)).toMatchObject({
      type: 'sticker',
      md5: 'ab'.repeat(16),
      url: 'https://cdn.example/a'
    })
    expect(emoticonDisplayText(item)).toBe('笑哭')
    expect(parseEmoticonPackageRow({ package_name_: '绝望小人8动态版' })).toMatchObject({
      packageName: '绝望小人8动态版'
    })
  })

  it('sets sticker preview fields on export messages', async () => {
    const service = new EmoticonCatalogService({
      listNonStoreEmoticons: async () => [
        {
          type: 3,
          md5: 'cd'.repeat(16),
          caption: '你好',
          thumb_url: 'https://cdn.example/t2',
          cdn_url: 'https://cdn.example/c2'
        }
      ]
    } as never)
    const [message] = await service.listExportMessages(1)
    expect(message.exportMediaType).toBe('sticker')
    expect(message.exportMediaUrl).toBe('https://cdn.example/t2')
    expect(message.exportMediaName).toBe('你好')
    expect(message.contentData).toMatchObject({ type: 'sticker', md5: 'cd'.repeat(16) })
  })
})
