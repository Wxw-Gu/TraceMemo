import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_REPORT_IMAGE_POSTFIX_TEXT } from '../../../../shared/personal-wechat'

export function useReportImagePostfixSetting(enabled: boolean): {
  postfixText: string
  setPostfixText: (value: string) => void
  persistPostfixText: () => Promise<void>
} {
  const [postfixText, setPostfixText] = useState(DEFAULT_REPORT_IMAGE_POSTFIX_TEXT)

  useEffect(() => {
    if (!enabled) return
    const getSettings = window.api.getSettings
    if (typeof getSettings !== 'function') return
    let active = true
    void getSettings()
      .then((result) => {
        if (!active) return
        setPostfixText(
          String(result.settings.reportImagePostfixText ?? DEFAULT_REPORT_IMAGE_POSTFIX_TEXT)
        )
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [enabled])

  const persistPostfixText = useCallback(async (): Promise<void> => {
    const setSettings = window.api.setSettings
    if (typeof setSettings !== 'function') return
    await setSettings({ reportImagePostfixText: postfixText })
  }, [postfixText])

  return { postfixText, setPostfixText, persistPostfixText }
}
