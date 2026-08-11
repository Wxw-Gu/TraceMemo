import { safeStorage } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import { LEGACY_MIGRATION_RESULT_FD_ENV, LEGACY_MIGRATION_SOURCE_ENV } from './app-data-bootstrap'
import { isValidDatabaseKey } from './database-key-store'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface LegacySecretFailure {
  asset: string
  error: string
}

export interface LegacySecretBundle {
  token?: string
  aiProviderKeys?: { version: 1; keys: Record<string, string> }
  imageKeys?: {
    version: 1
    accounts: Record<string, { xorKey: string; aesKey: string; updatedAt: number }>
  }
  legacyDatabaseKey?: string
  databaseKeys: Record<string, string>
  failures: LegacySecretFailure[]
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string')
  )
}

function decryptFile(filePath: string): string {
  return safeStorage.decryptString(fs.readFileSync(filePath))
}

export function decryptLegacySecrets(sourceRoot: string): LegacySecretBundle {
  const result: LegacySecretBundle = { databaseKeys: {}, failures: [] }
  if (!safeStorage.isEncryptionAvailable()) {
    result.failures.push({ asset: 'safeStorage', error: '系统安全存储不可用' })
    return result
  }

  const readSecret = (
    asset: string,
    relativePath: string,
    apply: (plain: string) => void
  ): void => {
    const filePath = path.join(sourceRoot, relativePath)
    if (!fs.pathExistsSync(filePath)) return
    try {
      apply(decryptFile(filePath))
    } catch {
      result.failures.push({ asset, error: '旧加密数据无法解密或格式无效' })
    }
  }

  readSecret('local-api-token.bin', 'local-api-token.bin', (plain) => {
    if (!TOKEN_PATTERN.test(plain)) throw new Error('invalid token')
    result.token = plain
  })

  readSecret('ai-provider-keys.bin', 'ai-provider-keys.bin', (plain) => {
    const parsed = JSON.parse(plain) as { version?: unknown; keys?: unknown }
    if (parsed.version !== 1 || !isStringRecord(parsed.keys))
      throw new Error('invalid provider keys')
    result.aiProviderKeys = { version: 1, keys: parsed.keys }
  })

  readSecret('wechat-image-keys.bin', 'wechat-image-keys.bin', (plain) => {
    const parsed = JSON.parse(plain) as {
      version?: unknown
      accounts?: Record<string, { xorKey?: unknown; aesKey?: unknown; updatedAt?: unknown }>
    }
    if (
      parsed.version !== 1 ||
      !parsed.accounts ||
      Object.values(parsed.accounts).some(
        (entry) =>
          !entry ||
          typeof entry.xorKey !== 'string' ||
          typeof entry.aesKey !== 'string' ||
          typeof entry.updatedAt !== 'number'
      )
    ) {
      throw new Error('invalid image keys')
    }
    result.imageKeys = {
      version: 1,
      accounts: parsed.accounts as NonNullable<LegacySecretBundle['imageKeys']>['accounts']
    }
  })

  readSecret('wechat-db-key.bin', 'wechat-db-key.bin', (plain) => {
    if (!isValidDatabaseKey(plain)) throw new Error('invalid legacy database key')
    result.legacyDatabaseKey = plain.trim().replace(/^0x/i, '')
  })

  const databaseKeysRoot = path.join(sourceRoot, 'database-keys')
  if (fs.pathExistsSync(databaseKeysRoot)) {
    for (const entry of fs.readdirSync(databaseKeysRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.bin')) continue
      readSecret(`database-keys/${entry.name}`, path.join('database-keys', entry.name), (plain) => {
        if (!isValidDatabaseKey(plain)) throw new Error('invalid database key')
        result.databaseKeys[entry.name] = plain.trim().replace(/^0x/i, '')
      })
    }
  }

  return result
}

export function writeLegacySecretHelperResult(result: LegacySecretBundle): void {
  const fd = Number(process.env[LEGACY_MIGRATION_RESULT_FD_ENV] || '3')
  if (!Number.isInteger(fd) || fd < 3) throw new Error('invalid migration result pipe')
  fs.writeFileSync(fd, JSON.stringify(result), 'utf8')
}

export function runLegacySafeStorageHelper(): void {
  const sourceRoot = process.env[LEGACY_MIGRATION_SOURCE_ENV]?.trim()
  if (!sourceRoot) throw new Error('legacy migration source is missing')
  writeLegacySecretHelperResult(decryptLegacySecrets(path.resolve(sourceRoot)))
}
