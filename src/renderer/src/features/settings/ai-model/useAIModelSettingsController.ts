import { useCallback, useEffect, useReducer, useRef } from 'react'
import type {
  AIProviderConfig,
  AIProviderSummary,
  AIRuntimeModelConfig
} from '../../../../../shared/ai-provider'
import { aiModelSettingsReducer, initialAIModelSettingsState } from './aiModelSettingsReducer'
import { createProviderFromPreset } from './presets'
import type { AIModelSettingsController } from './types'

export function useAIModelSettingsController({
  onRuntimeChange,
  onNotice
}: {
  onRuntimeChange: (config: AIRuntimeModelConfig) => void
  onNotice: (message: string) => void
}): AIModelSettingsController {
  const [state, dispatch] = useReducer(aiModelSettingsReducer, initialAIModelSettingsState)
  const onRuntimeChangeRef = useRef(onRuntimeChange)

  useEffect(() => {
    onRuntimeChangeRef.current = onRuntimeChange
  }, [onRuntimeChange])

  const refresh = useCallback(async (): Promise<void> => {
    const [list, runtime] = await Promise.all([
      window.api.listAIProviders(),
      window.api.getAIRuntimeConfig()
    ])
    if (!list.success) return dispatch({ type: 'ERROR', error: list.error || '供应商配置读取失败' })
    dispatch({ type: 'LOADED', providers: list.providers, runtime })
    onRuntimeChangeRef.current(runtime)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openNew = useCallback(() => {
    dispatch({ type: 'OPEN_EDITOR', editor: createProviderFromPreset(), presetId: 'deepseek' })
  }, [])
  const openEdit = useCallback((provider: AIProviderSummary) => {
    dispatch({
      type: 'OPEN_EDITOR',
      editor: {
        id: provider.id,
        name: provider.name,
        type: provider.type,
        baseUrl: provider.baseUrl,
        apiKey: '',
        auth: provider.auth,
        models: provider.models,
        defaultModel: provider.defaultModel,
        advanced: provider.advanced
      },
      presetId: 'custom',
      originalProviderId: provider.id
    })
  }, [])
  const closeEditor = useCallback(() => dispatch({ type: 'CLOSE_EDITOR' }), [])
  const selectPreset = useCallback((presetId: string) => {
    dispatch({ type: 'OPEN_EDITOR', editor: createProviderFromPreset(presetId), presetId })
  }, [])
  const updateEditor = useCallback(
    (editor: AIProviderConfig) => dispatch({ type: 'EDIT', editor }),
    []
  )

  const save = useCallback(async (): Promise<void> => {
    if (!state.editor) return
    dispatch({ type: 'SAVE_START' })
    const result = await window.api.saveAIProvider(state.editor)
    if (!result.success) return dispatch({ type: 'ERROR', error: result.error || '供应商保存失败' })
    dispatch({ type: 'CLOSE_EDITOR' })
    await refresh()
    onNotice('AI 供应商已安全保存')
  }, [onNotice, refresh, state.editor])

  const remove = useCallback(
    async (providerId: string): Promise<void> => {
      if (!window.confirm('确认删除这个 AI 供应商？安全存储中的 API Key 也会一并清除。')) return
      const result = await window.api.deleteAIProvider(providerId)
      if (!result.success)
        return dispatch({ type: 'ERROR', error: result.error || '供应商删除失败' })
      await refresh()
      onNotice('AI 供应商已删除')
    },
    [onNotice, refresh]
  )

  const setDefault = useCallback(
    async (providerId: string): Promise<void> => {
      const result = await window.api.setDefaultAIProvider(providerId)
      if (!result.success)
        return dispatch({ type: 'ERROR', error: result.error || '默认模型更新失败' })
      await refresh()
      onNotice('默认 AI 模型已更新')
    },
    [onNotice, refresh]
  )

  const test = useCallback(
    async (providerId: string): Promise<void> => {
      dispatch({ type: 'TEST_START', providerId })
      const result = await window.api.testAIProvider(providerId)
      await refresh()
      onNotice(
        result.success
          ? `连接成功，耗时 ${result.latencyMs || 0} ms`
          : result.error || '连接测试失败'
      )
    },
    [onNotice, refresh]
  )

  const selectVisionImage = useCallback(async (file: File): Promise<void> => {
    const extension = file.name.split('.').pop()?.toLowerCase()
    const inferredType =
      extension === 'png'
        ? 'image/png'
        : extension === 'webp'
          ? 'image/webp'
          : extension === 'jpg' || extension === 'jpeg'
            ? 'image/jpeg'
            : ''
    const mimeType = file.type === 'image/jpg' ? 'image/jpeg' : file.type || inferredType
    const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
    if (!supportedTypes.has(mimeType)) {
      return dispatch({ type: 'VISION_ERROR', error: '请选择 PNG、JPG、JPEG 或 WebP 图片' })
    }
    if (!file.size || file.size > 10 * 1024 * 1024) {
      return dispatch({ type: 'VISION_ERROR', error: '图片大小必须在 10 MB 以内' })
    }
    dispatch({ type: 'VISION_READING' })
    try {
      const rawDataUrl = await readFileAsDataUrl(file)
      const dataUrl = rawDataUrl.replace(/^data:[^;]*;/, `data:${mimeType};`)
      dispatch({
        type: 'VISION_READY',
        image: { dataUrl, fileName: file.name, mimeType, size: file.size }
      })
    } catch {
      dispatch({ type: 'VISION_ERROR', error: '图片无法读取，请重新选择' })
    }
  }, [])

  const setVisionPrompt = useCallback(
    (prompt: string) => dispatch({ type: 'VISION_PROMPT', prompt }),
    []
  )

  const runVisionTest = useCallback(async (): Promise<void> => {
    const { runtime, visionTest } = state
    if (!runtime?.configured || !runtime.providerId || !runtime.model) {
      return dispatch({ type: 'VISION_ERROR', error: '请先配置可用的默认 AI 模型' })
    }
    if (!visionTest.image) return dispatch({ type: 'VISION_ERROR', error: '请先选择测试图片' })
    if (!visionTest.prompt.trim()) {
      return dispatch({ type: 'VISION_ERROR', error: '请填写图片识别提示词' })
    }
    dispatch({ type: 'VISION_TEST_START' })
    try {
      const result = await window.api.testAIVision({
        providerId: runtime.providerId,
        modelId: runtime.model,
        prompt: visionTest.prompt,
        imageDataUrl: visionTest.image.dataUrl
      })
      dispatch({ type: 'VISION_RESULT', result })
      if (result.success) {
        await refresh()
        onNotice('图片理解测试成功，已更新模型能力')
      }
    } catch {
      dispatch({ type: 'VISION_ERROR', error: '图片理解测试调用失败，请稍后重试' })
    }
  }, [onNotice, refresh, state])

  const clearVisionImage = useCallback(() => dispatch({ type: 'VISION_CLEAR' }), [])

  return {
    state,
    openNew,
    openEdit,
    closeEditor,
    selectPreset,
    updateEditor,
    save,
    remove,
    setDefault,
    test,
    selectVisionImage,
    setVisionPrompt,
    runVisionTest,
    clearVisionImage
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('invalid image'))
    )
    reader.addEventListener('error', () => reject(reader.error || new Error('read failed')))
    reader.readAsDataURL(file)
  })
}
