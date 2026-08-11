import { app } from 'electron'
import path from 'path'
import { getUserDataRoots, LEGACY_USER_DATA_NAME, TRACE_MEMO_RUNTIME_NAME } from './app-data-paths'

export const LEGACY_MIGRATION_HELPER_ENV = 'TRACEMEMO_LEGACY_MIGRATION_HELPER'
export const LEGACY_MIGRATION_SOURCE_ENV = 'TRACEMEMO_LEGACY_MIGRATION_SOURCE'
export const LEGACY_MIGRATION_USER_DATA_ENV = 'TRACEMEMO_LEGACY_MIGRATION_USER_DATA'
export const LEGACY_MIGRATION_RESULT_FD_ENV = 'TRACEMEMO_LEGACY_MIGRATION_RESULT_FD'

// This module must remain the first main-process import. Static imports in
// settings/cache services can otherwise resolve Electron paths before the
// TraceMemo userData is installed before any consumers. macOS uses the old
// safeStorage identity only inside the helper; Windows keeps in both
// processes because WCDB requires that technical runtime name.
const isLegacyMigrationHelper = process.env[LEGACY_MIGRATION_HELPER_ENV] === '1'
const legacyRuntimeName = process.platform === 'win32' ? 'WeFlow' : LEGACY_USER_DATA_NAME
const runtimeName =
  process.platform === 'win32'
    ? 'WeFlow'
    : isLegacyMigrationHelper
      ? legacyRuntimeName
      : TRACE_MEMO_RUNTIME_NAME
app.setName(runtimeName)

const isolatedUserData = process.env['WXE_USER_DATA']
const isUserDataIsolated = !isLegacyMigrationHelper && Boolean(isolatedUserData?.trim())
const roots = getUserDataRoots(app.getPath('appData'))
const helperUserData = process.env[LEGACY_MIGRATION_USER_DATA_ENV]
const selectedUserData = isLegacyMigrationHelper
  ? path.resolve(helperUserData?.trim() || path.join(roots.current, '.legacy-migration-helper'))
  : isolatedUserData?.trim()
    ? path.resolve(isolatedUserData)
    : roots.current

app.setPath('userData', selectedUserData)
app.setPath('sessionData', selectedUserData)

// Logs are intentionally independent from userData. New TraceMemo logs go to
// the new visible directory while historical WechatExplorer logs remain in
// place and are never moved or renamed.
if (isLegacyMigrationHelper) {
  app.setPath('logs', path.join(selectedUserData, 'logs'))
} else if (process.platform === 'darwin') {
  app.setPath('logs', path.join(app.getPath('home'), 'Library', 'Logs', 'TraceMemo'))
} else if (process.platform === 'win32') {
  app.setPath('logs', path.join(selectedUserData, 'logs'))
}

export {
  isLegacyMigrationHelper,
  isUserDataIsolated,
  legacyRuntimeName,
  runtimeName,
  roots,
  selectedUserData
}
