import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { spawn } from 'child_process'
import { constants as fsConstants } from 'fs'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  LEGACY_MIGRATION_HELPER_ENV,
  LEGACY_MIGRATION_RESULT_FD_ENV,
  LEGACY_MIGRATION_SOURCE_ENV,
  LEGACY_MIGRATION_USER_DATA_ENV
} from './app-data-bootstrap'
import {
  hasValidUserAssets,
  selectUserDataRoot,
  type UserDataRoots,
  type UserDataSelection
} from './app-data-paths'
import type { LegacySecretBundle } from './legacy-safe-storage-helper'

const MIGRATION_STATE_FILE = 'tracememo-migration-v1.json'
const TOKEN_MIGRATION_BLOCK_MESSAGE =
  '检测到旧版 API Token 尚未完成迁移。请重试数据迁移，或在 API Center 主动重新生成 Token。'

const FILE_ASSETS = [
  'settings.json',
  'ai-providers.json',
  'image-insights.json',
  'group-exit-monitor.json'
] as const

const DIRECTORY_ASSETS = [
  'knowledge',
  'reports',
  'recall-archive',
  'Local Storage',
  'digital-twin',
  'group-exit-monitor'
] as const

export type MigrationItemStatus = 'migrated' | 'skipped' | 'missing' | 'failed'
export type MigrationStatus = 'deferred' | 'in-progress' | 'partial' | 'completed'

export interface MigrationState {
  version: 1
  status: MigrationStatus
  sourceRoot: string
  updatedAt: string
  items: Record<string, MigrationItemStatus>
  secretFailures: string[]
}

export interface MigrationAssessment {
  selection: UserDataSelection
  sourceRoot?: string
  currentHasAssets: boolean
  state?: MigrationState
  shouldPrompt: boolean
  reason:
    | 'clean-install'
    | 'legacy-empty'
    | 'current-data-present'
    | 'migration-completed'
    | 'legacy-assets-detected'
    | 'migration-resumable'
}

export interface MigrationExecutionResult {
  state: MigrationState
  tokenGenerationBlocked: boolean
  tokenBlockReason?: string
}

export interface MigrationFlowResult {
  assessment: MigrationAssessment
  action: 'none' | 'deferred' | 'migrated'
  execution?: MigrationExecutionResult
  tokenGenerationBlocked: boolean
  tokenBlockReason?: string
}

export interface MigrationDependencies {
  decryptLegacySecrets: (sourceRoot: string) => Promise<LegacySecretBundle>
  agentRoots: () => { legacy: string; current: string }
  now: () => Date
  onProgress?: (message: string) => void
}

function migrationStatePath(targetRoot: string): string {
  return path.join(targetRoot, MIGRATION_STATE_FILE)
}

function readMigrationState(targetRoot: string): MigrationState | undefined {
  try {
    const state = fs.readJsonSync(migrationStatePath(targetRoot)) as MigrationState
    if (
      state.version !== 1 ||
      !['deferred', 'in-progress', 'partial', 'completed'].includes(state.status) ||
      typeof state.sourceRoot !== 'string'
    ) {
      return undefined
    }
    return state
  } catch {
    return undefined
  }
}

