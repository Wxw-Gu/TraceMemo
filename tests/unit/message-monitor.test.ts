import { describe, expect, it } from 'vitest'
import {
  isRelevantMessageMonitorEvent,
  parseWcdbMonitorEvent
} from '../../src/renderer/src/utils/message-monitor'

describe('message monitor events', () => {
  it('parses structured native events and normalizes empty fields', () => {
    expect(
      parseWcdbMonitorEvent('{"db":"message_0.db","table":"message","action":"update"}')
    ).toEqual({
      db: 'message_0.db',
      table: 'message',
      action: 'update'
    })
    expect(parseWcdbMonitorEvent('{"table":"  ","action":null}')).toEqual({})
  })

  it('refreshes the active archive for message shard events without a session id', () => {
    expect(
      isRelevantMessageMonitorEvent('{"db":"message_0.db","table":"message","action":"update"}', [
        'group-md5',
        'room@chatroom'
      ])
    ).toBe(true)
    expect(
      isRelevantMessageMonitorEvent(
        '{"db":"/tmp/db_storage/message/Msg_1.db-wal","table":"database"}',
        ['group-md5']
      )
    ).toBe(true)
  })

  it('ignores unrelated session events but keeps legacy action-only compatibility', () => {
    expect(
      isRelevantMessageMonitorEvent('{"db":"session.db","table":"Session"}', [
        'group-md5',
        'room@chatroom'
      ])
    ).toBe(false)
    expect(isRelevantMessageMonitorEvent('{"action":"update"}', ['group-md5'])).toBe(true)
    expect(isRelevantMessageMonitorEvent('not-json', ['group-md5'])).toBe(false)
  })
})
