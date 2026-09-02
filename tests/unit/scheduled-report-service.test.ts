import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-test-user-data' } }))
import {
  calculateNextRunAt,
  ScheduledReportService,
  validateScheduleTime
} from '../../src/main/services/scheduled-report-service'
import type { AgentHubStatus } from '../../src/shared/agent-hub'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'
import type { GeneratedReportRecord } from '../../src/shared/report-history'
import type {
  ScheduledReportExecution,
  ScheduledReportNotification
} from '../../src/shared/scheduled-report'
import type { ScheduledReportDependencies } from '../../src/main/services/scheduled-report-service'

const capability: PersonalWechatSendCapability = {
  supported: true,
  ready: true,
  status: 'ready',
  capabilities: { text: true, image: true, voice: true },
  senderStatus: {} as never,
  message: 'ready'
}

const unavailableCapability: PersonalWechatSendCapability = {
  ...capability,
  ready: false,
  status: 'needs_verification',
  capabilities: { text: false, image: false, voice: false },
  message: '请先完成微信消息能力检测'
}

const reportRecord = (pngPath: string): GeneratedReportRecord => ({
  id: 'report-1',
  contactId: 'group-md5',
  contactName: '研发群',
  dateRange: '昨日',
  messageCount: 12,
  generatedAt: '2026-08-27T01:00:00.000Z',
  reportDate: '2026-08-26',
  pngPath,
  htmlPath: `${pngPath}.html`,
  htmlStatus: 'ready' as const,
  pngStatus: 'ready' as const
})

function makeDependencies(overrides: Record<string, unknown> = {}): ScheduledReportDependencies {
  return {
    getCapability: async () => capability,
    generateReport: async () => ({
      success: true,
      groupName: '研发群',
      pngPath: '/tmp/generated.png',
      messageCount: 12
    }),
    saveGeneratedReport: async () => ({
      success: true,
      record: reportRecord('/tmp/saved.png')
    }),
    send: async () => ({ success: true, status: capability.senderStatus }),
    sendNotification: async () => ({ success: true, status: 'sent' as const }),
    getNotificationRecipient: () => 'owner-wxid',
    isDatabaseReady: () => true,
    ...overrides
  }
}

async function enableNotifications(storageDir: string): Promise<void> {
  await writeFile(join(storageDir, 'settings.json'), JSON.stringify({ enabled: true }))
}

async function runScheduled(
  service: ScheduledReportService,
  taskId: string
): Promise<ScheduledReportExecution> {
  const task = (await service.listTasks()).find((item) => item.id === taskId)
  if (!task) throw new Error('scheduled task not found')
  await service.tick(new Date(Date.parse(task.nextRunAt) + 1_000))
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const execution = (await service.listExecutions(taskId))[0]
    if (execution && execution.status !== 'running') return execution
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('scheduled execution did not finish')
}

const onlineAgentHubStatus = (): AgentHubStatus => ({
  hub: 'online' as const,
  connector: 'online' as const,
  updatedAt: Date.now()
})

