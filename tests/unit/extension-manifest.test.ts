import { describe, expect, it } from 'vitest'
import {
  checkExtensionCompatibility,
  compareSemver,
  isSafeRelativeEntryPath,
  isValidExtensionId,
  parseExtensionManifest,
  parseExtensionManifestJson
} from '../../src/shared/extensions/manifest'

const base = {
  manifestVersion: 1,
  id: 'com.example.fixture-bot',
  name: 'Fixture Bot',
  version: '1.0.0',
  apiVersion: '1',
  minAppVersion: '2.6.0',
  permissions: ['storage'],
  entrypoints: { page: 'ui/index.html', background: 'background/index.js' },
  contributions: { pages: [{ id: 'settings', title: '设置' }] }
}

describe('extension manifest', () => {
  it('接受合法的反向域名 id 并补齐默认值', () => {
    const result = parseExtensionManifest(base)
    expect(result.ok).toBe(true)
    expect(result.manifest?.id).toBe('com.example.fixture-bot')
    expect(result.manifest?.permissions).toEqual(['storage'])
    expect(result.manifest?.contributions.automationActions).toEqual([])
  })

  it('拒绝保留前缀与大写 id', () => {
    expect(isValidExtensionId('com.tracememo.reader')).toBe(false)
    expect(isValidExtensionId('com.Example.Hello')).toBe(false)
    expect(isValidExtensionId('hello')).toBe(false)
    expect(isValidExtensionId('com.example.ok')).toBe(true)
  })

  it('拒绝未知权限，而不是静默丢弃', () => {
    const result = parseExtensionManifest({ ...base, permissions: ['storage', 'fs.read'] })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('未知权限')
  })

  it('拒绝与宿主不兼容的 apiVersion', () => {
    const result = parseExtensionManifest({ ...base, apiVersion: '2' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('EXTENSION_INCOMPATIBLE')
  })

  it('minAppVersion 高于当前版本时拒绝安装', () => {
    const result = parseExtensionManifest(
      { ...base, minAppVersion: '2.7.0' },
      { appVersion: '2.6.0' }
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe('EXTENSION_INCOMPATIBLE')
  })

  it('声明消息订阅但没有 background 时拒绝', () => {
    const result = parseExtensionManifest({
      ...base,
      entrypoints: { page: 'ui/index.html' },
      permissions: ['messages.subscribe'],
      subscriptions: { messageTypes: ['text'], conversationIds: [] }
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('entrypoints.background')
  })

  it('拒绝目录穿越的入口路径', () => {
    const result = parseExtensionManifest({
      ...base,
      entrypoints: { page: '../../etc/passwd' }
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('entrypoints.page')
  })

  it('入口路径检查覆盖穿越、盘符、保留名与反斜杠', () => {
    expect(isSafeRelativeEntryPath('ui/index.html')).toBe(true)
    expect(isSafeRelativeEntryPath('../evil.html')).toBe(false)
    expect(isSafeRelativeEntryPath('/etc/passwd')).toBe(false)
    expect(isSafeRelativeEntryPath('C:/Windows/system32')).toBe(false)
    expect(isSafeRelativeEntryPath('ui\\index.html')).toBe(true)
    expect(isSafeRelativeEntryPath('ui/con.txt')).toBe(false)
    expect(isSafeRelativeEntryPath('ui//index.html')).toBe(false)
  })

  it('页面 id 与动作 id 不合法时拒绝', () => {
    expect(
      parseExtensionManifest({
        ...base,
        contributions: { pages: [{ id: 'Bad Page', title: 'x' }] }
      }).ok
    ).toBe(false)
    expect(
      parseExtensionManifest({
        ...base,
        contributions: { automationActions: [{ id: 'UPPER', title: 'x' }] }
      }).ok
    ).toBe(false)
  })

  it('JSON 语法错误与 schema 错误分开报', () => {
    expect(parseExtensionManifestJson('{').message).toContain('JSON')
    expect(parseExtensionManifestJson('[]').message).toContain('manifest')
  })

  it('semver 比较忽略 prerelease 且不误伤预发布构建', () => {
    expect(compareSemver('2.6.0', '2.5.9')).toBe(1)
    expect(compareSemver('2.6.0-beta.1', '2.6.0')).toBe(0)
    expect(compareSemver('bad', '2.6.0')).toBeNull()
    expect(
      checkExtensionCompatibility({ apiVersion: '1', minAppVersion: '2.6.0' }, '2.6.0-rc.1')
    ).toEqual({
      compatible: true
    })
  })
})
