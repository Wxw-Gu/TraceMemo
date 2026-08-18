import { act, fireEvent, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExternalProviderConsent } from '../../src/renderer/src/components/search/hooks/useExternalProviderConsent'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useExternalProviderConsent', () => {
  it('opens consent with the current provider display state', () => {
    const { result } = renderHook(() => useExternalProviderConsent())

    act(() => {
      void result.current.requestExternalProviderConsent(
        'Remote Provider',
        'https://remote.example.test/v1'
      )
    })

    expect(result.current.externalProviderConsent).toEqual({
      providerName: 'Remote Provider',
      recipient: 'https://remote.example.test/v1'
    })
  })

  it('resolves true and clears the resolver when the user confirms', async () => {
    const { result } = renderHook(() => useExternalProviderConsent())
    let consent!: Promise<boolean>
    act(() => {
      consent = result.current.requestExternalProviderConsent('Provider', 'recipient')
    })

    act(() => result.current.settleExternalProviderConsent(true))

    await expect(consent).resolves.toBe(true)
    expect(result.current.externalProviderConsent).toBeNull()
  })

  it('resolves false and clears the resolver when the user rejects', async () => {
    const { result } = renderHook(() => useExternalProviderConsent())
    let consent!: Promise<boolean>
    act(() => {
      consent = result.current.requestExternalProviderConsent('Provider', 'recipient')
    })

    act(() => result.current.settleExternalProviderConsent(false))

    await expect(consent).resolves.toBe(false)
    expect(result.current.externalProviderConsent).toBeNull()
  })

  it('treats Escape as rejection and removes the temporary dialog state', async () => {
    const { result } = renderHook(() => useExternalProviderConsent())
    let consent!: Promise<boolean>
    act(() => {
      consent = result.current.requestExternalProviderConsent('Provider', 'recipient')
    })

    fireEvent.keyDown(window, { key: 'Escape' })

    await expect(consent).resolves.toBe(false)
    expect(result.current.externalProviderConsent).toBeNull()
  })

  it('clears a pending resolver when Search is cancelled', async () => {
    const { result } = renderHook(() => useExternalProviderConsent())
    let consent!: Promise<boolean>
    act(() => {
      consent = result.current.requestExternalProviderConsent('Provider', 'recipient')
    })

    act(() => result.current.clearExternalProviderConsent())

    await expect(consent).resolves.toBe(false)
    expect(result.current.externalProviderConsent).toBeNull()
  })

  it('leaves no resolver after the confirmed Search path succeeds', async () => {
    const { result } = renderHook(() => useExternalProviderConsent())
    let consent!: Promise<boolean>
    act(() => {
      consent = result.current.requestExternalProviderConsent('Provider', 'recipient')
    })
    act(() => result.current.settleExternalProviderConsent(true))

    await expect(consent).resolves.toBe(true)
    act(() => result.current.clearExternalProviderConsent())
    expect(result.current.externalProviderConsent).toBeNull()
  })

  it('leaves no resolver after the authorized Search path later fails', async () => {
    const { result } = renderHook(() => useExternalProviderConsent())
    let consent!: Promise<boolean>
    act(() => {
      consent = result.current.requestExternalProviderConsent('Provider', 'recipient')
    })
    act(() => result.current.settleExternalProviderConsent(true))

    await expect(consent).resolves.toBe(true)
    expect(result.current.externalProviderConsent).toBeNull()
  })

  it('resolves a pending consent as false and releases listeners on unmount', async () => {
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
    const { result, unmount } = renderHook(() => useExternalProviderConsent())
    let consent!: Promise<boolean>
    act(() => {
      consent = result.current.requestExternalProviderConsent('Provider', 'recipient')
    })

    unmount()

    await expect(consent).resolves.toBe(false)
    expect(removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function))
  })

  it('resolves the current request exactly once', async () => {
    const { result } = renderHook(() => useExternalProviderConsent())
    const resolved = vi.fn()
    let consent!: Promise<boolean>
    act(() => {
      consent = result.current.requestExternalProviderConsent('Provider', 'recipient')
      void consent.then(resolved)
    })

    act(() => {
      result.current.settleExternalProviderConsent(true)
      result.current.settleExternalProviderConsent(false)
    })

    await expect(consent).resolves.toBe(true)
    expect(resolved).toHaveBeenCalledOnce()
    expect(resolved).toHaveBeenCalledWith(true)
  })
})
