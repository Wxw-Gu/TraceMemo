import { describe, expect, it } from 'vitest'
import { parsePocInvocation, parsePocQuestion } from '../../src/main/query-agent-poc-cli'

describe('Query Agent POC CLI 参数解析', () => {
  it('移除开头的分隔符 --', () => {
    expect(parsePocQuestion(['--', '我和BOBO第一次聊了什么'])).toBe('我和BOBO第一次聊了什么')
  })

  it('没有分隔符时保持原样', () => {
    expect(parsePocQuestion(['我和BOBO第一次聊了什么'])).toBe('我和BOBO第一次聊了什么')
  })

  it('不删除问题正文中间的合法 --', () => {
    expect(parsePocQuestion(['测试', '--', '内容'])).toBe('测试 -- 内容')
  })

  it('开头分隔符只移除一个，后续 -- 仍是正文', () => {
    expect(parsePocQuestion(['--', '--', '内容'])).toBe('-- 内容')
    expect(parsePocQuestion(['--', 'a', '--', 'b'])).toBe('a -- b')
  })

  it('多段参数按空格拼接，并去掉首尾空白', () => {
    expect(parsePocQuestion(['  ', 'BOBO', '上个月', '有没有给我发过文件  '])).toBe('BOBO 上个月 有没有给我发过文件')
  })

  it('只有分隔符或空参数时返回空字符串', () => {
    expect(parsePocQuestion(['--'])).toBe('')
    expect(parsePocQuestion([])).toBe('')
  })

  it('不修改传入的数组', () => {
    const argv = ['--', '问题']
    parsePocQuestion(argv)
    expect(argv).toEqual(['--', '问题'])
  })
})

describe('parsePocInvocation — 诊断模式与搜索范围', () => {
  it('无 --tool 时是自然语言模式，并把 --scope 从问题里剥掉', () => {
    expect(parsePocInvocation(['我和 BOBO 第一次聊了什么'])).toMatchObject({
      kind: 'question',
      question: '我和 BOBO 第一次聊了什么'
    })
    const scoped = parsePocInvocation([
      '--scope',
      '{"kind":"groups"}',
      '最近谁聊过健身'
    ])
    expect(scoped).toMatchObject({ kind: 'question', question: '最近谁聊过健身' })
    if (scoped.kind !== 'question') throw new Error('unreachable')
    expect(scoped.scope).toEqual({ kind: 'groups' })
  })

  it('裸工具模式把 scope 合并进工具参数（Host 注入，LLM 提供不了）', () => {
    const invocation = parsePocInvocation([
      '--tool',
      'search_messages',
      '--args',
      '{"timeRange":{"kind":"all"},"query":"健身"}',
      '--scope',
      '{"kind":"groups"}'
    ])
    if (invocation.kind !== 'tool') throw new Error('unreachable')
    expect(invocation.toolName).toBe('search_messages')
    expect(invocation.args).toMatchObject({ query: '健身', scope: { kind: 'groups' } })
  })

  it('非法 scope / 缺少 conversationId 会明确报错', () => {
    expect(() => parsePocInvocation(['--scope', '{"kind":"nope"}', 'x'])).toThrow(/scope.kind/)
    expect(() => parsePocInvocation(['--scope', '{"kind":"contact"}', 'x'])).toThrow(/conversationId/)
    expect(() => parsePocInvocation(['--scope', 'not-json', 'x'])).toThrow(/合法 JSON/)
  })
})
