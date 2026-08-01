import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMessageContent } from '../src/main/message-parser.ts'
import { classifyStickerHttpFailure } from '../src/shared/sticker.ts'

test('merged forwarding messages expose expandable record items', () => {
  const content = `
    <msg><appmsg><title>项目讨论记录</title><type>19</type>
      <recorditem><![CDATA[
        <recordinfo>
          <dataitem datatype="1">
            <sourcename><![CDATA[张三]]></sourcename>
            <sourcetime>2026-08-01 10:00</sourcetime>
            <datadesc><![CDATA[第一条消息]]></datadesc>
          </dataitem>
          <dataitem datatype="3">
            <sourcename><![CDATA[李四]]></sourcename>
            <sourcetime>2026-08-01 10:01</sourcetime>
          </dataitem>
        </recordinfo>
      ]]></recorditem>
    </appmsg></msg>`

  const parsed = parseMessageContent(content, 49)
  assert.equal(parsed.type, 'forwardBundle')
  assert.equal(parsed.title, '项目讨论记录')
  assert.deepEqual(
    parsed.items.map((item) => [item.sender, item.text]),
    [
      ['张三', '第一条消息'],
      ['李四', '[图片]']
    ]
  )
})

test('unknown message types are not misclassified as text', () => {
  const parsed = parseMessageContent('<unsupported><payload>1</payload></unsupported>', 9999)
  assert.equal(parsed.type, 'unknown')
  assert.equal(parsed.messageType, 9999)
})

test('sticker 403 with expired timestamp is classified as an expired link', () => {
  const result = classifyStickerHttpFailure(
    403,
    'https://example.invalid/sticker?expire=1700000000',
    1_800_000_000_000
  )
  assert.equal(result.code, 'link_expired')
})

test('sticker authorization and removal failures remain distinct', () => {
  assert.equal(
    classifyStickerHttpFailure(401, 'https://example.invalid/sticker').code,
    'authentication_required'
  )
  assert.equal(
    classifyStickerHttpFailure(403, 'https://example.invalid/sticker').code,
    'access_denied'
  )
  assert.equal(
    classifyStickerHttpFailure(404, 'https://example.invalid/sticker').code,
    'resource_removed'
  )
})
