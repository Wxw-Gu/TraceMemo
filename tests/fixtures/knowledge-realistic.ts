import type { KnowledgeConversationInput, KnowledgeSourceMessage } from '../../src/shared/knowledge'

export type RealisticBenchmarkCategory =
  | 'chinese-continuous'
  | 'chinese-short'
  | 'person-name'
  | 'mixed-language'
  | 'url'
  | 'file-name'
  | 'technical-term'
  | 'number-email-path'
  | 'short-message'
  | 'long-voice'

export interface RealisticBenchmarkCase {
  id: string
  category: RealisticBenchmarkCategory
  /** The question as a user would naturally phrase it. */
  question: string
  /** Deterministic local query-router output, not an LLM-generated answer. */
  searchTerms: string[]
  expectedMessageIds: string[]
}

export const REALISTIC_FIXTURE_ACCOUNT = 'fixture-realistic-account'

function sourceMessage(
  messageId: string,
  conversationId: string,
  createTime: number,
  text: string,
  extra: Partial<KnowledgeSourceMessage> = {}
): KnowledgeSourceMessage {
  return {
    accountId: REALISTIC_FIXTURE_ACCOUNT,
    conversationId,
    messageId,
    createTime,
    senderId: extra.senderId || 'fixture-member-a',
    senderName: extra.senderName || '脱敏成员甲',
    kind: extra.kind || 'text',
    text,
    attachment: extra.attachment,
    voiceTranscript: extra.voiceTranscript
  }
}

/**
 * Fully artificial messages written in the style of real WeChat conversations.
 * Nicknames, domains, addresses, mailboxes, file names and paths are all fixtures;
 * no user chat record, wxid, account directory, or source-database value is included.
 */
