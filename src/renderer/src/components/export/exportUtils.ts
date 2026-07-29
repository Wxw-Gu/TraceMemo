import type { Contact, Message } from '../../../../shared/types'
import type { ExportFormat, GroupMemberName } from './exportTypes'

export const messageKinds = [
  ['text', '文字'],
  ['image', '图片'],
  ['video', '视频'],
  ['voice', '语音'],
  ['sticker', '表情包'],
  ['share', '链接与分享'],
  ['location', '位置'],
  ['system', '系统消息']
] as const

export const formatLabels: Record<ExportFormat, { label: string; hint?: string }> = {
  html: { label: 'HTML', hint: '推荐' },
  csv: { label: 'CSV' },
  json: { label: 'JSON' },
  markdown: { label: 'Markdown' }
}

export const formatOrder: ExportFormat[] = ['csv', 'html', 'json', 'markdown']

export function displayName(contact: Contact | null): string {
  return contact?.m_nsNickName || contact?.m_nsUsrName || '未选择会话'
}

export function formatPreviewTime(message: Message): string {
  if (!message.createTime) return message.datetime || ''
  return new Date(message.createTime * 1000).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function buildNameMap(
  activeContact: Contact | null,
  groupMembers: GroupMemberName[],
  nameMode: string,
  selfInfo: { wxid: string; nickname: string } | null
): Record<string, string> {
  const map: Record<string, string> = {}
  if (activeContact?.type === 'group') {
    for (const member of groupMembers) {
      const value =
        nameMode === 'groupNickname'
          ? member.groupNickname || member.nickname || member.wxid
          : nameMode === 'remark'
            ? member.remark || member.wechatNickname || member.wxid
            : member.wechatNickname || member.wxid
      map[member.wxid] = value
    }
  } else if (activeContact) {
    map[activeContact.m_nsUsrName] =
      nameMode === 'remark'
        ? activeContact.remark || activeContact.m_nsNickName || activeContact.m_nsUsrName
        : activeContact.wechatNickname || activeContact.m_nsUsrName
  }
  if (selfInfo?.wxid) map[selfInfo.wxid] = selfInfo.nickname || selfInfo.wxid
  return map
}

export function buildAvatarUrls(
  activeContact: Contact | null,
  groupMembers: GroupMemberName[],
  selfInfo: { wxid: string; avatar?: string } | null
): Record<string, string> {
  const map: Record<string, string> = {}
  if (activeContact?.m_nsUsrName && activeContact.avatar) {
    map[activeContact.m_nsUsrName] = activeContact.avatar
  }
  for (const member of groupMembers) {
    if (member.avatar) map[member.wxid] = member.avatar
  }
  if (selfInfo?.wxid && selfInfo.avatar) map[selfInfo.wxid] = selfInfo.avatar
  return map
}
