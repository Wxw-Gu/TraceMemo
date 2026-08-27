import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-test-user-data' } }))
import {
  calculateNextRunAt,
  ScheduledReportService,
  validateScheduleTime
} from '../../src/main/services/scheduled-report-service'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'

const capability: PersonalWechatSendCapability = {
  supported: true,
  ready: true,
  status: 'ready',
  capabilities: { text: true, image: true, voice: true },
  senderStatus: {} as never,
  message: 'ready'
}

describe('scheduled report scheduling', () => {
  it('validates daily HH:mm and computes the next local occurrence', () => {
    expect(validateScheduleTime('09:05')).toBe(true)
    expect(validateScheduleTime('24:00')).toBe(false)
    const from = new Date('2026-08-27T10:00:00+08:00')
    expect(calculateNextRunAt('09:05', from)).toBe('2026-08-28T01:05:00.000Z')
    expect(calculateNextRunAt('11:05', from)).toBe('2026-08-27T03:05:00.000Z')
  })

  it('persists lifecycle, executes generation and image sending, and restores tasks', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-report-'))
    const now = new Date('2026-08-27T01:00:00.000Z')
    const generatedPath = join(storageDir, 'report.png')
    let generated = 0
    let sent = 0
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
})
