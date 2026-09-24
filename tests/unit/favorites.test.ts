import { describe, expect, it } from 'vitest'
import {
  describeFavoriteType,
  favoriteRecordToContent,
  favoriteRowToContent,
  parseFavItemXml
} from '../../src/shared/favorites'

describe('favorites type map', () => {
  it('labels known MM_FAV names and numeric fallbacks', () => {
    expect(describeFavoriteType('TXT')).toBe('文字')
    expect(describeFavoriteType('IMG')).toBe('图片')
    expect(describeFavoriteType('FINDER_FEED')).toBe('视频号')
    expect(describeFavoriteType(2)).toBe('图片')
    // 真机 fav_db_item.type
    expect(describeFavoriteType(14)).toBe('聊天记录')
    expect(describeFavoriteType(18)).toBe('笔记/图文')
    expect(describeFavoriteType(19)).toBe('小程序')
    expect(describeFavoriteType(20)).toBe('视频号')
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

  it('parses favitem XML from favorite.db content', () => {
    const xml = [
      '<favitem type="1"><ctrlflag>0</ctrlflag><version>0</version>',
      '<desc><![CDATA[收藏文字]]></desc>',
      '<source sourcetype="22"><fromusr>wxid_a</fromusr></source>',
      '</favitem>'
    ].join('')
    expect(parseFavItemXml(xml)).toMatchObject({
      type: '1',
      description: '收藏文字'
    })
    const web = [
      '<favitem type="5"><source><link><![CDATA[https://example.com/a]]></link></source>',
      '<datalist count="1"><dataitem datatype="5"><datatitle><![CDATA[标题]]></datatitle>',
      '<datadesc><![CDATA[摘要]]></datadesc></dataitem></datalist></favitem>'
    ].join('')
    expect(parseFavItemXml(web)).toMatchObject({
      type: '5',
      title: '标题',
      description: '摘要',
      url: 'https://example.com/a'
    })
    expect(
      favoriteRowToContent({
        local_id: 9,
        type: 5,
        content: web
      })
    ).toMatchObject({ type: 'share', title: '标题', typeVal: '5' })
  })
})
