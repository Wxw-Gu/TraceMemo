import path from 'path'
import type { ImageKeyConfigResult, SaveImageKeyRequest } from '../../shared/image-decryption'
import { ImageKeyStore } from '../image-key-store'
import * as chat from './chat-service'
import { loadSettings, saveSettings, type AppSettings } from './settings-store'

export class ImageKeyConfigService {
  constructor(private readonly store = new ImageKeyStore()) {}

  getConfig(): ImageKeyConfigResult {
    const settings = loadSettings()
    const context = this.getContext(settings)
    const stored = this.store.get(context.accountId)
    if (!stored.success) {
      return {
        success: false,
        configured: false,
        saved: false,
        encryptionAvailable: stored.encryptionAvailable,
        source: 'none',
        accountId: context.accountId,
        resourceRoot: context.resourceRoot,
        error: stored.error
      }
    }
    if (stored.entry) {
      return {
        success: true,
        configured: true,
        saved: true,
        encryptionAvailable: stored.encryptionAvailable,
        source: 'secure-storage',
        accountId: context.accountId,
        resourceRoot: context.resourceRoot,
        xorKey: stored.entry.xorKey,
        aesKey: stored.entry.aesKey,
        updatedAt: stored.entry.updatedAt
      }
    }

    if (settings.imageAesKey.trim()) {
      const legacy = this.buildResult({
        source: 'legacy-settings',
        xorKey: settings.imageXorKey || '0x40',
        aesKey: settings.imageAesKey,
        context,
        encryptionAvailable: stored.encryptionAvailable
      })
      if (!stored.encryptionAvailable) return legacy
      const migrated = this.save({
        resourceRoot: context.resourceRoot,
        xorKey: legacy.xorKey || '0x40',
        aesKey: legacy.aesKey || ''
      })
      return migrated.success ? this.getConfig() : legacy
    }

    const envAesKey = String(import.meta.env.VITE_IMAGE_AES_KEY || '').trim()
    if (!settings.imageKeyFallbackDisabled && envAesKey) {
      return this.buildResult({
        source: 'environment',
        xorKey: String(import.meta.env.VITE_IMAGE_XOR_KEY || '0x40'),
        aesKey: envAesKey,
        context,
        encryptionAvailable: stored.encryptionAvailable
      })
    }

    return {
      success: true,
      configured: false,
      saved: false,
      encryptionAvailable: stored.encryptionAvailable,
      source: 'none',
      accountId: context.accountId,
      resourceRoot: context.resourceRoot
    }
  }

  save(request: SaveImageKeyRequest): ImageKeyConfigResult {
    const normalized = validateImageKeyRequest(request)
    if (!normalized.success) return { ...this.getEmptyConfig(), error: normalized.error }
    const settings = loadSettings()
    const context = this.getContext(settings)
    if (!chat.getSelfAccountInfo()?.wxid) {
      return { ...this.getEmptyConfig(), error: '当前微信账号尚未识别' }
    }
    const result = this.store.save(context.accountId, {
      xorKey: normalized.xorKey,
      aesKey: normalized.aesKey
    })
    if (!result.success || !result.entry) {
      return { ...this.getEmptyConfig(), error: result.error || '图片密钥保存失败' }
    }
    // 注意：normalized.resourceRoot 不再写回 imageKeyRoot。
    // 下方的"图片资源目录"输入框仅用于本次手动测试，不再污染状态面板上方显示。
    saveSettings({
      ...settings,
      imageXorKey: '',
      imageAesKey: '',
      imageKeyFallbackDisabled: false
    })
    return {
      success: true,
      configured: true,
      saved: true,
      encryptionAvailable: true,
      source: 'secure-storage',
      accountId: context.accountId,
      // 返回的 resourceRoot 始终是识别到的默认目录，与状态面板一致；
      // 不返回 normalized.resourceRoot，避免把用户输入的测试目录当成状态写回。
      resourceRoot: context.resourceRoot,
      xorKey: result.entry.xorKey,
      aesKey: result.entry.aesKey,
      updatedAt: result.entry.updatedAt
    }
  }

  clear(): { success: boolean; error?: string } {
    const settings = loadSettings()
    const context = this.getContext(settings)
    const cleared = this.store.clear(context.accountId)
    if (!cleared.success) return cleared
    saveSettings({
      ...settings,
      imageXorKey: '',
      imageAesKey: '',
      imageKeyFallbackDisabled: true
    })
    return { success: true }
  }

  getLegacySettingsView(): AppSettings {
    const settings = loadSettings()
    const config = this.getConfig()
    return {
      ...settings,
      imageXorKey: config.xorKey || '',
      imageAesKey: config.aesKey || ''
    }
  }

  private getContext(settings: AppSettings): { accountId: string; resourceRoot: string } {
    const self = chat.getSelfAccountInfo()
    const accountRoot = self?.accountRoot || chat.getCurrentAccountRoot() || settings.dbRoot
    return {
      accountId: self?.wxid || path.basename(accountRoot || '') || 'unbound',
      resourceRoot: settings.imageKeyRoot || accountRoot || settings.dbRoot
    }
  }

  private buildResult(input: {
    source: 'legacy-settings' | 'environment'
    xorKey: string
    aesKey: string
    context: { accountId: string; resourceRoot: string }
    encryptionAvailable: boolean
  }): ImageKeyConfigResult {
    return {
      success: true,
      configured: true,
      saved: false,
      encryptionAvailable: input.encryptionAvailable,
      source: input.source,
      accountId: input.context.accountId,
      resourceRoot: input.context.resourceRoot,
      xorKey: normalizeImageXorKey(input.xorKey),
      aesKey: input.aesKey.trim()
    }
  }

  private getEmptyConfig(): ImageKeyConfigResult {
    const settings = loadSettings()
    const context = this.getContext(settings)
    const stored = this.store.get(context.accountId)
    return {
      success: false,
      configured: false,
      saved: false,
      encryptionAvailable: stored.encryptionAvailable,
      source: 'none',
      accountId: context.accountId,
      resourceRoot: context.resourceRoot
    }
  }
}

export function normalizeImageXorKey(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return '0x40'
  const parsed = raw.toLowerCase().startsWith('0x')
    ? Number.parseInt(raw.slice(2), 16)
    : Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 255) return raw
  return `0x${parsed.toString(16).toUpperCase().padStart(2, '0')}`
}

export function validateImageKeyRequest(
  request: SaveImageKeyRequest
):
  | { success: true; resourceRoot: string; xorKey: string; aesKey: string }
  | { success: false; error: string } {
  const resourceRoot = request.resourceRoot.trim()
  const xorKey = normalizeImageXorKey(request.xorKey)
  const aesKey = request.aesKey.trim()
  if (!resourceRoot) return { success: false, error: '图片资源目录不能为空' }
  if (!/^0x[0-9A-F]{2}$/.test(xorKey)) return { success: false, error: 'XOR Key 格式不正确' }
  if (aesKey.length !== 16) return { success: false, error: 'AES Key 必须为 16 个字符' }
  return { success: true, resourceRoot, xorKey, aesKey }
}
