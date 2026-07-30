import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

export function isPackagedRuntime(): boolean {
  if (app.isPackaged) return true

  return (
    existsSync(join(process.resourcesPath, 'app.asar')) &&
    existsSync(join(process.resourcesPath, 'app-update.yml'))
  )
}
