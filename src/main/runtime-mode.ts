import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

export function isPackagedRuntime(): boolean {
  if (app.isPackaged) return true

  // 非 Electron 进程（例如单元/集成测试）里 process.resourcesPath 不存在，
  // 此时 join 会抛错。没有 resources 目录就必然不是打包运行时。
  const resourcesPath = process.resourcesPath
  if (!resourcesPath) return false

  return (
    existsSync(join(resourcesPath, 'app.asar')) &&
    existsSync(join(resourcesPath, 'app-update.yml'))
  )
}
