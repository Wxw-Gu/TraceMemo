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

/**
 * 默认不真的等。
 *
 * 内置规则的 `replyDelaySeconds` 默认是 2 秒，如果每条例都真 sleep，
 * 这个文件会平白多出几十秒。**等待语义**由「回复前等待」那组用例显式覆盖。
 */
const noDelay = async (): Promise<void> => {}

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
  delay?: (ms: number) => Promise<void>
}): {
  runner: AutomationActionRunner
  calls: WechatActionRequest[]
  reports: Array<{ group: string; range?: string }>
} {
  const calls: WechatActionRequest[] = []
  const reports: Array<{ group: string; range?: string }> = []
  const runner = new AutomationActionRunner({
    now: fakeClock(),
    delay: options.delay ?? noDelay,
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
    // 跳过必须写清「是因为前置那步挂了」，否则用户看到「已跳过」会以为规则没配好。
    expect(result.steps.find((step) => step.key === 'send')?.skipReason).toContain('前置步骤失败')
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

  it('规则没启用「发送日报图片」时，该步 skipped 且整体仍算成功（情况 A）', async () => {
    const { runner, calls, reports } = buildRunner({})
    const rule = makeRule((item) => {
      item.actions = item.actions.filter((action) => action.type !== 'sendReportImage')
    })
    const result = await run(runner, rule)

    expect(result.status).toBe('success')
    expect(statusOf(result, 'reply')).toBe('success')
    expect(statusOf(result, 'report')).toBe('success')
    expect(statusOf(result, 'send')).toBe('skipped')
    // 没配发送就只发了一条回复，不该有多余的图片请求。
    expect(calls).toHaveLength(1)
    expect(calls[0].content.type).toBe('text')
    expect(reports).toHaveLength(1)
  })

  it('规则要求发送图片、但手上没有图片时判失败，不允许静默跳过（情况 B）', async () => {
    const { runner, calls } = buildRunner({})
    // 只留 reply + send：没有 generateReport ⇒ 永远拿不到 pngPath。
    const rule = makeRule((item) => {
      item.actions = item.actions.filter((action) => action.type !== 'generateReport')
    })
    const result = await run(runner, rule)

    expect(statusOf(result, 'report')).toBe('skipped')
    expect(statusOf(result, 'send')).toBe('failed')
    // 关键：整次执行必须是 failed（合并分支会把它错记成 success）。
    expect(result.status).toBe('failed')
    const sendStep = result.steps.find((step) => step.key === 'send')
    expect(sendStep?.error).toContain('日报图片未生成')
    // 而且**绝不**退而求其次去发别的东西：只有那条文字回复出去过。
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
      delay: noDelay,
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

  /**
   * 回复前等待：规则一命中就秒回看起来像机器人，所以它是**规则自己的一项执行参数**
   * （`rule.replyDelaySeconds`，在「编辑自动化 → 3 · 触发后执行」里配），
   * 而不是全局设置 —— 不同规则可以不一样。
   *
   * 这一组锁三件事：等待真的发生在回复之前、等待不计入回复步骤耗时、
   * 以及「不该等的时候一步都不等」。
   */
  it('回复等待发生在发送回复之前，顺序为 等待 → 回复 → 日报 → 图片', async () => {
    const order: string[] = []
    const delay = vi.fn(async (ms: number) => {
      order.push(`delay:${ms}`)
    })
    const runner = new AutomationActionRunner({
      now: fakeClock(),
      delay,
      executeAction: async (request) => {
        order.push(`send:${request.content.type}`)
        return sentResult()
      },
      generateReport: async () => {
        order.push('report')
        return { success: true, pngPath: '/tmp/report.png' }
      }
    })

    await run(
      runner,
      makeRule((rule) => {
        rule.replyDelaySeconds = 2
      })
    )

    expect(delay).toHaveBeenCalledTimes(1)
    expect(delay).toHaveBeenCalledWith(2_000)
    expect(order).toEqual(['delay:2000', 'send:text', 'report', 'send:image'])
  })

  it('等待不计入「回复确认」这一步的耗时', async () => {
    const { runner } = buildRunner({ delay: noDelay })
    const result = await run(
      runner,
      makeRule((rule) => {
        rule.replyDelaySeconds = 2
      })
    )

    // fakeClock 每调用一次进 5ms：reply 从 startedAt 到 finishedAt 只跨一次 now()。
    const replyStep = result.steps.find((step) => step.key === 'reply')
    expect(replyStep?.durationMs).toBe(5)
  })

  it('等待为 0 时完全不等待；字段缺失（旧版 rules.json）按默认 2 秒', async () => {
    const delay = vi.fn(noDelay)
    const { runner } = buildRunner({ delay })

    await run(
      runner,
      makeRule((rule) => {
        rule.replyDelaySeconds = 0
      })
    )
    expect(delay).not.toHaveBeenCalled()

    // 历史规则里没有这个字段：按默认 2 秒处理，而不是凭空变成「不等待」。
    await run(
      runner,
      makeRule((rule) => {
        delete (rule as { replyDelaySeconds?: number }).replyDelaySeconds
      })
    )
    expect(delay).toHaveBeenCalledWith(2_000)
  })

  it('回复动作被关掉时不再空等', async () => {
    const delay = vi.fn(noDelay)
    const { runner } = buildRunner({ delay })

    await run(
      runner,
      makeRule((rule) => {
        rule.replyDelaySeconds = 2
        for (const action of rule.actions) {
          if (action.type === 'replyText') action.enabled = false
        }
      })
    )

    expect(delay).not.toHaveBeenCalled()
  })
})
