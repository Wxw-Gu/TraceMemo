/**
 * Markdown 表格的降级渲染。
 *
 * 结果栏很窄，真表格在这里只会列宽错位、长字段换行难读。提示词已经禁止模型为
 * 检索结果产表格，但**历史回答**与其它入口仍可能出现，所以渲染层必须保证它
 * 不会横向炸出容器，且内容读得出来。
 *
 * 这里的做法是把它降级成逐行的键值列表（每格一个 span，靠 CSS flex-wrap 换行），
 * 而不是渲染 `<table>` —— 没有 table 就不会有列宽挤压与横向溢出。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../src/renderer/src/components/search/searchMarkdown'

function renderValue(value: string): HTMLElement {
  const { container } = render(<div>{renderMarkdown(value)}</div>)
  return container
}

describe('Markdown 表格降级渲染', () => {
  it('表格行渲染成逐格的键值单元，而不是 <table>', () => {
    const container = renderValue('| 发送人 | 时间 | 图片中的文字 |')

    expect(container.querySelector('table')).toBeNull()
    const row = container.querySelector('.ai-search-markdown-table-row')
    expect(row).not.toBeNull()
    const cells = container.querySelectorAll('.ai-search-markdown-table-cell')
    expect(cells).toHaveLength(3)
    expect(cells[0].textContent).toBe('发送人')
    expect(cells[2].textContent).toBe('图片中的文字')
  })

  it('分隔行（|---|---|）不产生内容', () => {
    const container = renderValue('|---|---|')

    expect(container.querySelectorAll('.ai-search-markdown-table-cell')).toHaveLength(0)
    expect(container.querySelector('.ai-search-markdown-spacer')).not.toBeNull()
  })

  it('超长单元格文本原样保留，不截断也不丢字', () => {
    const longText = '这是一段很长的识别文本'.repeat(12)
    const container = renderValue(`| 用户A | ${longText} |`)

    const cells = container.querySelectorAll('.ai-search-markdown-table-cell')
    expect(cells).toHaveLength(2)
    expect(cells[1].textContent).toBe(longText)
  })

  it('普通段落与列表不受影响', () => {
    const container = renderValue('这是一段普通说明\n\n1. 第一条\n2. 第二条')

    expect(container.querySelector('.ai-search-markdown-table-row')).toBeNull()
    expect(screen.getByText('这是一段普通说明')).toBeVisible()
    expect(container.querySelectorAll('.ai-search-markdown-list-item')).toHaveLength(2)
  })
})
