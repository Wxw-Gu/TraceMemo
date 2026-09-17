import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  accountsDirectory,
  clearCursor,
  legacyAccountsDirectory,
  loadAllCredentials,
  loadContextToken,
  loadCursor,
  normalizeAccountId,
  resolveAccountDirectory,
  saveContextToken,
  saveCredentials,
  saveCursor
} from '../../src/main/services/wechat-ilink/account-store'
import type { ILinkCredentials } from '../../src/main/services/wechat-ilink/types'

const credentials: ILinkCredentials = {
  bot_token: 'bot-token-value',
  ilink_bot_id: 'bot_abc@im.bot',
  baseurl: 'https://ilinkai.weixin.qq.com',
  ilink_user_id: 'user_42'
}

describe('wechat-ilink account store', () => {
  const homes: string[] = []

  afterEach(() => {
    while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
  })

  function createHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'tracememo-ilink-home-'))
    homes.push(home)
    return home
  }

  it('把账号 ID 规范成文件安全的形式', () => {
    expect(normalizeAccountId('bot_abc@im.bot')).toBe('bot_abc-im-bot')
    expect(normalizeAccountId('a:b.c@d')).toBe('a-b-c-d')
    expect(normalizeAccountId('')).toBe('')
  })

  it('凭据写入 ~/.tracememo 且文件权限为 0600', () => {
    const home = createHome()
    const path = saveCredentials(credentials, () => home)

    expect(path).toBe(
      join(home, '.tracememo', 'wechat-connector', 'accounts', 'bot_abc-im-bot.json')
    )
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(loadAllCredentials(() => home)).toEqual([credentials])
  })

  it('当前目录为空时回退读取 ~/.wechatexplorer 历史凭据，且不删除旧文件', () => {
    const home = createHome()
    const legacyDirectory = legacyAccountsDirectory(() => home)
    mkdirSync(legacyDirectory, { recursive: true })
    writeFileSync(join(legacyDirectory, 'legacy-bot.json'), JSON.stringify(credentials), 'utf8')

    expect(loadAllCredentials(() => home)).toEqual([credentials])
    expect(resolveAccountDirectory('legacy-bot', () => home)).toEqual({
      directory: legacyDirectory,
      legacy: true
    })
    expect(existsSync(join(legacyDirectory, 'legacy-bot.json'))).toBe(true)
  })

  it('游标写到 loadCursor 实际读取的目录，历史目录不会让游标失效', () => {
    const home = createHome()
    const legacyDirectory = legacyAccountsDirectory(() => home)
    mkdirSync(legacyDirectory, { recursive: true })
    writeFileSync(join(legacyDirectory, 'legacy-bot.json'), JSON.stringify(credentials), 'utf8')

    saveCursor('legacy-bot', 'buf-1', () => home)

    expect(existsSync(join(legacyDirectory, 'legacy-bot.sync.json'))).toBe(true)
    expect(
      existsSync(
        join(
          accountsDirectory(() => home),
          'legacy-bot.sync.json'
        )
      )
    ).toBe(false)
    expect(loadCursor('legacy-bot', () => home)).toBe('buf-1')
  })

  it('保存新凭据时清理其它账号，但保留同账号的游标与上下文文件', () => {
    const home = createHome()
    saveCredentials(credentials, () => home)
    const accountId = normalizeAccountId(credentials.ilink_bot_id)
    saveCursor(accountId, 'buf-keep', () => home)
    saveContextToken(accountId, 'user@im.wechat', 'ctx-keep', () => home)

    const otherDirectory = accountsDirectory(() => home)
    writeFileSync(join(otherDirectory, 'stale-bot.json'), JSON.stringify(credentials), 'utf8')

    saveCredentials(credentials, () => home)

    expect(existsSync(join(otherDirectory, 'stale-bot.json'))).toBe(false)
    expect(existsSync(join(otherDirectory, `${accountId}.sync.json`))).toBe(true)
    expect(existsSync(join(otherDirectory, `${accountId}.context.json`))).toBe(true)
    expect(loadCursor(accountId, () => home)).toBe('buf-keep')
  })

  it('游标按账号隔离', () => {
    const home = createHome()
    saveCredentials(credentials, () => home)
    const accountA = normalizeAccountId(credentials.ilink_bot_id)
    saveCredentials({ ...credentials, ilink_bot_id: 'bot_other' }, () => home)

    // saveCredentials 只会保留最后一个账号，这里直接验证读取隔离。
    saveCursor(accountA, 'buf-a', () => home)
    saveCursor('bot_other', 'buf-b', () => home)

    expect(loadCursor(accountA, () => home)).toBe('buf-a')
    expect(loadCursor('bot_other', () => home)).toBe('buf-b')
    clearCursor(accountA, () => home)
    expect(loadCursor(accountA, () => home)).toBe('')
    expect(loadCursor('bot_other', () => home)).toBe('buf-b')
  })

  it('按账号 + 用户保存 context_token，文件权限 0600，只保留最近 500 条', () => {
    const home = createHome()
    saveCredentials(credentials, () => home)
    const accountId = normalizeAccountId(credentials.ilink_bot_id)

    for (let index = 0; index < 520; index += 1) {
      saveContextToken(
        accountId,
        `user-${index}`,
        `ctx-${index}`,
        () => home,
        () => index
      )
    }

    const path = join(
      accountsDirectory(() => home),
      `${accountId}.context.json`
    )
    expect(statSync(path).mode & 0o777).toBe(0o600)

    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      tokens: Record<string, { context_token: string }>
    }
    expect(Object.keys(stored.tokens)).toHaveLength(500)
    // 最新的保留，最旧的被裁掉。
    expect(stored.tokens['user-519'].context_token).toBe('ctx-519')
    expect(stored.tokens['user-0']).toBeUndefined()

    expect(loadContextToken(accountId, 'user-519', () => home)).toBe('ctx-519')
    expect(loadContextToken(accountId, 'user-missing', () => home)).toBeUndefined()
  })

  it('忽略缺少 bot_token 的损坏凭据文件', () => {
    const home = createHome()
    const directory = accountsDirectory(() => home)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'broken.json'), '{ not json', 'utf8')
    writeFileSync(join(directory, 'empty.json'), JSON.stringify({ ilink_bot_id: 'x' }), 'utf8')

    expect(loadAllCredentials(() => home)).toEqual([])
  })
})