async function writeMigrationState(targetRoot: string, state: MigrationState): Promise<void> {
  await fs.ensureDir(targetRoot)
  const statePath = migrationStatePath(targetRoot)
  const tempPath = `${statePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await fs.writeJson(tempPath, state, { spaces: 2, mode: 0o600 })
    await fs.chmod(tempPath, 0o600)
    await fs.move(tempPath, statePath, { overwrite: true })
  } finally {
    await fs.remove(tempPath).catch(() => undefined)
  }
}

function isLegacySelection(selection: UserDataSelection): boolean {
  return selection.selectedKind === 'legacy-display' || selection.selectedKind === 'legacy-package'
}

export function assessMigration(roots: UserDataRoots): MigrationAssessment {
  const selection = selectUserDataRoot(roots)
  const state = readMigrationState(roots.current)
  const selectedLegacyRoot = isLegacySelection(selection) ? selection.selected : undefined
  const stateSource = state?.sourceRoot
  const resumableStateSource =
    stateSource &&
    [roots.legacy, roots.legacyPackage].includes(stateSource) &&
    hasValidUserAssets(stateSource)
      ? stateSource
      : undefined
  const sourceRoot = resumableStateSource || selectedLegacyRoot
  const currentHasAssets = hasValidUserAssets(roots.current)

  if (state?.status === 'completed') {
    return {
      selection,
      sourceRoot,
      currentHasAssets,
      state,
      shouldPrompt: false,
      reason: 'migration-completed'
    }
  }
  if (sourceRoot && state && ['deferred', 'in-progress', 'partial'].includes(state.status)) {
    return {
      selection,
      sourceRoot,
      currentHasAssets,
      state,
      shouldPrompt: true,
      reason: 'migration-resumable'
    }
  }
  if (!sourceRoot) {
    return {
      selection,
      currentHasAssets,
      state,
      shouldPrompt: false,
      reason:
        selection.directories.legacy || selection.directories.legacyPackage
          ? 'legacy-empty'
          : 'clean-install'
    }
  }
  if (currentHasAssets) {
    return {
      selection,
      sourceRoot,
      currentHasAssets,
      state,
      shouldPrompt: false,
      reason: 'current-data-present'
    }
  }
  return {
    selection,
    sourceRoot,
    currentHasAssets,
    state,
    shouldPrompt: true,
    reason: 'legacy-assets-detected'
  }
}

async function copyFileWithoutOverwrite(
  sourceRoot: string,
  targetRoot: string,
  relativePath: string,
  stagingRoot: string
): Promise<MigrationItemStatus> {
  const sourcePath = path.join(sourceRoot, relativePath)
  const targetPath = path.join(targetRoot, relativePath)
  if (!(await fs.pathExists(sourcePath))) return 'missing'
  if (await fs.pathExists(targetPath)) return 'skipped'
  const stagedPath = path.join(stagingRoot, relativePath)
  await fs.ensureDir(path.dirname(stagedPath))
  await fs.copy(sourcePath, stagedPath, {
    overwrite: false,
    errorOnExist: true,
    preserveTimestamps: true
  })
  if (await fs.pathExists(targetPath)) return 'skipped'
  await fs.ensureDir(path.dirname(targetPath))
  await fs.move(stagedPath, targetPath, { overwrite: false })
  return 'migrated'
}

async function integrityCheckKnowledgeDatabase(databasePath: string): Promise<void> {
  const script = `
const { DatabaseSync } = require('node:sqlite')
const database = new DatabaseSync(process.argv[1], { readOnly: true })
try {
  const rows = database.prepare('PRAGMA integrity_check').all()
  const result = String(rows[0]?.integrity_check || rows[0]?.['integrity_check(1)'] || '').toLowerCase()
  if (rows.length !== 1 || result !== 'ok') process.exitCode = 2
} finally {
  database.close()
}
`
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, databasePath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Knowledge SQLite integrity_check failed (${code}): ${stderr.trim()}`))
    })
  })
}

async function verifyKnowledgeCopy(sourcePath: string, stagedPath: string): Promise<void> {
  const accounts = await fs.readdir(sourcePath, { withFileTypes: true })
  for (const account of accounts) {
    if (!account.isDirectory()) continue
    const sourceDatabase = path.join(sourcePath, account.name, 'knowledge.sqlite')
    if (!(await fs.pathExists(sourceDatabase))) continue
    const stagedDatabase = path.join(stagedPath, account.name, 'knowledge.sqlite')
    if (!(await fs.pathExists(stagedDatabase)))
      throw new Error('Knowledge database copy is missing')
    for (const suffix of ['', '-wal', '-shm']) {
      const sourceFile = `${sourceDatabase}${suffix}`
      if (!(await fs.pathExists(sourceFile))) continue
      const stagedFile = `${stagedDatabase}${suffix}`
      if (!(await fs.pathExists(stagedFile)))
        throw new Error(`Knowledge companion missing: ${suffix}`)
      const [sourceStat, stagedStat] = await Promise.all([fs.stat(sourceFile), fs.stat(stagedFile)])
      if (sourceStat.size !== stagedStat.size)
        throw new Error(`Knowledge copy size mismatch: ${suffix}`)
    }
    await integrityCheckKnowledgeDatabase(stagedDatabase)
  }
}

