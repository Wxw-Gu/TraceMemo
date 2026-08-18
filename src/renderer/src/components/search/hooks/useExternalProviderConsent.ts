import { useEffect, useRef, useState } from 'react'

export type ExternalProviderConsent = {
  providerName: string
  recipient: string
}

export function useExternalProviderConsent(): {
  externalProviderConsent: ExternalProviderConsent | null
  requestExternalProviderConsent: (providerName: string, recipient: string) => Promise<boolean>
  settleExternalProviderConsent: (approved: boolean) => void
  clearExternalProviderConsent: () => void
} {
  const [externalProviderConsent, setExternalProviderConsent] =
    useState<ExternalProviderConsent | null>(null)
  const externalConsentResolverRef = useRef<((approved: boolean) => void) | null>(null)

  const settleExternalProviderConsent = (approved: boolean): void => {
    const resolve = externalConsentResolverRef.current
    externalConsentResolverRef.current = null
    setExternalProviderConsent(null)
    resolve?.(approved)
  }

  const requestExternalProviderConsent = (
    providerName: string,
    recipient: string
  ): Promise<boolean> =>
    new Promise((resolve) => {
      externalConsentResolverRef.current = resolve
      setExternalProviderConsent({ providerName, recipient })
    })

  const clearExternalProviderConsent = (): void => {
    settleExternalProviderConsent(false)
  }

  useEffect(
    () => () => {
      externalConsentResolverRef.current?.(false)
      externalConsentResolverRef.current = null
    },
    []
  )

  useEffect(() => {
    if (!externalProviderConsent) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') settleExternalProviderConsent(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [externalProviderConsent])

  return {
    externalProviderConsent,
    requestExternalProviderConsent,
    settleExternalProviderConsent,
    clearExternalProviderConsent
  }
}
