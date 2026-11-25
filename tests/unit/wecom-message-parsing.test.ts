import { describe, expect, it } from 'vitest'
import { parseMessageContent } from '../../src/main/message-parser'

/** Synthetic payloads only — no real content, keys, or identifiers. */
describe(`enterprise image content parsing`, () => {
  it(`recognizes an aeskey-only enterprise image`, () => {
    const xml = `<img aeskey="fixtureaeskey0000000000000000000" encryver="0" cdnmidimgurl="fixture-url"/>`
    const parsed = parseMessageContent(xml, 3)
    expect(parsed.type).toBe(`image`)
    if (parsed.type === `image`) {
      expect(parsed.md5).toBeUndefined()
      expect(parsed.aeskey).toBe(`fixtureaeskey0000000000000000000`)
    }
  })

  it(`still rejects img content with no identity fields`, () => {
    expect(parseMessageContent('<img/>', 3).type).toBe('unknown')
  })
})