async function copyDirectoryWithoutOverwrite(
  sourceRoot: string,
  targetRoot: string,
  relativePath: string,
  stagingRoot: string
): Promise<MigrationItemStatus> {
  const sourcePath = path.join(sourceRoot, relativePath)
  const targetPath = path.join(targetRoot, relativePath)
  if (!(await fs.pathExists(sourcePath))) return 'missing'
  if (await fs.pathExists(targetPath)) return 'skipped'
  const stagedPath = path.join(stagingRoot, relativePath)
  await fs.ensureDir(path.dirname(stagedPath))
  await fs.copy(sourcePath, stagedPath, {
    overwrite: false,
    errorOnExist: true,
    preserveTimestamps: true
  })
  if (relativePath === 'knowledge') await verifyKnowledgeCopy(sourcePath, stagedPath)
  if (await fs.pathExists(targetPath)) return 'skipped'
  await fs.move(stagedPath, targetPath, { overwrite: false })
  return 'migrated'
}

async function writeEncryptedWithoutOverwrite(
  targetRoot: string,
  relativePath: string,
  plainText: string
): Promise<MigrationItemStatus> {
  const targetPath = path.join(targetRoot, relativePath)
  if (await fs.pathExists(targetPath)) return 'skipped'
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await fs.ensureDir(path.dirname(targetPath))
    await fs.writeFile(tempPath, safeStorage.encryptString(plainText), { mode: 0o600 })
    await fs.chmod(tempPath, 0o600)
    if (await fs.pathExists(targetPath)) return 'skipped'
    await fs.move(tempPath, targetPath, { overwrite: false })
    return 'migrated'
  } finally {
    await fs.remove(tempPath).catch(() => undefined)
  }
}

async function copyMissingTree(
  sourceRoot: string,
  targetRoot: string
): Promise<MigrationItemStatus> {
  if (!(await fs.pathExists(sourceRoot))) return 'missing'
  let copied = false
  const visit = async (sourceDirectory: string, targetDirectory: string): Promise<void> => {
    await fs.ensureDir(targetDirectory)
    for (const entry of await fs.readdir(sourceDirectory, { withFileTypes: true })) {
      const sourcePath = path.join(sourceDirectory, entry.name)
      const targetPath = path.join(targetDirectory, entry.name)
      if (entry.isDirectory()) {
        await visit(sourcePath, targetPath)
      } else if (entry.isFile() && !(await fs.pathExists(targetPath))) {
        await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL)
        const stat = await fs.stat(sourcePath)
        await fs.chmod(targetPath, stat.mode & 0o777)
        copied = true
      }
    }
  }
  await visit(sourceRoot, targetRoot)
  return copied ? 'migrated' : 'skipped'
}

export function getAgentCredentialRoots(homePath = os.homedir()): {
  legacy: string
  current: string
} {
  return {
    legacy: path.join(homePath, '.wechatexplorer', 'wechat-connector', 'accounts'),
    current: path.join(homePath, '.tracememo', 'wechat-connector', 'accounts')
  }
}

