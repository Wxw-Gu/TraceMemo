import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWcdbDebugEnabled, wcdbDebugLog } from '../../src/main/wcdb-debug'

const originalDebugValue = process.env.WCDB_DEBUG_LOGS

afterEach(() => {
  if (originalDebugValue === undefined) delete process.env.WCDB_DEBUG_LOGS
  else process.env.WCDB_DEBUG_LOGS = originalDebugValue
  vi.restoreAllMocks()
})

describe('WCDB debug logging', () => {
  it('is disabled by default', () => {
    delete process.env.WCDB_DEBUG_LOGS
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    wcdbDebugLog('[GETMSG-001] hidden')

    expect(isWcdbDebugEnabled()).toBe(false)
    expect(log).not.toHaveBeenCalled()
  })

  it('logs when WCDB_DEBUG_LOGS is enabled', () => {
    process.env.WCDB_DEBUG_LOGS = '1'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    wcdbDebugLog('[GETMSG-001] visible')

    expect(isWcdbDebugEnabled()).toBe(true)
    expect(log).toHaveBeenCalledWith('[GETMSG-001] visible')
  })
})
