import { randomBytes } from 'node:crypto'
import { assertBusinessOk, ILinkError } from './errors'
import { markdownToPlainText } from './markdown'
import type { ILinkClient } from './client'
import {
  ILINK_ITEM_TYPE_TEXT,
  ILINK_MESSAGE_STATE_FINISH,
  ILINK_MESSAGE_TYPE_BOT,
  type ILinkMessageItem,
  type ILinkSendMessageRequest
} from './types'

/**
 * Bot 外发消息的 `from_user_id`。
 *
 * 官方客户端（2.4.6）对 Bot 主动外发固定传空字符串；传 bot id 也能被服务端接受。
 * 这里遵循官方实现。
 */
const BOT_OUTBOUND_FROM_USER_ID = ''

export function createClientId(): string {
  return `tracememo-${randomBytes(16).toString('hex')}`
}

/** 组装 sendmessage 请求体；文本与媒体共用，每个请求只放一个 item。 */
export function buildSendMessageBody(input: {
  item: ILinkMessageItem
  to: string
  contextToken?: string
  clientId: string
  runId?: string
}): ILinkSendMessageRequest['msg'] {
  return {
    from_user_id: BOT_OUTBOUND_FROM_USER_ID,
    to_user_id: input.to,
    client_id: input.clientId,
    message_type: ILINK_MESSAGE_TYPE_BOT,
    message_state: ILINK_MESSAGE_STATE_FINISH,
    item_list: [input.item],
    // 缺失时传空字符串而不是省略字段：服务端按字段存在性判断会话。
    context_token: String(input.contextToken ?? ''),
    ...(input.runId ? { run_id: input.runId } : {})
  }
}

export interface SendTextOptions {
  to: string
  text: string
  /** 会话上下文令牌：回复当前会话时必须原样回传。 */
  contextToken?: string
  clientId?: string
  runId?: string
  signal?: AbortSignal
}

export interface SendTextResult {
  clientId: string
  /** 实际投递的纯文本内容（Markdown 已降级）。 */
  plainText: string
}

export async function sendText(
  client: ILinkClient,
  options: SendTextOptions
): Promise<SendTextResult> {
  const to = String(options.to ?? '').trim()
  if (!to) throw new ILinkError({ kind: 'protocol', message: '发送文本需要有效的接收者' })

  const plainText = markdownToPlainText(options.text)
  if (!plainText) throw new ILinkError({ kind: 'protocol', message: '发送文本内容为空' })

  const clientId = options.clientId || createClientId()
  const response = await client.sendMessage(
    buildSendMessageBody({
      item: { type: ILINK_ITEM_TYPE_TEXT, text_item: { text: plainText } },
      to,
      clientId,
      ...(options.contextToken ? { contextToken: options.contextToken } : {}),
      ...(options.runId ? { runId: options.runId } : {})
    }),
    options.signal
  )
  assertBusinessOk(response, '发送文本')
  return { clientId, plainText }
}
