import { useEffect, useState } from 'react'
import type { AppUpdateState } from '../../../../shared/app-update'

const INITIAL_UPDATE_STATE: AppUpdateState = {
  status: 'idle',
  currentVersion: '读取中...',
  delivery: 'automatic'
}

export function useAppUpdateState(): AppUpdateState {
  const [state, setState] = useState<AppUpdateState>(INITIAL_UPDATE_STATE)

  useEffect(() => {
    let active = true
    void window.api.getAppUpdateState().then((nextState) => {
      if (active) setState(nextState)
    })
    const unsubscribe = window.api.onAppUpdateState((nextState) => {
      if (active) setState(nextState)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}
