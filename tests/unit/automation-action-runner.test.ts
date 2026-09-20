import { describe, expect, it, vi } from 'vitest'

/**
 * runner 本身不碰 electron，但它的模块图会加载 `agent-group-report-service`，
 * 那条链上的 `report-template-service` / `settings-store` 在**模块加载时**就会调
 * `app.getPath()`。所以这里必须给 electron 一个替身，否则 import 阶段就炸。
 *
 * 用一个固定字符串即可 —— 这些服务只把它当路径前缀拼，不会真的读写。
 */
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/wxe-automation-runner-fixture' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  AUTOMATION_SEND_PURPOSE,
  createDefaultDailyReportRule,
  type AutomationRule,
  type AutomationStepKey
} from '../../src/shared/automation'
import type { WechatActionRequest, WechatActionResult } from '../../src/shared/wechat-action'
import { AutomationActionRunner } from '../../src/main/services/automation-action-runner'
import type { AgentGroupReportResult } from '../../src/main/services/agent-group-report-service'

/**
 * ActionRunner 的步骤语义。
 *
 * 这一层最重要的性质只有两条：
 * 1. 顺序是 reply → report → send；
 * 2. **失败必须切断后续** —— 日报没出来就绝不能继续发图。
 */

const EXECUTION_ID = 'exec-fixture-1'
const GROUP_ID = '12345678@chatroom'

function makeRule(mutate?: (rule: AutomationRule) => void): AutomationRule {
  const rule = createDefaultDailyReportRule(0)
  mutate?.(rule)
  return rule
}

/** 单调递增的假时钟，让 durationMs 可预测。 */
function fakeClock(step = 5): () => number {
  let value = 1_700_000_000_000
  return () => {
    value += step
    return value
  }
}

function sentResult(): WechatActionResult {
  return {
    actionId: 'action-1',
    status: 'sent',
    decision: 'allow',
    startedAt: '2026-09-20T10:00:00.000Z',
    finishedAt: '2026-09-20T10:00:01.000Z'
  }
}

function failedResult(code: string, reason: string): WechatActionResult {
  return {
    actionId: 'action-1',
    status: 'failed',
    decision: 'allow',
    errorCode: code,
    reason,
    startedAt: '2026-09-20T10:00:00.000Z',
    finishedAt: '2026-09-20T10:00:01.000Z'
  }
}

function buildRunner(options: {
  executeAction?: (request: WechatActionRequest) => Promise<WechatActionResult>
  generateReport?: () => Promise<AgentGroupReportResult>
}): {
  runner: AutomationActionRunner
  calls: WechatActionRequest[]
  reports: Array<{ group: string; range?: string }>
} {
  const calls: WechatActionRequest[] = []
  const reports: Array<{ group: string; range?: string }> = []
  const runner = new AutomationActionRunner({
    now: fakeClock(),
    executeAction: async (request) => {
      calls.push(request)
      return options.executeAction ? options.executeAction(request) : sentResult()
    },
    generateReport: async (request) => {
      reports.push({ group: request.group, ...(request.range ? { range: request.range } : {}) })
      return options.generateReport ? options.generateReport() : { success: true, pngPath: '/tmp/report.png' }
    }
  })
  return { runner, calls, reports }
}

const run = (
  runner: AutomationActionRunner,
  rule: AutomationRule
): Promise<Awaited<ReturnType<AutomationActionRunner['run']>>> =>
  runner.run({
    executionId: EXECUTION_ID,
    rule,
    conversationId: GROUP_ID,
    isGroup: true,
    sourceDisplayName: '测试群'
  })

const statusOf = (
  result: Awaited<ReturnType<AutomationActionRunner['run']>>,
  key: AutomationStepKey
): string => result.steps.find((step) => step.key === key)?.status ?? 'missing'

