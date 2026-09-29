import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { REPORT_TEMPLATE_FRAGMENT_CONTRACT_CSS } from '../../src/shared/report-template-fragment-contract'

/**
 * hero 头像的几何只有一份权威。
 *
 * 生产导出会注入 `report-template-fragment-contract.ts`，其中
 * `img.tm-avatar.tm-avatar--hero` 用 `!important` 把头像钉在
 * `clamp(28px, var(--tm-avatar-hero-size, 40px), 56px)`。
 * 如果模板再给容器写死一个尺寸（旧版 `.avatar-grid` 是 58x58、单头像 28x28），
 * 两边就会打架：头像实际 40px，2 列 x 40px + 3px gap = 83px 塞不进 58px 的盒子，
 * 头像向右向下溢出容器，视觉上越过卡片内边距 —— 这就是"日报头像超出范围"。
 *
 * 这里断言的是**不变量**，不是措辞：
 * 1. 容器尺寸必须来自 contract 的变量，不能写死；
 * 2. 容器的最小可用宽度必须能容纳 2 列头像（由变量算出来，而不是靠猜）；
 * 3. contract 提供的变量在容器里被真正引用（改名/改值不会静默分叉）。
 */

const HERO_AVATAR_GAP_PX = 3

const readResource = (file: string): string => readFileSync(resolve('resources', file), 'utf8')

/** 取出某个选择器的声明块（第一个匹配），返回声明文本。 */
const ruleBody = (css: string, selector: string): string => {
  const index = css.indexOf(selector)
  if (index < 0) throw new Error(`selector not found: ${selector}`)
  const open = css.indexOf('{', index)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) throw new Error(`unterminated rule: ${selector}`)
  return css.slice(open + 1, close)
}

/** contract 里 hero 头像的目标尺寸与变量名。 */
const contractHeroAvatar = (): { variable: string; fallbackPx: number } => {
  const name = /--tm-avatar-hero-size:\s*([\d.]+)px/.exec(REPORT_TEMPLATE_FRAGMENT_CONTRACT_CSS)
  expect(name, 'contract 必须声明 --tm-avatar-hero-size').not.toBeNull()
  const forced =
    /img\.tm-avatar\.tm-avatar--hero\s*\{[\s\S]*?var\((--tm-avatar-hero-size),\s*([\d.]+)px\)/.exec(
      REPORT_TEMPLATE_FRAGMENT_CONTRACT_CSS
    )
  expect(forced, 'contract 必须用变量 + px 兜底约束 hero 头像').not.toBeNull()
  return { variable: forced![1], fallbackPx: Number(forced![2] || name![1]) }
}

const LEGACY_TEMPLATES = ['mobile_daily_report_v1.html', 'mobile_daily_report_v2.html']

describe('日报 hero 头像几何 — 容器与 contract 不得分叉', () => {
  it('contract 通过变量约束 hero 头像尺寸（含 px 兜底）', () => {
    const { variable, fallbackPx } = contractHeroAvatar()
    expect(variable).toBe('--tm-avatar-hero-size')
    expect(fallbackPx).toBeGreaterThanOrEqual(28)
    expect(fallbackPx).toBeLessThanOrEqual(56)
    // 必须带 !important，否则模板的 width/height 会盖掉它，几何又会分裂
    const heroRule = /img\.tm-avatar\.tm-avatar--hero\s*\{[\s\S]*?\}/.exec(
      REPORT_TEMPLATE_FRAGMENT_CONTRACT_CSS
    )![0]
    expect(heroRule).toContain('!important')
  })

  for (const file of LEGACY_TEMPLATES) {
    describe(file, () => {
      const css = readResource(file)

      it('avatar-grid 不再写死容器尺寸（写死就会小于头像本身）', () => {
        const body = ruleBody(css, '.avatar-grid {')
        expect(body, '容器写死 width 会让 40px 头像溢出').not.toMatch(/(^|\s)width\s*:/)
        expect(body, '容器写死 height 会让第二行头像纵向溢出').not.toMatch(/(^|\s)height\s*:/)
      })

      it('列宽与行高都取 contract 的同一个变量', () => {
        const { variable, fallbackPx } = contractHeroAvatar()
        const body = ruleBody(css, '.avatar-grid {')
        expect(body).toContain('grid-template-columns')
        expect(body).toContain('grid-auto-rows')
        // 变量名与兜底值都必须和 contract 一致 —— 否则主题化会分叉
        expect(body).toContain(`var(${variable}, ${fallbackPx}px)`)
      })

      it('单头像时列宽等于一个头像，不再用 28px 的窄盒子', () => {
        const { variable, fallbackPx } = contractHeroAvatar()
        const body = ruleBody(css, '.avatar-grid.avatar-count-1')
        expect(body).toContain('grid-template-columns')
        expect(body).toContain(`var(${variable}, ${fallbackPx}px)`)
        expect(body).not.toMatch(/(^|\s)width\s*:/)
        expect(body).not.toMatch(/(^|\s)height\s*:/)
      })

      it('按 contract 尺寸算出的两列簇宽不会被任何固定宽度切断', () => {
        const { fallbackPx } = contractHeroAvatar()
        const clusterWidth = fallbackPx * 2 + HERO_AVATAR_GAP_PX
        const body = ruleBody(css, '.avatar-grid {')
        const fixed = /(^|\s)width\s*:\s*(\d+(?:\.\d+)?)px/.exec(body)
        // 既没有固定宽度，也不存在比簇宽更小的固定宽度
        if (fixed) expect(Number(fixed[2])).toBeGreaterThanOrEqual(clusterWidth)
        expect(clusterWidth).toBeLessThanOrEqual(430 - 2 * 12 - 2 * 20 - 14)
      })
    })
  }
})
