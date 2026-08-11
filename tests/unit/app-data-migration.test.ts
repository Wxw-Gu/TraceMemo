import fs from 'fs-extra'
import { DatabaseSync } from 'node:sqlite'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  paths: new Map<string, string>([
    ['appData', '/tmp/tracememo-migration-test-app-data'],
    ['temp', '/tmp'],
    ['home', '/tmp']
  ]),
  name: ''
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    setName: (name: string) => {
      electronState.name = name
    },
    getPath: (name: string) => electronState.paths.get(name) || '/tmp',
    setPath: (name: string, value: string) => electronState.paths.set(name, value)
  },
  dialog: { showMessageBox: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString('utf8')
  }
}))

import { assessMigration, executeMigration } from '../../src/main/app-data-migration'
import { getUserDataRoots } from '../../src/main/app-data-paths'

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracememo-migration-'))
})

afterEach(() => {
  fs.removeSync(root)
})

function roots() {
  return getUserDataRoots(path.join(root, 'Application Support'))
}

function writeFixture(filePath: string, content = 'fixture'): void {
  fs.ensureDirSync(path.dirname(filePath))
  fs.writeFileSync(filePath, content)
}

describe('TraceMemo app data migration', () => {
  it('treats a new TraceMemo install as clean when no legacy directory exists', () => {
    const assessment = assessMigration(roots())
    expect(assessment).toMatchObject({
      shouldPrompt: false,
      reason: 'clean-install',
      currentHasAssets: false
    })
    expect(assessment.selection.selected).toBe(roots().current)
  })

  it('ignores an empty WechatExplorer legacy directory', () => {
    const fixture = roots()
    fs.ensureDirSync(fixture.legacy)
    expect(assessMigration(fixture)).toMatchObject({
      shouldPrompt: false,
      reason: 'legacy-empty'
    })
  })

  it('detects legacy settings but never proposes overwriting valid TraceMemo data', () => {
    const fixture = roots()
    writeFixture(path.join(fixture.legacy, 'settings.json'), '{"dbRoot":"legacy"}')
    expect(assessMigration(fixture)).toMatchObject({
      shouldPrompt: true,
      reason: 'legacy-assets-detected',
      sourceRoot: fixture.legacy
    })

    writeFixture(path.join(fixture.current, 'settings.json'), '{"dbRoot":"current"}')
    expect(assessMigration(fixture)).toMatchObject({
      shouldPrompt: false,
      reason: 'current-data-present'
    })
  })

  it('copies Settings, Knowledge companions, Token, Provider keys and Agent credentials', async () => {
    const fixture = roots()
    const source = fixture.legacy
    const target = fixture.current
    writeFixture(path.join(source, 'settings.json'), '{"dbRoot":"legacy-db"}')
    writeFixture(path.join(source, 'ai-providers.json'), '{"version":1,"providers":[]}')
    writeFixture(path.join(source, 'local-api-token.bin'), 'legacy-encrypted-token')
    writeFixture(path.join(source, 'ai-provider-keys.bin'), 'legacy-encrypted-provider')

    const knowledgeDirectory = path.join(source, 'knowledge', 'account-hash')
    fs.ensureDirSync(knowledgeDirectory)
    const knowledgePath = path.join(knowledgeDirectory, 'knowledge.sqlite')
    const database = new DatabaseSync(knowledgePath)
    database.exec('PRAGMA journal_mode=WAL')
    database.exec('PRAGMA wal_autocheckpoint=0')
    database.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT NOT NULL)')
    database.exec("INSERT INTO messages(text) VALUES ('migration fixture')")
    expect(fs.existsSync(`${knowledgePath}-wal`)).toBe(true)
    expect(fs.existsSync(`${knowledgePath}-shm`)).toBe(true)

    const agentLegacy = path.join(root, 'home', '.wechatexplorer', 'accounts')
    const agentCurrent = path.join(root, 'home', '.tracememo', 'accounts')
    writeFixture(path.join(agentLegacy, 'account.json'), '{"token":"credential"}')
    writeFixture(path.join(agentLegacy, 'account.sync.json'), '{"cursor":"1"}')

    try {
      const result = await executeMigration(source, target, {
        decryptLegacySecrets: async () => ({
          token: 'A'.repeat(43),
          aiProviderKeys: { version: 1, keys: { provider: 'provider-secret' } },
          databaseKeys: {},
          failures: []
        }),
        agentRoots: () => ({ legacy: agentLegacy, current: agentCurrent }),
        now: () => new Date('2026-08-11T00:00:00.000Z')
      })

      expect(result.state.status).toBe('completed')
      expect(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')).toContain('legacy-db')
      expect(
        fs.existsSync(path.join(target, 'knowledge', 'account-hash', 'knowledge.sqlite'))
      ).toBe(true)
      expect(
        fs.existsSync(path.join(target, 'knowledge', 'account-hash', 'knowledge.sqlite-wal'))
      ).toBe(true)
      expect(
        fs.existsSync(path.join(target, 'knowledge', 'account-hash', 'knowledge.sqlite-shm'))
      ).toBe(true)
      expect(
        Buffer.from(fs.readFileSync(path.join(target, 'local-api-token.bin')))
          .reverse()
          .toString('utf8')
      ).toBe('A'.repeat(43))
      expect(
        JSON.parse(
          Buffer.from(fs.readFileSync(path.join(target, 'ai-provider-keys.bin')))
            .reverse()
            .toString('utf8')
        )
      ).toEqual({ version: 1, keys: { provider: 'provider-secret' } })
      expect(fs.readFileSync(path.join(agentCurrent, 'account.json'), 'utf8')).toContain(
        'credential'
      )
      expect(fs.existsSync(path.join(source, 'settings.json'))).toBe(true)
      expect(
        fs.existsSync(path.join(source, 'knowledge', 'account-hash', 'knowledge.sqlite'))
      ).toBe(true)
    } finally {
      database.close()
    }
  })

  it('is idempotent and does not overwrite existing TraceMemo assets', async () => {
    const fixture = roots()
    writeFixture(path.join(fixture.legacy, 'settings.json'), '{"dbRoot":"legacy"}')
    writeFixture(path.join(fixture.current, 'settings.json'), '{"dbRoot":"current"}')

    const result = await executeMigration(fixture.legacy, fixture.current, {
      decryptLegacySecrets: async () => ({ databaseKeys: {}, failures: [] }),
      agentRoots: () => ({
        legacy: path.join(root, 'agent-legacy'),
        current: path.join(root, 'agent-current')
      }),
      now: () => new Date('2026-08-11T00:00:00.000Z')
    })

    expect(result.state.items['settings.json']).toBe('skipped')
    expect(fs.readFileSync(path.join(fixture.current, 'settings.json'), 'utf8')).toContain(
      'current'
    )
    expect(fs.readFileSync(path.join(fixture.legacy, 'settings.json'), 'utf8')).toContain('legacy')
  })
})
