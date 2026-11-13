/**
 * 扩展权限目录。
 *
 * 权限是**宿主授予**的，不是扩展自己声称的：manifest 里只声明「需要什么」，
 * 真正生效的是 registry 里 `grantedPermissions` 与当前启用状态的交集。
 */

export const EXTENSION_PERMISSIONS = [
  'messages.subscribe',
  'messages.query',
  'contacts.list',
  'wechat.send.text',
  'wechat.send.image',
  'wechat.send.video',
  'ai.chat',
  'storage',
  'automation.action'
] as const

export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number]

export type ExtensionPermissionRisk = 'low' | 'medium' | 'high'

export interface ExtensionPermissionInfo {
  label: string
  description: string
  risk: ExtensionPermissionRisk
}

export const EXTENSION_PERMISSION_INFO: Record<ExtensionPermission, ExtensionPermissionInfo> = {
  'messages.subscribe': {
    label: '接收新消息事件',
    description:
      '在 TraceMemo 监听运行期间接收新消息的规范化字段（会话、发送者、消息类型、正文）。',
    risk: 'high'
  },
  'messages.query': {
    label: '读取指定会话消息',
    description: '按会话与时间窗口读取有上限的历史消息，不能遍历全部会话。',
    risk: 'high'
  },
  'contacts.list': {
    label: '读取群列表',
    description: '读取本机通讯录中的群名称与会话 id，用于配置页选择发送目标；不包含聊天内容。',
    risk: 'medium'
  },
  'wechat.send.text': {
    label: '发送微信文本',
    description: '经 TraceMemo 官方 Gateway 发送文本；仍需有效授权、本机发送能力与发送频率限制。',
    risk: 'high'
  },
  'wechat.send.image': {
    label: '发送微信图片',
    description:
      '经 TraceMemo 官方 Gateway 发送图片；只能使用扩展数据目录或临时目录中的文件，仍需有效授权与发送能力。',
    risk: 'high'
  },
  'wechat.send.video': {
    label: '发送微信视频',
    description:
      '经 TraceMemo 官方 Gateway 发送视频文件；原生 Host 以 video 类型提交，单文件不超过 100MB，仍需有效授权与发送能力。',
    risk: 'high'
  },
  'ai.chat': {
    label: '调用 AI 模型',
    description: '使用 TraceMemo 已配置的 AI Provider 发起对话；扩展拿不到 API Key 明文。',
    risk: 'medium'
  },
  storage: {
    label: '扩展私有存储',
    description: '读写本扩展独立的数据目录，不会接触其他扩展或官方数据。',
    risk: 'low'
  },
  'automation.action': {
    label: '注册自动化动作',
    description: '向 TraceMemo 自动化中心注册动作，由用户在规则里选择后才会执行。',
    risk: 'medium'
  }
}

export function isExtensionPermission(value: unknown): value is ExtensionPermission {
  return typeof value === 'string' && (EXTENSION_PERMISSIONS as readonly string[]).includes(value)
}

/** 去重、去空白、丢弃未知值。**未知权限在 manifest 校验阶段就会被拒绝**，这里只做收敛。 */
export function normalizeExtensionPermissions(input: unknown): ExtensionPermission[] {
  if (!Array.isArray(input)) return []
  const result: ExtensionPermission[] = []
  for (const value of input) {
    if (!isExtensionPermission(value)) continue
    if (result.includes(value)) continue
    result.push(value)
  }
  return result
}

export function hasExtensionPermission(
  granted: readonly ExtensionPermission[] | undefined,
  permission: ExtensionPermission
): boolean {
  return Array.isArray(granted) && granted.includes(permission)
}

/** 界面按风险从高到低展示；同风险保持目录顺序。 */
export function sortPermissionsByRisk(
  permissions: readonly ExtensionPermission[]
): ExtensionPermission[] {
  const weight: Record<ExtensionPermissionRisk, number> = { high: 0, medium: 1, low: 2 }
  return [...permissions].sort((left, right) => {
    const delta =
      weight[EXTENSION_PERMISSION_INFO[left].risk] - weight[EXTENSION_PERMISSION_INFO[right].risk]
    if (delta !== 0) return delta
    return EXTENSION_PERMISSIONS.indexOf(left) - EXTENSION_PERMISSIONS.indexOf(right)
  })
}

/**
 * 安装时自动授予的权限子集：只有低风险项。
 *
 * 高 / 中风险权限必须由用户在「启用扩展」时确认 —— 安装本身不应等于同意
 * 读取消息或发送微信。
 */
export function autoGrantedPermissions(
  permissions: readonly ExtensionPermission[]
): ExtensionPermission[] {
  return permissions.filter((permission) => EXTENSION_PERMISSION_INFO[permission].risk === 'low')
}
