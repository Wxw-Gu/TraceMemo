import { describe, expect, it } from 'vitest'
import { markdownToPlainText } from '../../src/renderer/src/components/search/searchMarkdown'

describe('AI Search Markdown clipboard text', () => {
  it('removes presentation markup while retaining structure and evidence references', () => {
    expect(
      markdownToPlainText(
        '## 摘要\n\n**结论**：查看 `训练安排` [E1]\n\n- *训练时间*：中午\n- [详情](https://example.test)'
      )
    ).toBe('摘要\n\n结论：查看 训练安排 [E1]\n\n• 训练时间：中午\n• 详情 (https://example.test)')
  })
})
