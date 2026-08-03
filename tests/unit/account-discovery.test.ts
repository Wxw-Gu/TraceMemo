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
})
