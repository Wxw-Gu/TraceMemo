/**
 * 大会话读取的性能日志与隐私契约。
 *
 * 这一组锁两件事：
 *   1. 大会话必须留下**可归因**的一行（谁读的 / 各阶段耗时 / 行数），
 *      否则"图片索引卡住 10 秒"永远只能靠猜；
 *   2. 那一行里**不能**出现会话 md5 —— 稳定会话标识不进日志。
 *
 * 单独一个文件：`chat-service.test.ts` 里会调用 `closeChatDbForQuit()`，
 * 那会把进程级的关闭标志置上，后续任何 `setChatDb` 都会被拒。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WechatDb } from '../../src/main/wechat-db'
import { listMessagesAsync, setChatDb } from '../../src/main/services/chat-service'

const FIXTURE_MD5 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const makeMessages = (count: number): Array<Record<string, unknown>> =>
  Array.from({ length: count }, (_, index) => ({
    messageType: '1',
    msgCreateTime: String(1_700_000_000 + index),
    mesDes: '0',
    mesLocalID: String(index + 1),
    msgContent: '普通文本',
    sender: 'wxid_fixture',
    serverId: String(index + 1)
  }))

const installDb = (raw: Array<Record<string, unknown>>): void => {
  const fakeDb = {
    close: vi.fn(),
    md5: () => FIXTURE_MD5,
    getWcdb4Client: () => ({
      getUsernameByMd5: () => 'fixture@chatroom',
      resolveEmoticonCdnUrl: () => ''
    }),
    getUserMessagesAsync: vi.fn(async () => raw)
  } as unknown as WechatDb
  setChatDb(fakeDb)
}

const perfLines = (log: ReturnType<typeof vi.spyOn>): string[] =>
  log.mock.calls
    .map((call) => String(call[0] ?? ''))
    .filter((message) => message.startsWith('[ChatServicePerf]'))

describe('chat service listMessages perf log', () => {
  afterEach(() => setChatDb(null))

  it('leaves one attributable line for a large read, without the conversation md5', async () => {
    installDb(makeMessages(20_000))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await listMessagesAsync(
        FIXTURE_MD5,
        undefined,
        undefined,
        undefined,
        undefined,
        'image-text-index'
      )

      const lines = perfLines(log)
      expect(lines).toHaveLength(1)

      const line = lines[0]
      expect(line).toContain('caller=image-text-index')
      expect(line).toContain('rows=20000')
      expect(line).toContain('rawRows=20000')
      // 拆解字段必须齐全，否则"这几秒花在哪"还是答不出来。
      for (const field of [
        'totalMs=',
        'rawReadMs=',
        'formatMs=',
        'dateFormatMs=',
        'contentParseMs=',
        'sortMs=',
        'otherMs='
      ]) {
        expect(line).toContain(field)
      }
      // 隐私：稳定会话标识绝不出现。
      expect(line).not.toContain(FIXTURE_MD5)
      expect(line).not.toContain('md5')
      // 关联用进程内序号（`request-N`），不是稳定标识。
      expect(line).toMatch(/request=request-\d+/)
    } finally {
      log.mockRestore()
    }
  })

  it('stays silent for a small read so normal usage does not spam the log', async () => {
    installDb(makeMessages(10))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await listMessagesAsync(FIXTURE_MD5, undefined, undefined, undefined, undefined, 'knowledge')
      expect(perfLines(log)).toEqual([])
    } finally {
      log.mockRestore()
    }
  })
})
