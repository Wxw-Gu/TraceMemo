import { describe, expect, it } from 'vitest'
import { parsePocQuestion } from '../../src/main/query-agent-poc-cli'

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
