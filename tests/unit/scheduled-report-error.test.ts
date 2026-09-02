import { describe, expect, it } from 'vitest'
import { normalizeScheduledReportError } from '../../src/shared/scheduled-report-error'

describe('scheduled report error normalizer', () => {
  it('maps provider context, quota, auth, timeout and availability errors', () => {
    expect(
      normalizeScheduledReportError({
        error: 'maximum context length exceeded',
        stage: 'ai'
      }).code
    ).toBe('AI_CONTEXT_LIMIT')
    expect(
      normalizeScheduledReportError({
        error: 'insufficient_quota',
        code: 'insufficient_quota',
        status: 429,
        stage: 'ai'
      }).code
    ).toBe('AI_QUOTA_EXCEEDED')
    expect(
      normalizeScheduledReportError({
        error: 'Invalid API key',
        status: 401,
        stage: 'ai'
      }).code
    ).toBe('AI_AUTH_INVALID')
    expect(normalizeScheduledReportError({ error: 'AI 请求超时', stage: 'ai' }).code).toBe(
      'AI_TIMEOUT'
    )
    expect(
      normalizeScheduledReportError({ error: 'fetch failed: ECONNREFUSED', stage: 'ai' }).code
    ).toBe('AI_PROVIDER_UNAVAILABLE')
  })

  it('maps legacy errors and keeps unknown errors unknown', () => {
    expect(normalizeScheduledReportError('wechat_not_ready:needs_verification').code).toBe(
      'WECHAT_SEND_UNAVAILABLE'
    )
    expect(normalizeScheduledReportError({ error: 'connector timeout', stage: 'send' }).code).toBe(
      'WECHAT_SEND_FAILED'
    )
    expect(normalizeScheduledReportError({ error: 'unexpected', stage: 'report' })).toMatchObject({
      code: 'UNKNOWN',
      stage: 'report',
      retryable: true
    })
  })

  it('does not expose provider credentials in technical details', () => {
    expect(
      normalizeScheduledReportError({
        error: 'Bearer secret-token sk-test_secret',
        stage: 'ai'
      }).technicalMessage
    ).toBe('Bearer [已隐藏] ***')
  })
})
