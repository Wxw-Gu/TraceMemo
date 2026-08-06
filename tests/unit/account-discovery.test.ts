import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  userData: `${process.env.TEMP || process.env.TMP || '.'}/wxe-account-discovery-tests`
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocked.userData }
}))

import { discoverAccounts } from '../../src/main/services/account-discovery'
import {
  accountDirectoryBelongsToIdentity,
  deriveAccountWxid
} from '../../src/main/services/local-account-identity'

const ENCRYPTED_PROFILE_FIXTURE =
  'AQAAAO94jcgf4UG6tCOnxpkapWihufN03upWNEXBfttmtsNHGfPwTv6d4rHJ5BQ9fTQWVc8QuHn1cCk1TmQ4eYW4iHKHEGgyGn/3mcpxlJIxlkt/y7IFifofGw8UShRYcOa8j59W2EML986dq+OWo/cN19iq3PHiMhbDLugGiWYdeDMAIPI/'

describe('account discovery', () => {
  let root: string
  const keyStore = {
    getStatus: vi.fn(async (accountRoot: string) => ({
      saved: accountRoot.endsWith('account-b'),
      encryptionAvailable: true
    }))
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxe-accounts-'))
    await Promise.all(
      ['account-a', 'account-b', 'account-c'].map((name) =>
        fs.ensureDir(path.join(root, name, 'db_storage'))
      )
    )
    await fs.ensureDir(path.join(root, 'Backup'))
  })

  afterEach(async () => {
    await fs.remove(root)
    await fs.remove(mocked.userData)
  })

  it('rejects an invalid Backup directory without continuing', async () => {
    const result = await discoverAccounts(path.join(root, 'Backup'), keyStore as never)
    expect(result.success).toBe(false)
    expect(result.accounts).toEqual([])
  })

  it('lists every direct account and never preselects one from a root directory', async () => {
    const result = await discoverAccounts(root, keyStore as never)
    expect(result.success).toBe(true)
    expect(result.accounts.map((account) => account.directoryName).sort()).toEqual([
      'account-a',
      'account-b',
      'account-c'
    ])
    expect(result.preselectedAccountId).toBeUndefined()
    expect(
      result.accounts.find((account) => account.directoryName === 'account-b')?.hasSavedDbKey
    ).toBe(true)
  })

  it('preselects a directly selected account directory while retaining its card', async () => {
    const accountRoot = path.join(root, 'account-c')
    const result = await discoverAccounts(accountRoot, keyStore as never)
    expect(result.success).toBe(true)
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0].accountRoot).toBe(accountRoot)
    expect(result.preselectedAccountId).toBe(result.accounts[0].id)
    expect(result.accounts[0].selectedByInput).toBe(true)
  })

  it('adds the local profile only to its exact account directory before unlock', async () => {
    const accountRoot = path.join(root, 'fixture_account_ab12')
    await fs.ensureDir(path.join(accountRoot, 'db_storage'))
    const profileFile = path.join(root, 'all_users', 'config', 'global_config')
    await fs.ensureDir(path.dirname(profileFile))
    await fs.writeFile(profileFile, Buffer.from(ENCRYPTED_PROFILE_FIXTURE, 'base64'))

    const result = await discoverAccounts(root, keyStore as never)

    expect(
      result.accounts.find((account) => account.directoryName === 'fixture_account_ab12')
    ).toMatchObject({
      wxid: 'fixture_account',
      nickname: '测试账号',
      avatar: 'https://wx.qlogo.cn/fixture/avatar'
    })
    expect(result.accounts.find((account) => account.directoryName === 'account-a')).toMatchObject({
      wxid: undefined,
      nickname: undefined,
      avatar: undefined
    })

    const directResult = await discoverAccounts(accountRoot, keyStore as never)
    expect(directResult.accounts[0]).toMatchObject({
      wxid: 'fixture_account',
      nickname: '测试账号'
    })
  })

  it('uses strict account-directory suffix matching', () => {
    expect(accountDirectoryBelongsToIdentity('fixture_account', 'fixture_account')).toBe(true)
    expect(accountDirectoryBelongsToIdentity('fixture_account_ab12', 'fixture_account')).toBe(true)
    expect(accountDirectoryBelongsToIdentity('fixture_account_z9q2', 'fixture_account')).toBe(true)
    expect(accountDirectoryBelongsToIdentity('fixture_account_other', 'fixture_account')).toBe(
      false
    )
    expect(accountDirectoryBelongsToIdentity('fixture_account2_ab12', 'fixture_account')).toBe(
      false
    )
    expect(deriveAccountWxid('wxid_fixtureaccount_00fa')).toBe('wxid_fixtureaccount')
    expect(deriveAccountWxid('fixture_account_1a2b')).toBe('fixture_account')
    expect(deriveAccountWxid('account-a')).toBeUndefined()
  })
})
