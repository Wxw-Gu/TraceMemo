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

/**
 * 群会话判定（统一入口）。
 *
 * 普通微信群会话以 `@chatroom` 结尾；企业微信插件群会话以 `@qy_g` 结尾。
 * 二者在「读取 / 展示」链路上语义一致（有成员列表、能出群日报、能被群档案检索），
 * 故收敛到同一个判定，避免 P2 阶段在 40+ 处 `@chatroom` 判断里机械复制条件。
 * 企业单聊 `@qy_u` 仍是单聊（user），不在此列。
 */
export function isGroupSession(value: string | undefined | null): boolean {
  const username = String(value || '').trim()
  return username.endsWith('@chatroom') || username.endsWith('@qy_g')
}

/** 企业微信插件会话（群 `*@qy_g` 或单聊/成员 `*@qy_u`）。 */
export function isEnterpriseSession(value: string | undefined | null): boolean {
  const username = String(value || '').trim()
  return username.endsWith('@qy_g') || username.endsWith('@qy_u')
}
