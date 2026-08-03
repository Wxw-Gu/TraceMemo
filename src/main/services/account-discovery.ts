import crypto from 'crypto'
import fs from 'fs-extra'
import path from 'path'
import type { AccountDiscoveryResult, WechatAccountCandidate } from '../../shared/database-key'
import { DatabaseKeyStore } from '../database-key-store'
import { getBootstrapCache } from './bootstrap-cache'
import { validateDbRoot } from './settings-store'

function accountId(accountRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(accountRoot).toLowerCase()).digest('hex')
}

export async function discoverAccounts(
  inputPath: string,
  keyStore: DatabaseKeyStore,
  currentAccountRoot?: string
): Promise<AccountDiscoveryResult> {
  const validation = validateDbRoot(inputPath)
  if (!validation.valid) return { success: false, accounts: [], error: validation.error }

  const normalizedInput = path.resolve(inputPath)
  const isAccount = await fs.pathExists(path.join(normalizedInput, 'db_storage'))
  const roots = isAccount
    ? [normalizedInput]
    : (await fs.readdir(normalizedInput, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(normalizedInput, entry.name))
        .filter((candidate) => fs.existsSync(path.join(candidate, 'db_storage')))

  const accounts: WechatAccountCandidate[] = await Promise.all(
    roots.map(async (accountRoot) => {
      const cached = getBootstrapCache(accountRoot)?.self
      return {
        id: accountId(accountRoot),
        accountRoot,
        directoryName: path.basename(accountRoot),
        wxid: cached?.wxid,
        nickname: cached?.nickname,
        avatar: cached?.avatar,
        hasSavedDbKey: (await keyStore.getStatus(accountRoot)).saved,
        loginStatus: currentAccountRoot
          ? path.resolve(currentAccountRoot).toLowerCase() ===
            path.resolve(accountRoot).toLowerCase()
            ? 'current'
            : 'other'
          : 'unknown',
        selectedByInput: isAccount
      }
    })
  )

  return {
    success: true,
    inputKind: isAccount ? 'account' : 'root',
    accounts,
    preselectedAccountId: isAccount ? accounts[0]?.id : undefined
  }
}
