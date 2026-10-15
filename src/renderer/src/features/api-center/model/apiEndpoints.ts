import type { ApiEndpoint } from './types'
import { LOCAL_API_ENDPOINTS } from '../../../../../shared/local-api-test'

function endpoint(
  id: ApiEndpoint['id'],
  detail: Omit<ApiEndpoint, 'id' | 'method' | 'path'>
): ApiEndpoint {
  const { method, path } = LOCAL_API_ENDPOINTS[id]
  return { id, method, path, ...detail }
}

export const API_ENDPOINTS: ApiEndpoint[] = [
  endpoint('health', {
    name: '服务健康检查',
    description: '检查本地服务和数据库初始化状态。'
  }),
  endpoint('current-time', {
    name: '获取本地时间',
    description: '获取本机时区和当前时间。'
  }),
  endpoint('contact', {
    name: '联系人和群聊',
    description: '按昵称或类型查找联系人与群聊。',
    parameters: [
      { key: 'filter', label: '筛选关键词', placeholder: '昵称或备注' },
      { key: 'type', label: '类型', placeholder: 'user 或 group' }
    ]
  }),
  endpoint('chatroom', {
    name: '群聊列表',
    description: '按关键词获取群聊列表。',
    parameters: [{ key: 'keyword', label: '关键词', placeholder: '群昵称' }]
  }),
  endpoint('recent-chat', {
    name: '最近会话',
    description: '获取最近活跃会话。',
    parameters: [{ key: 'limit', label: '数量', placeholder: '50' }]
  }),
  endpoint('chatlog', {
    name: '聊天记录',
    description: '读取指定会话在指定时间范围内的消息。',
    parameters: [
      { key: 'talker', label: '会话标识', required: true, placeholder: '群昵称、wxid 或 md5' },
      { key: 'time', label: '时间范围', placeholder: '2026-07-13 或 2026-07-01~2026-07-13' },
      { key: 'startTime', label: '开始时间', placeholder: 'Unix 秒级时间戳' },
      { key: 'endTime', label: '结束时间', placeholder: 'Unix 秒级时间戳' }
    ]
  }),
  endpoint('group-snapshot', {
    name: '群成员快照',
    description: '获取群成员信息快照。',
    parameters: [{ key: 'md5', label: '群聊 md5', required: true, placeholder: '群聊 md5' }]
  }),
  endpoint('resolve', {
    name: '标识解析',
    description: '将昵称、wxid 或 md5 解析为会话信息。',
    parameters: [
      { key: 'q', label: '待解析标识', required: true, placeholder: '昵称、wxid 或 md5' }
    ]
  }),
  endpoint('app-capabilities', {
    name: '应用能力',
    description: '查看数据库、Query、Automation 与运行环境的能力状态。'
  }),
  endpoint('group-exit-monitor', {
    name: '退群监控状态',
    description: '查看监控开关、监控群范围、事件数量和运行状态。'
  }),
  endpoint('group-exit-monitor-update', {
    name: '配置退群监控',
    description: '设置监控群范围或启用/关闭退群监控，不会修改退群通知 Automation。',
    body: true
  }),
  endpoint('group-exit-events', {
    name: '退群事件历史',
    description: '按群和时间窗口查询退群事件，最多返回 200 条。',
    parameters: [
      { key: 'conversationId', label: '群会话 ID', placeholder: 'xxx@chatroom' },
      { key: 'since', label: '开始时间', placeholder: '2026-10-01T00:00:00+07:00' },
      { key: 'until', label: '结束时间', placeholder: '2026-10-02T23:59:59+07:00' },
      { key: 'limit', label: '数量上限', placeholder: '50，最大 200' }
    ]
  }),
  endpoint('group-member-stats', {
    name: '群成员活跃统计',
    description: '查询指定群在时间窗口内的活跃成员、沉默成员和数据完整性。',
    parameters: [
      { key: 'conversationId', label: '群会话 ID', required: true, placeholder: 'xxx@chatroom' },
      { key: 'start', label: '开始时间', required: true, placeholder: '2026-10-01T00:00:00+07:00' },
      { key: 'end', label: '结束时间', required: true, placeholder: '2026-10-02T23:59:59+07:00' }
    ]
  }),
  endpoint('automations', {
    name: '自动化规则',
    description: '列出自动化规则，可按类型和启用状态筛选。',
    parameters: [
      { key: 'type', label: '规则类型', placeholder: 'daily_report / scheduled_report / leave_notification' },
      { key: 'enabled', label: '启用状态', placeholder: 'true 或 false' }
    ]
  }),
  endpoint('automation-create', {
    name: '创建自动化规则',
    description: '创建一条默认停用的自动化规则。',
    body: true
  }),
  endpoint('automation-validate', {
    name: '校验自动化规则',
    description: '检查规则字段、目标标识和预计影响，不保存也不执行。',
    body: true
  }),
  endpoint('automation-executions', {
    name: '自动化执行记录',
    description: '分页上限内查询执行结果，可按规则、状态和时间筛选。',
    parameters: [
      { key: 'ruleId', label: '规则 ID', placeholder: 'ruleId' },
      { key: 'status', label: '状态', placeholder: 'running / success / failed' },
      { key: 'since', label: '开始时间', placeholder: '2026-10-01T00:00:00+07:00' },
      { key: 'until', label: '结束时间', placeholder: '2026-10-02T23:59:59+07:00' },
      { key: 'limit', label: '数量上限', placeholder: '50，最大 200' }
    ]
  }),
  endpoint('report', {
    name: '群聊日报导出',
    description: '通过内置模板导出群聊日报 HTML 与 PNG。',
    body: true
  }),
  endpoint('agent-status', {
    name: 'Agent Hub 状态',
    description: '检查 Agent Hub、微信连接器、本地数据 API 和数据库状态。'
  }),
  endpoint('agent-group-report', {
    name: '生成群聊总结图片',
    description: '读取指定群聊并生成今日、昨日或近 7 天的总结长图。',
    body: true
  }),
  endpoint('agent-send', {
    name: '微信发送测试',
    description: '测试文字或本地图片发送，并区分凭证失效、连接器离线和发送成功。',
    body: true
  })
]

export const DEFAULT_ENDPOINT = API_ENDPOINTS[0]

export function findEndpoint(id: string): ApiEndpoint {
  return API_ENDPOINTS.find((endpoint) => endpoint.id === id) || DEFAULT_ENDPOINT
}
