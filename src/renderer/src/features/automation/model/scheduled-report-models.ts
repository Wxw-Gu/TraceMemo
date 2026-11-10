import type { ReportModelChoice } from '../../../../../shared/ai-provider'

/** Use the same configured chat models and subscription IPC as the manual report page. */
export async function loadScheduledReportModels(): Promise<{
  choices: ReportModelChoice[]
  defaultConfigured: boolean
  error?: string
}> {
  const [providers, subscription, runtime] = await Promise.allSettled([
    Promise.resolve().then(() => window.api.listAIProviders?.()),
    Promise.resolve().then(() => window.api.listChatGPTPlanModels?.()),
    Promise.resolve().then(() => window.api.getAIRuntimeConfig?.())
  ])
  const choices: ReportModelChoice[] = []
  if (providers.status === 'fulfilled' && providers.value?.success) {
    for (const provider of providers.value.providers) {
      if (!provider.hasApiKey && provider.type !== 'ollama' && provider.auth.type !== 'none')
        continue
      for (const model of provider.models.filter((item) => item.capabilities.chat)) {
        choices.push({
          providerId: provider.id,
          providerName: provider.name,
          model: model.id,
          modelName: model.name || model.id,
          configured: true,
          status: provider.status,
          timeoutMs: provider.advanced.timeoutMs
        })
      }
    }
  }
  if (subscription.status === 'fulfilled') choices.push(...(subscription.value ?? []))
  const failed =
    providers.status === 'rejected' ||
    subscription.status === 'rejected' ||
    runtime.status === 'rejected' ||
    (runtime.status === 'fulfilled' && !runtime.value) ||
    (providers.status === 'fulfilled' && providers.value?.success === false)
  return {
    choices,
    defaultConfigured: runtime.status === 'fulfilled' && runtime.value?.configured === true,
    ...(failed ? { error: '部分模型加载失败，请检查模型配置或 ChatGPT 订阅连接后刷新。' } : {})
  }
}

export function scheduledModelKey(providerId: string, model: string): string {
  return providerId ? JSON.stringify([providerId, model]) : 'default'
}