async function hasEncryptedLegacyAssets(sourceRoot: string): Promise<boolean> {
  for (const relativePath of [
    'local-api-token.bin',
    'ai-provider-keys.bin',
    'wechat-image-keys.bin',
    'wechat-db-key.bin'
  ]) {
    if (await fs.pathExists(path.join(sourceRoot, relativePath))) return true
  }
  const databaseKeyRoot = path.join(sourceRoot, 'database-keys')
  if (!(await fs.pathExists(databaseKeyRoot))) return false
  return (await fs.readdir(databaseKeyRoot, { withFileTypes: true })).some(
    (entry) => entry.isFile() && entry.name.endsWith('.bin')
  )
}

export async function runLegacySecretHelper(sourceRoot: string): Promise<LegacySecretBundle> {
  const helperUserData = await fs.mkdtemp(
    path.join(app.getPath('temp'), 'tracememo-legacy-safe-storage-')
  )
  const helperArgs = app.isPackaged ? [] : process.argv.slice(1)
  try {
    return await new Promise<LegacySecretBundle>((resolve, reject) => {
      const child = spawn(process.execPath, helperArgs, {
        env: {
          ...process.env,
          [LEGACY_MIGRATION_HELPER_ENV]: '1',
          [LEGACY_MIGRATION_SOURCE_ENV]: sourceRoot,
          [LEGACY_MIGRATION_USER_DATA_ENV]: helperUserData,
          [LEGACY_MIGRATION_RESULT_FD_ENV]: '3'
        },
        stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      const chunks: Buffer[] = []
      let totalBytes = 0
      let settled = false
      const finish = (error?: Error, value?: LegacySecretBundle): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve(value!)
      }
      const resultPipe = child.stdio[3]
      resultPipe?.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (totalBytes > 5 * 1024 * 1024) {
          child.kill()
          finish(new Error('legacy secret helper result is too large'))
          return
        }
        chunks.push(chunk)
      })
      child.once('error', (error) => finish(error))
      child.once('exit', (code) => {
        if (code !== 0) {
          finish(new Error(`legacy secret helper exited with code ${code}`))
          return
        }
        try {
          finish(
            undefined,
            JSON.parse(Buffer.concat(chunks).toString('utf8')) as LegacySecretBundle
          )
        } catch {
          finish(new Error('legacy secret helper returned invalid data'))
        }
      })
      const timeout = setTimeout(() => {
        child.kill()
        finish(new Error('legacy secret helper timed out'))
      }, 30_000)
    })
  } finally {
    await fs.remove(helperUserData).catch(() => undefined)
  }
}

