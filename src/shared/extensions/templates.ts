import type { ExtensionPermission } from './permissions'
import type { ExtensionSource } from './source'

/**
 * 模板索引里的依赖声明。
 *
 * 存在的意义是「别把缺依赖的模板宣传成开箱即用」：界面必须在安装前就把
 * 需要什么摆出来，安装后检测到缺失就明确说「暂时无法处理视频」。
 */
export interface ExtensionTemplateRequirement {
  python?: boolean | { required: boolean; minVersion?: string; reason?: string }
  chrome?: boolean | { required: boolean; reason?: string }
  externalScript?: boolean | { required: boolean; path: string; reason?: string }
}

export interface ExtensionTemplateEntry {
  templateId: string
  extensionId: string
  name: string
  version: string
  description?: string
  permissions: ExtensionPermission[]
  file: string
  sha256: string
  bytes: number
  fileCount: number
  platforms: NodeJS.Platform[]
  requires: ExtensionTemplateRequirement
}

export type ExtensionTemplateState =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'conflict'
  | 'unsupported'
  | 'damaged'

export interface TemplateDependencyCheck {
  id: 'python' | 'chrome' | 'externalScript'
  label: string
  ok: boolean
  /** 为真时，缺失会阻止模板的主要功能，界面不能显示「可用」。 */
  blocking: boolean
  detail?: string
}

export interface ExtensionTemplateStatus {
  template: ExtensionTemplateEntry
  state: ExtensionTemplateState
  installedVersion?: string
  installedSource?: ExtensionSource
  dependencies: {
    ready: boolean
    checks: TemplateDependencyCheck[]
  }
  message?: string
}
