import { app, safeStorage } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import type {
  WechatShareServiceConfig,
  WechatShareServiceConfigResult
} from '../shared/wechat-share-card'

const normalizeUrl = (value: string): string => value.trim().replace(/\/+$/, '')

const validate = (config: WechatShareServiceConfig): string | null => {
  try {
    const url = new URL(normalizeUrl(config.serviceUrl))
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      return '卡片服务必须使用 HTTPS'
    }
  } catch {
    return '卡片服务地址无效'
  }
  if (config.uploadToken.trim().length < 24) return '上传密钥至少需要 24 个字符'
  return null
}

export class WechatShareConfigStore {
  private get filePath(): string {
    return path.join(app.getPath('userData'), 'wechat-share-service.bin')
  }

  async loadRaw(): Promise<WechatShareServiceConfig | null> {
    if (!(await fs.pathExists(this.filePath))) return null
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
    const encrypted = await fs.readFile(this.filePath)
    const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as WechatShareServiceConfig
    const error = validate(parsed)
    if (error) throw new Error(error)
    return { serviceUrl: normalizeUrl(parsed.serviceUrl), uploadToken: parsed.uploadToken.trim() }
  }

  async status(): Promise<WechatShareServiceConfigResult> {
    try {
      const config = await this.loadRaw()
      return {
        success: true,
        configured: Boolean(config),
        serviceUrl: config?.serviceUrl
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async save(config: WechatShareServiceConfig): Promise<WechatShareServiceConfigResult> {
    const normalized = {
      serviceUrl: normalizeUrl(config.serviceUrl),
      uploadToken: config.uploadToken.trim()
    }
    const error = validate(normalized)
    if (error) return { success: false, error }
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: '系统安全存储不可用' }
    }
    await fs.ensureDir(path.dirname(this.filePath))
    await fs.writeFile(this.filePath, safeStorage.encryptString(JSON.stringify(normalized)), {
      mode: 0o600
    })
    await fs.chmod(this.filePath, 0o600)
    return { success: true, configured: true, serviceUrl: normalized.serviceUrl }
  }
}