export async function executeMigration(
  sourceRoot: string,
  targetRoot: string,
  dependencies: MigrationDependencies = {
    decryptLegacySecrets: runLegacySecretHelper,
    agentRoots: () => getAgentCredentialRoots(),
    now: () => new Date()
  }
): Promise<MigrationExecutionResult> {
  const items: Record<string, MigrationItemStatus> = {}
  const secretFailures: string[] = []
  const timestamp = (): string => dependencies.now().toISOString()
  const state: MigrationState = {
    version: 1,
    status: 'in-progress',
    sourceRoot,
    updatedAt: timestamp(),
    items,
    secretFailures
  }
  await writeMigrationState(targetRoot, state)
  const stagingRoot = path.join(targetRoot, '.tracememo-migration-staging-v1')
  await fs.remove(stagingRoot).catch(() => undefined)

  const runItem = async (name: string, task: () => Promise<MigrationItemStatus>): Promise<void> => {
    dependencies.onProgress?.(
      name === 'knowledge' ? '正在安全迁移 Knowledge，数据较大时需要几分钟…' : `正在迁移 ${name}…`
    )
    try {
      items[name] = await task()
    } catch {
      items[name] = 'failed'
    }
    state.updatedAt = timestamp()
    await writeMigrationState(targetRoot, state)
  }

  try {
    for (const relativePath of FILE_ASSETS) {
      await runItem(relativePath, () =>
        copyFileWithoutOverwrite(sourceRoot, targetRoot, relativePath, stagingRoot)
      )
    }
    for (const relativePath of DIRECTORY_ASSETS) {
      await runItem(relativePath, () =>
        copyDirectoryWithoutOverwrite(sourceRoot, targetRoot, relativePath, stagingRoot)
      )
    }

    const agentRoots = dependencies.agentRoots()
    await runItem('agent-credentials', () => copyMissingTree(agentRoots.legacy, agentRoots.current))

    let secrets: LegacySecretBundle = { databaseKeys: {}, failures: [] }
    if (await hasEncryptedLegacyAssets(sourceRoot)) {
      try {
        secrets = await dependencies.decryptLegacySecrets(sourceRoot)
        secretFailures.push(...secrets.failures.map((failure) => failure.asset))
      } catch {
        secretFailures.push('safeStorage-helper')
      }
    }

    const migrateSecret = async (
      relativePath: string,
      plainText: string | undefined
    ): Promise<void> => {
      const sourceExists = await fs.pathExists(path.join(sourceRoot, relativePath))
      if (!sourceExists) {
        items[relativePath] = 'missing'
        return
      }
      if (plainText === undefined) {
        items[relativePath] = 'failed'
        if (!secretFailures.includes(relativePath)) secretFailures.push(relativePath)
        return
      }
      await runItem(relativePath, () =>
        writeEncryptedWithoutOverwrite(targetRoot, relativePath, plainText)
      )
    }

    await migrateSecret('local-api-token.bin', secrets.token)
    await migrateSecret(
      'ai-provider-keys.bin',
      secrets.aiProviderKeys ? JSON.stringify(secrets.aiProviderKeys) : undefined
    )
    await migrateSecret(
      'wechat-image-keys.bin',
      secrets.imageKeys ? JSON.stringify(secrets.imageKeys) : undefined
    )
    await migrateSecret('wechat-db-key.bin', secrets.legacyDatabaseKey)

    const databaseKeySource = path.join(sourceRoot, 'database-keys')
    if (await fs.pathExists(databaseKeySource)) {
      for (const entry of await fs.readdir(databaseKeySource, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[0-9a-f]{64}\.bin$/i.test(entry.name)) continue
        const relativePath = path.join('database-keys', entry.name)
        await migrateSecret(relativePath, secrets.databaseKeys[entry.name])
      }
    }
  } finally {
    await fs.remove(stagingRoot).catch(() => undefined)
  }

  const failed = Object.values(items).some((status) => status === 'failed')
  state.status = failed || secretFailures.length > 0 ? 'partial' : 'completed'
  state.updatedAt = timestamp()
  state.secretFailures = Array.from(new Set(secretFailures))
  await writeMigrationState(targetRoot, state)
  const tokenGenerationBlocked =
    (await fs.pathExists(path.join(sourceRoot, 'local-api-token.bin'))) &&
    !(await fs.pathExists(path.join(targetRoot, 'local-api-token.bin')))
  return {
    state,
    tokenGenerationBlocked,
    ...(tokenGenerationBlocked ? { tokenBlockReason: TOKEN_MIGRATION_BLOCK_MESSAGE } : {})
  }
}

