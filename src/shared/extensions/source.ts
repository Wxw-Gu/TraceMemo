/**
 * 扩展的来源。
 *
 * 决定「谁能更新它」：只有安装入口（Trusted installer）能写入来源，
 * 而模板目录只承认 `template` 来源的记录归自己管理。
 *
 * - `directory`：从本地文件夹安装。
 * - `package`：从 ZIP 安装。
 * - `template`：由官方模板目录安装，带 `templateId` / `templateVersion`。
 * - `development`：链接外部源码目录；代码不复制，路径只存在本机 Registry。
 */
export type ExtensionSource = 'directory' | 'package' | 'template' | 'development'

export const EXTENSION_SOURCES: readonly ExtensionSource[] = [
  'directory',
  'package',
  'template',
  'development'
]

/** 未知值一律归为 `directory`：来源不能从不可信文件里推断。 */
export function normalizeExtensionSource(value: unknown): ExtensionSource {
  if (value === 'package' || value === 'template' || value === 'development') return value
  return 'directory'
}
