/**
 * 微信协议层的**固定身份**。
 *
 * 为什么要有这个文件：这些值不是「昵称」，是协议里写死的 username。
 * 用昵称去搜索（`nickname === '文件传输助手'`）在改过备注、多语言、
 * 或同名联系人存在时会直接选错发送对象 —— 而发错人是不可撤销的。
 */

/**
 * 文件传输助手。
 *
 * 微信客户端的固定 username，不随账号语言、昵称、备注变化。
 * **真机核对项**：需在真机实测一次。
 */
export const WECHAT_FILE_HELPER_USERNAME = 'filehelper'

export function isFileHelperUsername(value: string | undefined | null): boolean {
  return String(value || '').trim().toLowerCase() === WECHAT_FILE_HELPER_USERNAME
}
