import type { ExtensionAutomationActionContribution } from '../../shared/extensions/manifest'
import type { ExtensionAutomationActionSummary } from '../../shared/extensions/types'

export interface RegisteredExtensionAction {
  extensionId: string
  extensionName: string
  actionId: string
  title: string
  description?: string
  /** 后台进程是否真的注册了这个动作。 */
  registered: boolean
  /** manifest 是否声明了它（声明了但没注册 = 扩展代码有问题）。 */
  declared: boolean
}

/**
 * 扩展贡献的自动化动作注册表。
 *
 * 两个来源刻意分开记：
 * - `declared`：manifest 里写了什么 —— 用于在规则编辑器里展示「这个扩展提供了哪些动作」；
 * - `registered`：后台进程运行期真正注册了什么 —— 只有它能被执行。
 *
 * 二者不一致时**不猜**：动作在界面上显示为不可用，规则执行时明确报错。
 */
export class ExtensionActionRegistry {
  private readonly registered = new Map<
    string,
    Map<string, { title: string; description?: string }>
  >()
  private readonly declared = new Map<
    string,
    { name: string; actions: ExtensionAutomationActionContribution[] }
  >()
  private readonly names = new Map<string, string>()

  setDeclared(
    extensionId: string,
    extensionName: string,
    actions: ExtensionAutomationActionContribution[]
  ): void {
    this.names.set(extensionId, extensionName)
    this.declared.set(extensionId, { name: extensionName, actions: [...actions] })
  }

  setRegistered(
    extensionId: string,
    extensionName: string,
    actions: Array<{ id: string; title: string; description?: string }>
  ): void {
    this.names.set(extensionId, extensionName)
    this.registered.set(
      extensionId,
      new Map(
        actions.map((action) => [
          action.id,
          {
            title: action.title,
            ...(action.description ? { description: action.description } : {})
          }
        ])
      )
    )
  }

  remove(extensionId: string): void {
    this.registered.delete(extensionId)
    this.declared.delete(extensionId)
    this.names.delete(extensionId)
  }

  removeRuntime(extensionId: string): void {
    this.registered.delete(extensionId)
  }

  isRegistered(extensionId: string, actionId: string): boolean {
    return this.registered.get(extensionId)?.has(actionId) === true
  }

  get(extensionId: string, actionId: string): RegisteredExtensionAction | undefined {
    const declaredAction = this.declared
      .get(extensionId)
      ?.actions.find((action) => action.id === actionId)
    const runtime = this.registered.get(extensionId)?.get(actionId)
    if (!declaredAction && !runtime) return undefined
    return {
      extensionId,
      extensionName: this.names.get(extensionId) || extensionId,
      actionId,
      title: runtime?.title || declaredAction?.title || actionId,
      ...(runtime?.description || declaredAction?.description
        ? { description: runtime?.description || declaredAction?.description }
        : {}),
      registered: Boolean(runtime),
      declared: Boolean(declaredAction)
    }
  }

  list(): RegisteredExtensionAction[] {
    const result: RegisteredExtensionAction[] = []
    const extensionIds = new Set([...this.declared.keys(), ...this.registered.keys()])
    for (const extensionId of extensionIds) {
      const declaredActions = this.declared.get(extensionId)?.actions ?? []
      const runtimeActions = this.registered.get(extensionId) ?? new Map()
      const ids = new Set([...declaredActions.map((action) => action.id), ...runtimeActions.keys()])
      for (const actionId of ids) {
        const action = this.get(extensionId, actionId)
        if (action) result.push(action)
      }
    }
    return result.sort((left, right) => {
      if (left.extensionName !== right.extensionName)
        return left.extensionName.localeCompare(right.extensionName)
      return left.title.localeCompare(right.title)
    })
  }

  summariesFor(extensionId: string): ExtensionAutomationActionSummary[] {
    const declaredActions = this.declared.get(extensionId)?.actions ?? []
    const runtimeActions = this.registered.get(extensionId) ?? new Map()
    const ids = new Set([...declaredActions.map((action) => action.id), ...runtimeActions.keys()])
    return Array.from(ids).map((actionId) => {
      const declaredAction = declaredActions.find((action) => action.id === actionId)
      const runtime = runtimeActions.get(actionId)
      return {
        id: actionId,
        title: runtime?.title || declaredAction?.title || actionId,
        ...(runtime?.description || declaredAction?.description
          ? { description: runtime?.description || declaredAction?.description }
          : {}),
        registered: Boolean(runtime)
      }
    })
  }
}