export function createRealisticKnowledgeFixture(): {
  conversations: KnowledgeConversationInput[]
  cases: RealisticBenchmarkCase[]
} {
  const base = Date.UTC(2026, 6, 12, 8, 0, 0)
  const messages: KnowledgeSourceMessage[] = [
    sourceMessage(
      'msg-cn-continuous-1',
      'conv-product-group',
      base,
      '刚确认：聊天档案导出失败时，先保留原图链接，再回退缩略图，避免用户以为图片丢了。',
      { senderId: 'member-lan', senderName: '蓝图同学' }
    ),
    sourceMessage(
      'msg-cn-continuous-noise',
      'conv-product-group',
      base + 60,
      '导出完成后可以在任务中心查看文件夹。',
      { senderId: 'member-river', senderName: '河岸' }
    ),
    sourceMessage('msg-cn-short-1', 'conv-family', base + 120, '周六见，咖啡我来带。', {
      senderId: 'member-yu',
      senderName: '小雨'
    }),
    sourceMessage(
      'msg-person-1',
      'conv-product-group',
      base + 180,
      '林澈把 Windows 安装包的签名检查补好了，今晚发测试包。',
      { senderId: 'member-lin', senderName: '林澈' }
    ),
    sourceMessage(
      'msg-person-noise',
      'conv-product-group',
      base + 240,
      '小林晚点把截图发到群里。',
      { senderId: 'member-lin', senderName: '林澈' }
    ),
    sourceMessage(
      'msg-mixed-1',
      'conv-engineering',
      base + 300,
      'Web 端的 dark mode 先跟随系统，Desktop 端继续保留手动切换。',
      { senderId: 'member-echo', senderName: 'Echo' }
    ),
    sourceMessage(
      'msg-url-1',
      'conv-engineering',
      base + 360,
      '排障说明在 https://docs.example.invalid/guide/image-export?from=wechat ，不要把真实日志贴到公开 issue。',
      { senderId: 'member-echo', senderName: 'Echo' }
    ),
    sourceMessage(
      'msg-file-1',
      'conv-filehelper',
      base + 420,
      '已上传 release-checklist-v2.1.9.xlsx，发布前把 macOS 和 Windows 两栏都勾完。',
      {
        senderId: 'self-fixture',
        senderName: '我',
        attachment: { name: 'release-checklist-v2.1.9.xlsx', kind: 'file', sizeBytes: 20480 }
      }
    ),
    sourceMessage(
      'msg-tech-mcp',
      'conv-engineering',
      base + 480,
      'MCP Reader 只暴露只读查询；写入操作必须经过本地确认，不能让 Agent 直接改微信数据。',
      { senderId: 'member-q', senderName: 'Q' }
    ),
    sourceMessage(
      'msg-tech-react',
      'conv-engineering',
      base + 540,
      'React 列表先做虚拟滚动，Electron 主进程不要把十万条消息一次性发给 renderer。',
      { senderId: 'member-q', senderName: 'Q' }
    ),
    sourceMessage(
      'msg-tech-sqlite',
      'conv-engineering',
      base + 600,
      'SQLite FTS5 的 trigram 对中文子串更友好，但短词仍要有精确匹配补偿。',
      { senderId: 'member-lan', senderName: '蓝图同学' }
    ),
    sourceMessage(
      'msg-number-email-path',
      'conv-operations',
      base + 660,
      '工单 48291 请发给 fixture@example.invalid；测试附件放到 /tmp/wechat-fixture/export-preview/，不要使用个人目录。',
      { senderId: 'member-ops', senderName: '运营小组' }
    ),
    sourceMessage('msg-short-1', 'conv-family', base + 720, '收到，明早十点。', {
      senderId: 'member-yu',
      senderName: '小雨'
    }),
    sourceMessage('msg-short-noise', 'conv-family', base + 780, '好的，晚安。', {
      senderId: 'member-yu',
      senderName: '小雨'
    }),
    sourceMessage('msg-voice-long-1', 'conv-project-sync', base + 840, '[语音消息]', {
      senderId: 'member-voice',
      senderName: '语音同学',
      kind: 'voice',
      voiceTranscript:
        '刚才同步一下长语音结论：本周不做向量检索，也不新增记忆页面。先把现有问问微信的关键词检索放进独立 Knowledge Worker，索引只读取原始数据库，结果必须保留 messageId、会话、发送人和时间，异常时继续使用旧搜索。'
    }),
    sourceMessage(
      'msg-decision-1',
      'conv-project-sync',
      base + 900,
      '决定先上 FTS，不接 Embedding：先验证中文、文件名和技术词的召回，再考虑下一阶段。',
      { senderId: 'member-voice', senderName: '语音同学' }
    ),
    sourceMessage(
      'msg-url-noise',
      'conv-engineering',
      base + 960,
      '本周会议链接仍然走内部日历，不要混在发布文档里。',
      { senderId: 'member-echo', senderName: 'Echo' }
    ),
    sourceMessage(
      'msg-file-noise',
      'conv-filehelper',
      base + 1020,
      '旧版 release-note.txt 仅供历史核对，不要再上传。',
      { senderId: 'self-fixture', senderName: '我' }
    ),
    sourceMessage(
      'msg-long-text-1',
      'conv-project-sync',
      base + 1080,
      '补充记录：当索引仍在建立或 Worker 发生异常，界面行为不能中断。主进程需要保留旧关键词检索作为临时回退，但 renderer 不应重新批量加载全部会话消息。等索引完成后，Evidence 应统一由知识库返回，并能跳回原聊天。',
      { senderId: 'member-lan', senderName: '蓝图同学' }
    )
  ]

  const cases: RealisticBenchmarkCase[] = [
    {
      id: 'cn-continuous',
      category: 'chinese-continuous',
      question: '图片导出失败时应该怎样避免用户误以为图片丢失？',
      searchTerms: ['原图链接', '缩略图'],
      expectedMessageIds: ['msg-cn-continuous-1']
    },
    {
      id: 'cn-short',
      category: 'chinese-short',
      question: '周六谁带咖啡？',
      searchTerms: ['周六见', '咖啡'],
      expectedMessageIds: ['msg-cn-short-1']
    },
    {
      id: 'person-name',
      category: 'person-name',
      question: '林澈最近补了什么？',
      searchTerms: ['林澈', '签名检查'],
      expectedMessageIds: ['msg-person-1']
    },
    {
      id: 'mixed-language',
      category: 'mixed-language',
      question: 'dark mode 在 Web 和 Desktop 分别怎么处理？',
      searchTerms: ['dark mode', 'Desktop'],
      expectedMessageIds: ['msg-mixed-1']
    },
    {
      id: 'url',
      category: 'url',
      question: '图片导出排障文档的网址是什么？',
      searchTerms: ['docs.example.invalid/guide/image-export'],
      expectedMessageIds: ['msg-url-1']
    },
    {
      id: 'file-name',
      category: 'file-name',
      question: '发布检查表文件叫什么？',
      searchTerms: ['release-checklist-v2.1.9.xlsx'],
      expectedMessageIds: ['msg-file-1']
    },
    {
      id: 'technical-mcp',
      category: 'technical-term',
      question: 'MCP Reader 的写入限制是什么？',
      searchTerms: ['MCP Reader', '只读查询'],
      expectedMessageIds: ['msg-tech-mcp']
    },
    {
      id: 'technical-react-electron',
      category: 'technical-term',
      question: 'React 和 Electron 的大量消息处理原则是什么？',
      searchTerms: ['React', 'Electron'],
      expectedMessageIds: ['msg-tech-react']
    },
    {
      id: 'technical-sqlite',
      category: 'technical-term',
      question: 'SQLite 的中文全文检索要选什么？',
      searchTerms: ['SQLite FTS5', 'trigram'],
      expectedMessageIds: ['msg-tech-sqlite']
    },
    {
      id: 'number-email-path',
      category: 'number-email-path',
      question: '工单 48291 的邮箱和测试附件目录在哪？',
      searchTerms: ['48291', 'fixture@example.invalid', '/tmp/wechat-fixture/export-preview'],
      expectedMessageIds: ['msg-number-email-path']
    },
    {
      id: 'short-message',
      category: 'short-message',
      question: '约的是几点？',
      searchTerms: ['十点'],
      expectedMessageIds: ['msg-short-1']
    },
    {
      id: 'long-voice',
      category: 'long-voice',
      question: '长语音里对 Knowledge Worker 和 fallback 的要求是什么？',
      searchTerms: ['Knowledge Worker', '旧搜索'],
      expectedMessageIds: ['msg-voice-long-1']
    },
    {
      id: 'decision',
      category: 'long-voice',
      question: '为什么暂时不接 Embedding？',
      searchTerms: ['不接 Embedding', 'FTS'],
      expectedMessageIds: ['msg-decision-1']
    },
    {
      id: 'fallback',
      category: 'long-voice',
      question: '索引未完成时搜索如何处理？',
      searchTerms: ['Worker 发生异常', '旧关键词检索'],
      expectedMessageIds: ['msg-long-text-1']
    }
  ]

  const grouped = new Map<string, KnowledgeSourceMessage[]>()
  for (const item of messages) {
    const current = grouped.get(item.conversationId) || []
    current.push(item)
    grouped.set(item.conversationId, current)
  }
  return {
    conversations: Array.from(grouped.entries()).map(([conversationId, source]) => ({
      conversationId,
      completeSnapshot: true,
      messages: source
    })),
    cases
  }
}
