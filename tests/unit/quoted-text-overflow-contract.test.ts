import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * 引用内容（`.quoted-text`）的收缩不变量。
 *
 * 被引用的正文常见形态是「多行长文本被折成一行」——TraceMemo 自己发进群里的
 * 发言统计、导出任务日志都是这种。`.quoted-message` 是 flex 容器，
 * `.quote-message` 把引用框的宽度上限卡在 320px。
 *
 * 于是 `.quoted-text` 一旦写着 `flex: 0 0 auto`，它就会按 max-content 参与布局、
 * 一步都不肯缩：文本先越出引用框，再越出气泡，直接画到聊天背景上。
 *
 * jsdom 没有排版引擎，量不出「文本溢出容器」，所以这里锁的是**让溢出不可能发生的
 * 那几条声明**：可收缩（flex-shrink: 1 + min-width: 0）＋ 单行省略。
 */

const chatStyles = readFileSync(resolve('src/renderer/src/styles/chat.scss'), 'utf8')

/** 去掉注释，避免注释里的示例声明被当成真声明。 */
const withoutComments = chatStyles.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

/** 取出顶层选择器的声明块，返回声明文本。 */
const ruleBody = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 必须锚在行首且不留前导空格：`.quoted-message` 既是顶层选择器，
  // 也是 `.wechat-message-row { &.mine { … } }` 里嵌着的子选择器的后缀。
  const match = new RegExp(`^${escaped}[ \\t]*\\{`, 'm').exec(css)
  if (!match) throw new Error(`selector not found: ${selector}`)
  const open = css.indexOf('{', match.index)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) throw new Error(`unterminated rule: ${selector}`)
  return css.slice(open + 1, close)
}

describe('引用气泡 — 引用内容不得撑破引用框', () => {
  const body = ruleBody(withoutComments, '.quoted-text')

  it('引用内容必须可收缩', () => {
    expect(body, 'flex: 0 0 auto 会让长引用按 max-content 撑破引用框').not.toMatch(/flex:\s*0\s+0/)
    expect(body).toMatch(/flex:\s*0\s+1\s+auto/)
    expect(body, 'flex 项不给 min-width: 0 就缩不到内容宽度以下').toMatch(/min-width:\s*0/)
  })

  it('引用内容单行省略，与 `.quoted-sender` 和微信的引用样式一致', () => {
    expect(body).toMatch(/white-space:\s*nowrap/)
    expect(body).toMatch(/overflow:\s*hidden/)
    expect(body).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('引用框的宽度上限由容器决定，不受引用正文长短影响', () => {
    expect(ruleBody(withoutComments, '.quote-message')).toMatch(/max-width:\s*[\d.]+px/)
    expect(ruleBody(withoutComments, '.quoted-message')).toMatch(/max-width:\s*100%/)
  })
})

describe('引用气泡 — 名字优先，正文让位', () => {
  const body = ruleBody(withoutComments, '.quoted-sender')

  it('名字不参与收缩', () => {
    // flex 项按比例收缩：名字一旦可缩，长引用会把它压成半个字（只剩一个冒号）
    expect(body, 'flex-shrink: 1 会把名字压成一个字').not.toMatch(/flex:\s*0\s+1/)
    expect(body).toMatch(/flex:\s*0\s+0/)
  })

  it('名字有宽度上限，不能把正文挤没', () => {
    expect(body).toMatch(/max-width:\s*[\d.]+%/)
  })

  it('名字自带省略号，超长名字自己截断而不是撑破引用框', () => {
    expect(body).toMatch(/overflow:\s*hidden/)
    expect(body).toMatch(/text-overflow:\s*ellipsis/)
    expect(body).toMatch(/white-space:\s*nowrap/)
  })
})
