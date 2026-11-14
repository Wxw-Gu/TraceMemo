import { beforeEach, expect, it, vi } from 'vitest'
import { requestChatGPTPlan } from '../../src/main/services/chatgpt-plan-service'

const { getSession, streamResponse } = vi.hoisted(() => ({
  getSession: vi.fn(),
  streamResponse: vi.fn()
}))

vi.mock('@siwc/local', () => ({
  createChatGPT: () => ({ getSession, streamResponse })
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/fixture' },
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
  shell: {}
}))

beforeEach(() => {
  getSession.mockResolvedValue({ sharing: true, profileId: 'fixture-profile' })
  streamResponse.mockResolvedValue({ text: 'OK' })
})

it('maps system guidance to developer input and waits for a completed response', async () => {
  const result = await requestChatGPTPlan('chatgpt-plan:fixture-profile', 'fixture-model', [
    { role: 'system', content: 'Be concise' },
    { role: 'user', content: 'Summarize fixture data' }
  ])
  expect(result).toEqual({ success: true, data: 'OK', finishReason: 'stop' })
  expect(streamResponse).toHaveBeenCalledWith({
    model: 'fixture-model',
    input: [
      { role: 'developer', content: 'Be concise' },
      { role: 'user', content: 'Summarize fixture data' }
    ],
    signal: expect.any(AbortSignal)
  })
})

it.each([
  { sharing: false, profileId: 'fixture-profile' },
  { sharing: true, profileId: 'different-profile' }
])('rejects missing plan permission or an account switch before inference', async (session) => {
  getSession.mockResolvedValue(session)
  const result = await requestChatGPTPlan('chatgpt-plan:fixture-profile', 'fixture-model', [])
  expect(result.success).toBe(false)
  expect(streamResponse).not.toHaveBeenCalled()
})

it('reports an interrupted stream as a failure', async () => {
  streamResponse.mockRejectedValue(new Error('fixture stream interrupted'))
  const result = await requestChatGPTPlan('chatgpt-plan:fixture-profile', 'fixture-model', [])
  expect(result).toEqual({ success: false, error: expect.any(String) })
})
