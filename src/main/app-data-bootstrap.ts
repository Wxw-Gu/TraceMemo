import { app } from 'electron'
import path from 'path'
import {
  chooseUserDataRoot,
  getUserDataRoots,
  LEGACY_USER_DATA_NAME
} from './app-data-paths'

// This module must remain the first main-process import. Static imports in
// settings/cache services can otherwise resolve Electron paths before the
// legacy runtime identity and selected userData are installed.
app.setName(process.platform === 'win32' ? 'WeFlow' : LEGACY_USER_DATA_NAME)

const isolatedUserData = process.env['WXE_USER_DATA']
const roots = getUserDataRoots(app.getPath('appData'))
const selectedUserData = chooseUserDataRoot({
  ...roots,
  isolated: isolatedUserData
})

app.setPath('userData', selectedUserData)
app.setPath('sessionData', selectedUserData)

// Logs are intentionally independent from userData. New TraceMemo logs go to
// the new visible directory while historical WechatExplorer logs remain in
// place and are never moved or renamed.
if (process.platform === 'darwin') {
  app.setPath('logs', path.join(app.getPath('home'), 'Library', 'Logs', 'TraceMemo'))
}

export { roots, selectedUserData }