describe('scheduled report scheduling', () => {
  it('validates daily HH:mm and computes the next local occurrence', () => {
    expect(validateScheduleTime('09:05')).toBe(true)
    expect(validateScheduleTime('24:00')).toBe(false)
    const from = new Date('2026-08-27T10:00:00+08:00')
    expect(calculateNextRunAt('09:05', from)).toBe('2026-08-28T01:05:00.000Z')
    expect(calculateNextRunAt('11:05', from)).toBe('2026-08-27T03:05:00.000Z')
  })

  it('defaults notification settings to off and persists a successful enablement', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-settings-'))
    const sendNotification = vi.fn(async () => ({ success: true, status: 'sent' as const }))
    const service = new ScheduledReportService({
      storageDir,
      getAgentHubStatus: onlineAgentHubStatus,
      getNotificationRecipient: () => 'owner-wxid',
      sendNotification
    })

    await expect(service.getNotificationSettings()).resolves.toEqual({ enabled: false })
    const enabled = await service.setNotificationEnabled(true)

    expect(enabled).toEqual({ success: true, data: { enabled: true } })
    expect(sendNotification).toHaveBeenCalledWith({
      to: 'owner-wxid',
      text: `✅ TraceMemo 定时日报通知已开启

以后定时日报生成或发送出现异常时，
我会通过这里通知你。`
    })
    const restored = new ScheduledReportService({ storageDir })
    await expect(restored.getNotificationSettings()).resolves.toEqual({ enabled: true })
    await expect(service.setNotificationEnabled(false)).resolves.toEqual({
      success: true,
      data: { enabled: false }
    })
    await expect(restored.getNotificationSettings()).resolves.toEqual({ enabled: true })
    const afterClose = new ScheduledReportService({ storageDir })
    await expect(afterClose.getNotificationSettings()).resolves.toEqual({ enabled: false })
  })

  it.each([
    {
      name: 'rejects an offline Agent Hub',
      status: { hub: 'offline' as const, connector: 'online' as const, updatedAt: Date.now() },
      recipient: 'owner-wxid',
      reason: 'agent_hub_offline' as const
    },
    {
      name: 'rejects an offline connector',
      status: { hub: 'online' as const, connector: 'disconnected' as const, updatedAt: Date.now() },
      recipient: 'owner-wxid',
      reason: 'connector_offline' as const
    },
    {
      name: 'rejects a missing notification recipient',
      status: onlineAgentHubStatus(),
      recipient: undefined,
      reason: 'recipient_not_bound' as const
    }
  ])('$name before saving enabled=true', async ({ status, recipient, reason }) => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-capability-'))
    const sendNotification = vi.fn()
    const service = new ScheduledReportService({
      storageDir,
      getAgentHubStatus: () => status,
      getNotificationRecipient: () => recipient,
      sendNotification
    })

    const result = await service.setNotificationEnabled(true)

    expect(result).toMatchObject({ success: false, data: { enabled: false }, reason })
    expect(sendNotification).not.toHaveBeenCalled()
    await expect(service.getNotificationSettings()).resolves.toEqual({ enabled: false })
  })

  it('does not enable notifications when the real test send fails', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-send-test-'))
    const sendNotification = vi.fn(async () => ({
      success: false,
      status: 'send_failed' as const,
      error: '连接器返回 500'
    }))
    const service = new ScheduledReportService({
      storageDir,
      getAgentHubStatus: onlineAgentHubStatus,
      getNotificationRecipient: () => 'owner-wxid',
      sendNotification
    })

    const result = await service.setNotificationEnabled(true)

    expect(result).toMatchObject({
      success: false,
      data: { enabled: false },
      reason: 'send_failed',
      error: '连接器返回 500'
    })
    await expect(service.getNotificationSettings()).resolves.toEqual({ enabled: false })
  })

  it('persists lifecycle, executes generation and image sending, and restores tasks', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-'))
    const now = new Date('2026-08-27T01:00:00.000Z')
    const generatedPath = join(storageDir, 'report.png')
    let generated = 0
    let sent = 0
    const saveHistory = vi.fn().mockResolvedValue({ success: true })
    const service = new ScheduledReportService({
      storageDir,
      now: () => now,
      getCapability: async () => capability,
      generateReport: async () => {
        generated += 1
        return { success: true, pngPath: generatedPath }
      },
      send: async () => {
        sent += 1
        return { success: true, status: capability.senderStatus }
      },
      saveGeneratedReport: saveHistory,
      isDatabaseReady: () => true
    })
    const created = await service.createTask({
      name: '每日群报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })
    expect(created.success).toBe(true)
    expect(created.data?.reportRange).toBe('yesterday')
    const taskId = created.data!.id
    const run = await service.runScheduledReportNow(taskId)
    expect(run.data?.status).toBe('success')
    expect(generated).toBe(1)
    expect(sent).toBe(1)
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        contactName: '研发群',
        reportDate: undefined,
        pngPath: generatedPath,
        messageCount: 0
      })
    )
    expect(await service.listExecutions(taskId)).toHaveLength(1)
    const restored = new ScheduledReportService({
      storageDir,
      getCapability: async () => capability
    })
    expect((await restored.listTasks())[0].id).toBe(taskId)
    await service.setTaskEnabled(taskId, false)
    expect((await service.listTasks())[0].enabled).toBe(false)
    await service.deleteTask(taskId)
    expect(await service.listTasks()).toHaveLength(0)
    expect(
      JSON.parse(await readFile(join(storageDir, 'executions.json'), 'utf8'))[0].message
    ).toContain('微信发送成功')
  })

  it('passes a selected today range through a scheduled 20:00 execution', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-today-'))
    let currentTime = new Date(2026, 7, 27, 19, 59, 0)
    const generateReport = vi.fn(async () => ({
      success: true,
      groupName: '研发群',
      pngPath: '/tmp/generated.png',
      messageCount: 1
    }))
    const service = new ScheduledReportService({
      storageDir,
      now: () => currentTime,
      getCapability: async () => capability,
      generateReport,
      saveGeneratedReport: async () => ({ success: true, record: reportRecord('/tmp/saved.png') }),
      send: async () => ({ success: true, status: capability.senderStatus }),
      isDatabaseReady: () => true
    })
    const created = await service.createTask({
      name: '今日日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '20:00',
      reportRange: 'today'
    })
    expect(created.success).toBe(true)
    currentTime = new Date(2026, 7, 27, 20, 0, 0)

    const execution = await runScheduled(service, created.data!.id)

    expect(execution.status).toBe('success')
    expect(generateReport).toHaveBeenCalledWith(
      expect.objectContaining({ group: '研发群', range: 'today' })
    )
  })

  it('does not send a generated report when history persistence fails', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-history-'))
    const generatedPath = join(storageDir, 'report.png')
    const send = vi.fn().mockResolvedValue({ success: true, status: capability.senderStatus })
    const service = new ScheduledReportService({
      storageDir,
      getCapability: async () => capability,
      generateReport: async () => ({ success: true, pngPath: generatedPath }),
      saveGeneratedReport: vi.fn().mockResolvedValue({ success: false, error: '磁盘不可写' }),
      send,
      isDatabaseReady: () => true
    })
    const created = await service.createTask({
      name: '历史失败日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })

    const result = await service.runScheduledReportNow(created.data!.id)

    expect(result.success).toBe(false)
    expect(result.data?.error).toContain('report_history_save_failed:磁盘不可写')
    expect(send).not.toHaveBeenCalled()
  })

  it('records manual failures without creating user notifications', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-manual-error-'))
    const sendNotification = vi.fn()
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({
        sendNotification,
        generateReport: async () => ({
          success: false,
          error: 'maximum context length exceeded',
          errorStage: 'ai' as const
        })
      })
    })
    const created = await service.createTask({
      name: '手动失败日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })

    const result = await service.runScheduledReportNow(created.data!.id)

    expect(result.data).toMatchObject({ status: 'failed', triggerType: 'manual' })
    expect(result.data?.notificationStatus).toBe('not_needed')
    expect(sendNotification).not.toHaveBeenCalled()
    expect(await service.listNotifications()).toHaveLength(0)
  })

  it('sends a debug scheduled failure notification without generating or sending a report', async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), 'tracememo-scheduled-report-debug-notification-')
    )
    await enableNotifications(storageDir)
    const generateReport = vi.fn()
    const send = vi.fn()
    const sendNotification = vi.fn(async () => ({ success: true, status: 'sent' as const }))
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({ generateReport, send, sendNotification })
    })
    const created = await service.createTask({
      name: '调试日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })

    const result = await service.testScheduledReportErrorNotification(created.data!.id)

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      taskId: created.data!.id,
      triggerType: 'scheduled',
      status: 'failed',
      errorCode: 'DEBUG_TEST_NOTIFICATION',
      notificationStatus: 'sent'
    })
    expect(result.data?.technicalMessage).toContain('没有调用 AI')
    expect(generateReport).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(sendNotification).toHaveBeenCalledWith({
      to: 'owner-wxid',
      text: expect.stringContaining('定时日报错误通知测试')
    })
    expect(await service.listNotifications()).toHaveLength(1)
  })

  it('turns NO_MESSAGES into a neutral skipped execution without notification', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-no-messages-'))
    await enableNotifications(storageDir)
    const sendNotification = vi.fn(async () => ({ success: true, status: 'sent' as const }))
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({
        sendNotification,
        getAgentHubStatus: onlineAgentHubStatus,
        generateReport: async () => ({
          success: false,
          error: '所选时间范围没有可总结的消息',
          errorCode: 'NO_MESSAGES',
          errorStage: 'data' as const
        })
      })
    })
    const created = await service.createTask({
      name: '空消息日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })

    const execution = await runScheduled(service, created.data!.id)

    expect(execution).toMatchObject({
      status: 'skipped',
      errorCode: 'NO_MESSAGES',
      userTitle: '暂无可生成的日报',
      userMessage: '所选时间范围内没有可总结的聊天消息。',
      notificationStatus: 'not_needed'
    })
    expect(sendNotification).not.toHaveBeenCalled()
    expect(await service.listNotifications()).toHaveLength(0)
  })

  it('suppresses pending notifications when disabled and does not flush them after reopening', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-suppressed-'))
    await enableNotifications(storageDir)
    let hubStatus = onlineAgentHubStatus()
    const sendNotification = vi.fn(async () => ({
      success: false,
      status: 'connector_offline' as const,
      error: '连接器暂时不可用'
    }))
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({
        getAgentHubStatus: () => hubStatus,
        sendNotification,
        send: async () => ({
          success: false,
          status: capability.senderStatus,
          error: '连接器暂时不可用'
        })
      })
    })
    const created = await service.createTask({
      name: '待关闭通知日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })
    expect(await service.getNotificationSettings()).toEqual({ enabled: true })
    const execution = await runScheduled(service, created.data!.id)
    expect(execution.notificationStatus).toBe('pending')
    expect(await service.listNotifications()).toEqual([
      expect.objectContaining({ status: 'pending' })
    ])

    await expect(service.setNotificationEnabled(false)).resolves.toMatchObject({
      success: true,
      data: { enabled: false }
    })
    expect(await service.listNotifications()).toEqual([
      expect.objectContaining({ status: 'suppressed' })
    ])

    hubStatus = onlineAgentHubStatus()
    sendNotification.mockResolvedValue({ success: true, status: 'sent' })
    await expect(service.setNotificationEnabled(true)).resolves.toMatchObject({
      success: true,
      data: { enabled: true }
    })
    expect(sendNotification).toHaveBeenCalledTimes(2)
    expect((await service.listNotifications())[0].status).toBe('suppressed')
  })

  it('suppresses stale pending notifications when already disabled', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-stale-pending-'))
    const notification: ScheduledReportNotification = {
      id: 'notification-1',
      executionId: 'execution-1',
      taskId: 'task-1',
      type: 'failure',
      severity: 'error',
      title: '日报发送失败',
      message: '连接器暂时不可用',
      dedupeKey: 'execution-1:failure',
      channel: 'agent_hub',
      recipient: 'owner-wxid',
      status: 'pending',
      createdAt: '2026-09-02T02:00:00.000Z',
      attempts: 0
    }
    await writeFile(join(storageDir, 'notifications.json'), JSON.stringify([notification]))
    const service = new ScheduledReportService({
      storageDir,
      now: () => new Date('2026-09-02T03:00:00.000Z')
    })

    await expect(service.setNotificationEnabled(false)).resolves.toEqual({
      success: true,
      data: { enabled: false }
    })
    expect(await service.listNotifications()).toEqual([
      expect.objectContaining({
        status: 'suppressed',
        suppressedAt: '2026-09-02T03:00:00.000Z',
        lastError: '定时日报微信异常通知已关闭。'
      })
    ])
  })

  it('allows creating and executing a report when personal WeChat is unavailable', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-waiting-'))
    await enableNotifications(storageDir)
    const generateReport = vi.fn(async () => ({
      success: true,
      pngPath: '/tmp/generated.png',
      groupName: '研发群'
    }))
    const saveHistory = vi.fn(async () => ({
      success: true as const,
      record: reportRecord('/tmp/saved.png')
    }))
    const send = vi.fn()
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({
        getCapability: async () => unavailableCapability,
        generateReport,
        saveGeneratedReport: saveHistory,
        send
      })
    })

    const created = await service.createTask({
      name: '未发送日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })
    expect(created.success).toBe(true)

    const execution = await runScheduled(service, created.data!.id)

    expect(execution).toMatchObject({
      status: 'waiting_to_send',
      errorCode: 'WECHAT_SEND_UNAVAILABLE',
      pngPath: '/tmp/saved.png',
      reportId: 'report-1',
      sendStatus: 'unavailable',
      notificationStatus: 'not_needed'
    })
    expect(generateReport).toHaveBeenCalledOnce()
    expect(saveHistory).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
    expect(await service.listNotifications()).toHaveLength(0)
  })

  it('keeps a generated report waiting without creating a notification when sending is unavailable', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-send-block-'))
    await enableNotifications(storageDir)
    const sendAction = vi.fn(async () => ({
      actionId: 'send-unavailable-action',
      status: 'failed' as const,
      decision: 'allow' as const,
      errorCode: 'SEND_CAPABILITY_UNAVAILABLE' as const,
      reason: '当前微信发送能力不可用',
      startedAt: '2026-08-27T01:00:00.000Z',
      finishedAt: '2026-08-27T01:00:01.000Z'
    }))
    const sendNotification = vi.fn()
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({ sendAction, sendNotification })
    })
    const created = await service.createTask({
      name: '发送能力未就绪日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })

    const execution = await runScheduled(service, created.data!.id)

    expect(execution).toMatchObject({
      status: 'waiting_to_send',
      errorCode: 'WECHAT_SEND_UNAVAILABLE',
      sendStatus: 'unavailable',
      notificationStatus: 'not_needed',
      pngPath: '/tmp/saved.png'
    })
    expect(sendNotification).not.toHaveBeenCalled()
    expect(await service.listNotifications()).toHaveLength(0)
  })

  it('keeps unavailable sending waiting on retry without creating a notification', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-send-retry-'))
    await enableNotifications(storageDir)
    const sendAction = vi.fn(async () => ({
      actionId: 'send-unavailable-action',
      status: 'failed' as const,
      decision: 'allow' as const,
      errorCode: 'SEND_CAPABILITY_UNAVAILABLE' as const,
      reason: '当前微信发送能力不可用',
      startedAt: '2026-08-27T01:00:00.000Z',
      finishedAt: '2026-08-27T01:00:01.000Z'
    }))
    const sendNotification = vi.fn()
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({ sendAction, sendNotification })
    })
    const created = await service.createTask({
      name: '发送能力未就绪重试日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })
    const first = await runScheduled(service, created.data!.id)

    const retried = await service.retryScheduledReportSend(first.id)

    expect(retried.data).toMatchObject({
      status: 'waiting_to_send',
      errorCode: 'WECHAT_SEND_UNAVAILABLE',
      retryCount: 1,
      sendStatus: 'unavailable',
      notificationStatus: 'not_needed'
    })
    expect(sendAction).toHaveBeenCalledTimes(2)
    expect(sendNotification).not.toHaveBeenCalled()
    expect(await service.listNotifications()).toHaveLength(0)
  })

  it('keeps notifications pending when no reliable recipient is available', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-no-recipient-'))
    await enableNotifications(storageDir)
    const sendNotification = vi.fn()
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({
        send: async () => ({
          success: false,
          status: capability.senderStatus,
          error: '微信发送失败'
        }),
        getNotificationRecipient: () => undefined,
        sendNotification
      })
    })
    const created = await service.createTask({
      name: '待通知日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })

    const execution = await runScheduled(service, created.data!.id)
    const [notification] = await service.listNotifications()

    expect(execution.notificationStatus).toBe('pending')
    expect(notification).toMatchObject({ status: 'pending', attempts: 0 })
    expect(notification.recipient).toBeUndefined()
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('keeps notifications pending when Agent Hub delivery fails', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-hub-offline-'))
    await enableNotifications(storageDir)
    const sendNotification = vi.fn(async () => ({
      success: false,
      status: 'connector_offline' as const,
      error: 'Agent Hub 连接器不可用'
    }))
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({
        send: async () => ({
          success: false,
          status: capability.senderStatus,
          error: '微信发送失败'
        }),
        sendNotification
      })
    })
    const created = await service.createTask({
      name: '连接器异常日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })

    const execution = await runScheduled(service, created.data!.id)
    const [notification] = await service.listNotifications()

    expect(execution.notificationStatus).toBe('pending')
    expect(notification).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'Agent Hub 连接器不可用'
    })
    expect(sendNotification).toHaveBeenCalledOnce()
  })

  it('keeps the generated artifact when the image send attempt fails', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-partial-'))
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({
        send: vi.fn(async () => ({
          success: false,
          status: capability.senderStatus,
          error: '连接器响应超时'
        }))
      })
    })
    const created = await service.createTask({
      name: '发送失败日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })

    const result = await service.runScheduledReportNow(created.data!.id)

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      status: 'partial_success',
      errorCode: 'WECHAT_SEND_FAILED',
      pngPath: '/tmp/saved.png',
      sendStatus: 'failed',
      sendTarget: '研发群@chatroom'
    })
  })

  it('routes scheduled report sends and retries through the Action Gateway adapter', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-gateway-'))
    const send = vi.fn()
    const sendAction = vi
      .fn()
      .mockResolvedValueOnce({
        actionId: 'action-1',
        status: 'failed' as const,
        decision: 'allow' as const,
        errorCode: 'SEND_FAILED' as const,
        reason: '连接器暂时不可用',
        startedAt: '2026-08-27T01:00:00.000Z',
        finishedAt: '2026-08-27T01:00:01.000Z'
      })
      .mockResolvedValueOnce({
        actionId: 'action-2',
        status: 'sent' as const,
        decision: 'allow' as const,
        startedAt: '2026-08-27T01:01:00.000Z',
        finishedAt: '2026-08-27T01:01:01.000Z'
      })
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({ send, sendAction })
    })
    const created = await service.createTask({
      name: 'Gateway 日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })

    const first = await runScheduled(service, created.data!.id)
    const recovered = await service.retryScheduledReportSend(first.id)

    expect(first).toMatchObject({
      status: 'partial_success',
      pngPath: '/tmp/saved.png',
      sendTarget: '研发群@chatroom'
    })
    expect(recovered.data).toMatchObject({ status: 'success', retryCount: 1 })
    expect(send).not.toHaveBeenCalled()
    expect(sendAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: '研发群@chatroom',
        filePath: '/tmp/saved.png',
        triggerType: 'scheduled',
        executionId: first.id,
        taskId: created.data!.id
      })
    )
    expect(sendAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: '研发群@chatroom',
        filePath: '/tmp/saved.png',
        triggerType: 'scheduled',
        executionId: first.id,
        retryCount: 1,
        taskId: created.data!.id
      })
    )
  })

  it('retries an existing PNG without generating the report again', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-retry-'))
    await enableNotifications(storageDir)
    const generateReport = vi.fn(async () => ({
      success: true,
      pngPath: '/tmp/generated.png',
      groupName: '研发群'
    }))
    let sendCount = 0
    const send = vi.fn(async (request: { filePath: string }) => {
      sendCount += 1
      if (sendCount === 1) {
        return { success: false, status: capability.senderStatus, error: '连接器暂时不可用' }
      }
      expect(request.filePath).toBe('/tmp/saved.png')
      return { success: true, status: capability.senderStatus }
    })
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({ generateReport, send })
    })
    const created = await service.createTask({
      name: '可恢复日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })
    const first = { data: await runScheduled(service, created.data!.id) }
    const recovered = await service.retryScheduledReportSend(first.data!.id)

    expect(first.data?.status).toBe('partial_success')
    expect(recovered).toMatchObject({
      success: true,
      data: { status: 'success', sendStatus: 'success', retryCount: 1 }
    })
    expect(recovered.data).not.toHaveProperty('error')
    expect(recovered.data).not.toHaveProperty('errorCode')
    expect(recovered.data).not.toHaveProperty('failedStage')
    expect(recovered.data).not.toHaveProperty('technicalMessage')
    expect(recovered.data).not.toHaveProperty('sendError')
    expect(generateReport).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(2)
    expect((await service.listNotifications()).map((item) => item.type)).toContain('recovery')
  })

  it('deduplicates repeated failure notifications for one execution', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-dedupe-'))
    await enableNotifications(storageDir)
    const send = vi.fn(async () => ({
      success: false,
      status: capability.senderStatus,
      error: '连接器暂时不可用'
    }))
    const sendNotification = vi.fn(async () => ({ success: true, status: 'sent' as const }))
    const service = new ScheduledReportService({
      storageDir,
      ...makeDependencies({ send, sendNotification })
    })
    const created = await service.createTask({
      name: '重复失败日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })

    const first = { data: await runScheduled(service, created.data!.id) }
    const retried = await service.retryScheduledReportSend(first.data!.id)

    expect(retried.data?.status).toBe('partial_success')
    expect(await service.listNotifications()).toHaveLength(1)
    expect(sendNotification).toHaveBeenCalledOnce()
  })

  it('normalizes AI and unknown generation failures without a fake WeChat error', async () => {
    const contextService = new ScheduledReportService({
      storageDir: await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-context-')),
      ...makeDependencies({
        generateReport: async () => ({
          success: false,
          error: 'maximum context length exceeded',
          errorStage: 'ai' as const
        })
      })
    })
    const contextTask = await contextService.createTask({
      name: '上下文日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })
    const contextResult = await contextService.runScheduledReportNow(contextTask.data!.id)
    expect(contextResult.data).toMatchObject({ errorCode: 'AI_CONTEXT_LIMIT', failedStage: 'ai' })
    expect(contextResult.data?.error).not.toContain('wechat_not_ready')

    const unknownService = new ScheduledReportService({
      storageDir: await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-unknown-')),
      ...makeDependencies({
        generateReport: async () => {
          throw new Error('unexpected generation failure')
        }
      })
    })
    const unknownTask = await unknownService.createTask({
      name: '未知错误日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })
    const unknownResult = await unknownService.runScheduledReportNow(unknownTask.data!.id)
    expect(unknownResult.data).toMatchObject({ errorCode: 'UNKNOWN', failedStage: 'report' })
    expect(unknownResult.data?.error).not.toContain('wechat_not_ready')
  })

  it('keeps old execution records readable and claims one scheduled slot once', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-compat-'))
    const oldExecution: ScheduledReportExecution = {
      id: 'old-execution',
      taskId: 'old-task',
      startedAt: '2026-08-27T01:00:00.000Z',
      finishedAt: '2026-08-27T01:01:00.000Z',
      status: 'failed',
      error: 'report_generation_failed:旧错误',
      message: '旧错误'
    }
    await writeFile(join(storageDir, 'executions.json'), JSON.stringify([oldExecution]))
    const generated = vi.fn(async () => ({ success: true, pngPath: '/tmp/generated.png' }))
    const service = new ScheduledReportService({
      storageDir,
      now: () => new Date('2026-08-27T01:00:00.000Z'),
      ...makeDependencies({ generateReport: generated })
    })
    expect(await service.listExecutions()).toEqual([
      expect.objectContaining({ triggerType: 'scheduled', retryCount: 0 })
    ])
    const created = await service.createTask({
      name: '幂等日报',
      group: '研发群',
      target: '研发群@chatroom',
      scheduleTime: '09:00'
    })
    const dueAt = new Date(created.data!.nextRunAt)
    await service.tick(new Date(dueAt.getTime() + 1_000))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await service.tick(new Date(dueAt.getTime() + 2_000))

    expect(generated).toHaveBeenCalledOnce()
    expect(
      (await service.listExecutions()).filter((item) => item.taskId === created.data!.id)
    ).toHaveLength(1)
  })
})
