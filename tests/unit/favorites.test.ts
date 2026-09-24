import { describe, expect, it } from 'vitest'
import { describeFavoriteType, favoriteRecordToContent } from '../../src/shared/favorites'

describe('favorites type map', () => {
  it('labels known MM_FAV names and numeric fallbacks', () => {
    expect(describeFavoriteType('TXT')).toBe('文字')
    expect(describeFavoriteType('IMG')).toBe('图片')
    expect(describeFavoriteType('FINDER_FEED')).toBe('视频号')
    expect(describeFavoriteType(2)).toBe('图片')
    expect(describeFavoriteType('99-custom')).toBe('99-custom')
    expect(describeFavoriteType(undefined)).toBeUndefined()
  })

  it('maps favorite records onto existing message cards', () => {
    expect(
      favoriteRecordToContent({ type: 'TXT', description: '收藏的文字' })
    ).toEqual({ type: 'text', content: '收藏的文字' })
    expect(favoriteRecordToContent({ type: 'IMG', md5: 'ab'.repeat(16) })).toMatchObject({
      type: 'image',
      md5: 'ab'.repeat(16)
    })
    expect(favoriteRecordToContent({ type: 'VOICE', duration: 3 })).toEqual({
      type: 'voice',
      duration: 3
    })
    expect(
      favoriteRecordToContent({
        type: 'WEBPAGE',
        title: '文章',
        description: '摘要',
        url: 'https://example.com',
        appName: '公众号'
      })
    ).toMatchObject({
      type: 'share',
      title: '文章',
      des: '摘要',
      url: 'https://example.com',
      appname: '公众号',
      typeVal: 'webpage'
    })
    expect(
      favoriteRecordToContent({ type: 'LOC', poiname: '公园', lat: 1.5, lng: 2.5 })
    ).toMatchObject({
      type: 'location',
      poiname: '公园',
      lat: 1.5,
      lng: 2.5
    })
    expect(favoriteRecordToContent({ type: 'NOTE', title: '笔记' })).toMatchObject({
      type: 'share',
      typeVal: 'note'
    })
  })
})