async function createMigrationProgressWindow(): Promise<BrowserWindow | null> {
  if (process.platform !== 'darwin') return null
  const window = new BrowserWindow({
    width: 460,
    height: 260,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    title: 'TraceMemo 数据迁移',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f5f5f7;color:#202124;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}
main{width:360px}.spinner{width:30px;height:30px;margin:0 auto 20px;border:3px solid #d9dddf;border-top-color:#00796b;border-radius:50%;animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:18px;margin:0 0 12px}p{line-height:1.6;margin:0}.hint{margin-top:14px;color:#697177;font-size:12px}
</style></head><body><main><div class="spinner"></div><h1>正在迁移 WechatExplorer 数据</h1><p id="status">正在准备迁移…</p><p class="hint">请不要退出 TraceMemo。旧数据不会被删除。</p></main></body></html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  window.setProgressBar(2, { mode: 'indeterminate' })
  window.show()
  return window
}

function updateMigrationProgress(window: BrowserWindow | null, message: string): void {
  if (!window || window.isDestroyed()) return
  void window.webContents
    .executeJavaScript(
      `document.getElementById('status').textContent = ${JSON.stringify(message)}`,
      true
    )
    .catch(() => undefined)
}

function closeMigrationProgress(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return
  window.setProgressBar(-1)
  window.setClosable(true)
  window.destroy()
}

export async function runFirstLaunchMigration(roots: UserDataRoots): Promise<MigrationFlowResult> {
  const assessment = assessMigration(roots)
  if (!assessment.shouldPrompt || !assessment.sourceRoot) {
    return { assessment, action: 'none', tokenGenerationBlocked: false }
  }

  const sourceLabel = path.basename(assessment.sourceRoot)
  const conflictNote = assessment.selection.legacyConflict
    ? '\n\n检测到两个旧数据目录，将确定性使用 WechatExplorer；另一个目录不会修改。'
    : ''
  const response = await dialog.showMessageBox({
    type: 'question',
    title: '迁移 WechatExplorer 数据',
    message: '检测到 WechatExplorer 数据',
    detail:
      `TraceMemo 可以从 ${sourceLabel} 迁移设置、Knowledge、本地索引、API Token、AI Provider、报告和 Agent 配置。` +
      '\n\n迁移只复制缺失的用户资产，不会覆盖 TraceMemo 已有数据，也不会删除旧目录。' +
      conflictNote,
    buttons: ['立即迁移', '以后迁移'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })

  if (response.response !== 0) {
    const state: MigrationState = {
      version: 1,
      status: 'deferred',
      sourceRoot: assessment.sourceRoot,
      updatedAt: new Date().toISOString(),
      items: assessment.state?.items || {},
      secretFailures: assessment.state?.secretFailures || []
    }
    await writeMigrationState(roots.current, state)
    const tokenGenerationBlocked = await fs.pathExists(
      path.join(assessment.sourceRoot, 'local-api-token.bin')
    )
    return {
      assessment,
      action: 'deferred',
      tokenGenerationBlocked,
      ...(tokenGenerationBlocked ? { tokenBlockReason: TOKEN_MIGRATION_BLOCK_MESSAGE } : {})
    }
  }

  const progressWindow = await createMigrationProgressWindow()
  let execution: MigrationExecutionResult
  try {
    execution = await executeMigration(assessment.sourceRoot, roots.current, {
      decryptLegacySecrets: runLegacySecretHelper,
      agentRoots: () => getAgentCredentialRoots(),
      now: () => new Date(),
      onProgress: (message) => updateMigrationProgress(progressWindow, message)
    })
    updateMigrationProgress(progressWindow, '迁移完成，正在启动 TraceMemo…')
    const messageBoxOptions = {
      type: execution.state.status === 'completed' ? ('info' as const) : ('warning' as const),
      title: 'TraceMemo 数据迁移',
      message:
        execution.state.status === 'completed'
          ? 'WechatExplorer 数据迁移完成'
          : '部分数据未能迁移',
      detail:
        execution.state.status === 'completed'
          ? '核心用户资产已复制到 TraceMemo。旧目录仍完整保留。'
          : '旧目录没有被修改。请保留旧数据并在下次启动时重试；无法迁移的 API Token 不会被静默替换。',
      buttons: ['好']
    }
    if (progressWindow && !progressWindow.isDestroyed()) {
      await dialog.showMessageBox(progressWindow, messageBoxOptions)
    } else {
      await dialog.showMessageBox(messageBoxOptions)
    }
  } finally {
    closeMigrationProgress(progressWindow)
  }
  return {
    assessment,
    action: 'migrated',
    execution,
    tokenGenerationBlocked: execution.tokenGenerationBlocked,
    tokenBlockReason: execution.tokenBlockReason
  }
}