describe('AutomationActionRunner', () => {
  it('按 收到消息 → 规则匹配 → 回复确认 → 生成日报 → 发送图片 的顺序执行', async () => {
    const { runner, calls, reports } = buildRunner({})
    const result = await run(runner, makeRule())

    expect(result.status).toBe('success')
    expect(result.pngPath).toBe('/tmp/report.png')
    expect(result.steps.map((step) => step.key)).toEqual([
      'received',
      'matched',
      'reply',
      'report',
      'send'
    ])
    expect(result.steps.map((step) => step.status)).toEqual([
      'success',
      'success',
      'success',
      'success',
      'success'
    ])

    // 先回文字，再发图片 —— 顺序反了用户会先收到图再收到"正在生成"。
    expect(calls).toHaveLength(2)
    expect(calls[0].content.type).toBe('text')
    expect(calls[1].content.type).toBe('image')
    expect(reports).toEqual([{ group: GROUP_ID, range: 'today' }])
  })

  it('每一步都带独立的起止时间与耗时', async () => {
    const { runner } = buildRunner({})
    const result = await run(runner, makeRule())
    for (const step of result.steps) {
      expect(step.startedAt).toBeTypeOf('number')
      expect(step.finishedAt).toBeTypeOf('number')
      expect(step.durationMs).toBeGreaterThanOrEqual(0)
      expect(step.finishedAt! >= step.startedAt!).toBe(true)
    }
    // matched 比 received 晚开始，说明确实是顺序执行而非一次性补写。
    expect(result.steps[1].startedAt!).toBeGreaterThan(result.steps[0].startedAt!)
  })

  it('发送请求带上正确的 purpose / 幂等键 / 收件人', async () => {
    const { runner, calls } = buildRunner({})
    await run(runner, makeRule())

    expect(calls[0].purpose).toBe(AUTOMATION_SEND_PURPOSE.reply)
    expect(calls[0].idempotencyKey).toBe(`${AUTOMATION_SEND_PURPOSE.reply}:${EXECUTION_ID}`)
    expect(calls[1].purpose).toBe(AUTOMATION_SEND_PURPOSE.report)
    expect(calls[1].idempotencyKey).toBe(`${AUTOMATION_SEND_PURPOSE.report}:${EXECUTION_ID}`)
    for (const call of calls) {
      expect(call.origin).toBe('automation')
      expect(call.triggerType).toBe('automation')
      expect(call.recipient).toMatchObject({ type: 'group', id: GROUP_ID, name: '测试群' })
    }
  })

  it('生成日报失败时，发送图片被跳过而不是继续乱发', async () => {
    const { runner, calls } = buildRunner({
      generateReport: async () => ({ success: false, error: '所选时间范围没有可总结的消息' })
    })
    const result = await run(runner, makeRule())

    expect(result.status).toBe('failed')
    expect(statusOf(result, 'reply')).toBe('success')
    expect(statusOf(result, 'report')).toBe('failed')
    expect(statusOf(result, 'send')).toBe('skipped')
    expect(result.errorSummary).toBe('所选时间范围没有可总结的消息')
    // 只发过那条文字回复，图片一次都没发。
    expect(calls).toHaveLength(1)
    expect(calls[0].content.type).toBe('text')
  })

  it('生成日报抛异常时同样记 failed 并跳过发送', async () => {
    const { runner } = buildRunner({
      generateReport: async () => {
        throw new Error('AI 服务不可达')
      }
    })
    const result = await run(runner, makeRule())
    expect(statusOf(result, 'report')).toBe('failed')
    expect(statusOf(result, 'send')).toBe('skipped')
    expect(result.steps.find((step) => step.key === 'report')?.error).toBe('AI 服务不可达')
  })

  it('发送图片失败时整次执行判为失败并保留原因', async () => {
    let callIndex = 0
    const { runner } = buildRunner({
      executeAction: async () => {
        callIndex += 1
        return callIndex === 1
          ? sentResult()
          : failedResult('SEND_NOT_READY', '')
      }
    })
    const result = await run(runner, makeRule())
    expect(result.status).toBe('failed')
    expect(statusOf(result, 'send')).toBe('failed')
    expect(result.errorSummary).toBe('微信发送能力尚未就绪，请先绑定个人微信')
  })

  it('回复确认失败时，生成日报与发送都被跳过', async () => {
    const { runner, calls, reports } = buildRunner({
      executeAction: async () => failedResult('SEND_CAPABILITY_UNAVAILABLE', '当前环境没有可用的微信发送能力')
    })
    const result = await run(runner, makeRule())

    expect(statusOf(result, 'reply')).toBe('failed')
    expect(statusOf(result, 'report')).toBe('skipped')
    expect(statusOf(result, 'send')).toBe('skipped')
    expect(calls).toHaveLength(1)
    expect(reports).toHaveLength(0)
  })

  it('未启用回复确认时该步 skipped，但不阻断后面的日报与发送', async () => {
    const { runner, calls } = buildRunner({})
    const rule = makeRule((item) => {
      item.actions = item.actions.filter((action) => action.type !== 'replyText')
    })
    const result = await run(runner, rule)

    expect(result.status).toBe('success')
    expect(statusOf(result, 'reply')).toBe('skipped')
    expect(statusOf(result, 'report')).toBe('success')
    expect(statusOf(result, 'send')).toBe('success')
    expect(calls).toHaveLength(1)
    expect(calls[0].content.type).toBe('image')
  })

  it('未启用生成日报时，发送图片也必须 skipped（不能凭空发图）', async () => {
    const { runner, calls, reports } = buildRunner({})
    const rule = makeRule((item) => {
      item.actions = item.actions.filter((action) => action.type !== 'generateReport')
    })
    const result = await run(runner, rule)

    expect(statusOf(result, 'report')).toBe('skipped')
    expect(statusOf(result, 'send')).toBe('skipped')
    expect(reports).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].content.type).toBe('text')
  })

  it('只生成不发送时，日报步骤仍记成功', async () => {
    const { runner, reports } = buildRunner({})
    const rule = makeRule((item) => {
      item.actions = item.actions.filter((action) => action.type !== 'sendReportImage')
    })
    const result = await run(runner, rule)

    expect(result.status).toBe('success')
    expect(statusOf(result, 'report')).toBe('success')
    expect(statusOf(result, 'send')).toBe('skipped')
    expect(reports).toHaveLength(1)
  })

  it('回复文案为空时回落到内置默认文案', async () => {
    const { runner, calls } = buildRunner({})
    const rule = makeRule((item) => {
      item.actions = item.actions.map((action) =>
        action.type === 'replyText' ? { ...action, text: '   ' } : action
      )
    })
    await run(runner, rule)
    expect(calls[0].content).toEqual({ type: 'text', text: '收到，正在生成今日日报' })
  })

  it('私聊场景下收件人类型是联系人', async () => {
    const executeAction = vi.fn(async (_request: WechatActionRequest) => sentResult())
    const runner = new AutomationActionRunner({
      now: fakeClock(),
      executeAction,
      generateReport: async () => ({ success: true, pngPath: '/tmp/report.png' })
    })
    await runner.run({
      executionId: EXECUTION_ID,
      rule: makeRule((item) => {
        item.scope = 'direct'
      }),
      conversationId: 'wxid_friend',
      isGroup: false,
      sourceDisplayName: '李四'
    })
    expect(executeAction.mock.calls[0][0].recipient).toMatchObject({
      type: 'contact',
      id: 'wxid_friend'
    })
  })
})
