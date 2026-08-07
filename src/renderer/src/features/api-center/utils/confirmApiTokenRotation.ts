export const API_TOKEN_ROTATION_CONFIRMATION =
  '重新生成后，旧 Token 将立即失效。\n已配置此 API 的 Agent / Reader Skill 需要更新 Token。\n是否继续？'

export function confirmApiTokenRotation(
  confirm: (message: string) => boolean = window.confirm
): boolean {
  return confirm(API_TOKEN_ROTATION_CONFIRMATION)
}
