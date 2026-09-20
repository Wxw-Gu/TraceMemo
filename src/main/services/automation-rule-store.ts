import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import fs from 'fs-extra'
import {
  createDefaultDailyReportRule,
  normalizeRuleDraft,
  type AutomationRule
} from '../../shared/automation'

/**
 * AutomationRuleStore —— 自动化规则的持久化与增删改查。
 *
 * 存储形态刻意做到最简：一个 JSON 文件（`{userData}/automation/rules.json`）。
 * 规则总量是个位数到几十条，引入数据库只会增加迁移负担。
 *
 * **内置规则的播种标记（`builtinSeeded`）单独存**：
 * 如果靠"文件里有没有那条内置规则"来判断是否播种，用户一旦删掉它，
 * 下次启动就会被重新塞回来 —— 用户会认为删除功能坏了。
 */

const STORAGE_DIR = 'automation'
const RULES_FILE = 'rules.json'

interface StoredRules {
  version: number
  /** 内置规则是否已经播种过。**即使随后被删除也保持 true**。 */
  builtinSeeded: boolean
  rules: AutomationRule[]
}

export interface AutomationRuleStoreDependencies {
  userDataPath?: () => string
  now?: () => number
}

function emptyState(): StoredRules {
  return { version: 1, builtinSeeded: false, rules: [] }
}

/** 读盘容错：任何字段可疑都降级成安全值，绝不因为一个坏文件让功能整体不可用。 */
function normalizeStored(value: unknown): StoredRules {
  if (!value || typeof value !== 'object') return emptyState()
  const input = value as Partial<StoredRules>
  const rules = Array.isArray(input.rules)
    ? input.rules.filter(
        (rule): rule is AutomationRule =>
          Boolean(rule && typeof rule === 'object' && String(rule.id || '').trim())
      )
    : []
  return {
    version: Number(input.version) || 1,
    builtinSeeded: input.builtinSeeded === true,
    rules
  }
}

export class AutomationRuleStore {
  private readonly userDataPath: () => string
  private readonly now: () => number
  private state: StoredRules = emptyState()
  private loaded = false

  constructor(dependencies: AutomationRuleStoreDependencies = {}) {
    this.userDataPath = dependencies.userDataPath ?? (() => app.getPath('userData'))
    this.now = dependencies.now ?? (() => Date.now())
  }

  listRules(): AutomationRule[] {
    this.ensureLoaded()
    return this.state.rules.map((rule) => structuredClone(rule))
  }

  getRule(id: string): AutomationRule | undefined {
    const key = String(id || '').trim()
    if (!key) return undefined
    const found = this.listRules().find((rule) => rule.id === key)
    return found
  }

  createRule(draft: unknown): AutomationRule {
    this.ensureLoaded()
    const timestamp = this.now()
    const normalized = normalizeRuleDraft(draft)
    const rule: AutomationRule = {
      ...normalized,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.state.rules = [...this.state.rules, rule]
    this.persist()
    return structuredClone(rule)
  }

  updateRule(id: string, draft: unknown): AutomationRule | undefined {
    this.ensureLoaded()
    const key = String(id || '').trim()
    const index = this.state.rules.findIndex((rule) => rule.id === key)
    if (index < 0) return undefined
    const current = this.state.rules[index]
    // 名字留空时沿用原名，而不是变成「未命名自动化」—— 编辑页只改开关时不该改名。
    const normalized = normalizeRuleDraft(draft, current.name)
    const rule: AutomationRule = {
      ...current,
      ...normalized,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.now()
    }
    this.state.rules = this.state.rules.map((item, at) => (at === index ? rule : item))
    this.persist()
    return structuredClone(rule)
  }

  deleteRule(id: string): boolean {
    this.ensureLoaded()
    const key = String(id || '').trim()
    const before = this.state.rules.length
    this.state.rules = this.state.rules.filter((rule) => rule.id !== key)
    if (this.state.rules.length === before) return false
    this.persist()
    return true
  }

  setRuleEnabled(id: string, enabled: boolean): AutomationRule | undefined {
    const rule = this.getRule(id)
    if (!rule) return undefined
    return this.updateRule(id, { ...rule, enabled: enabled === true })
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    let stored: StoredRules
    try {
      stored = normalizeStored(fs.readJsonSync(this.rulesFilePath()) as unknown)
    } catch {
      stored = emptyState()
    }
    if (!stored.builtinSeeded) {
      stored.builtinSeeded = true
      stored.rules = [...stored.rules, createDefaultDailyReportRule(this.now())]
    }
    this.state = stored
    this.persist()
  }

  private rulesFilePath(): string {
    return path.join(this.userDataPath(), STORAGE_DIR, RULES_FILE)
  }

  private persist(): void {
    try {
      const filePath = this.rulesFilePath()
      fs.ensureDirSync(path.dirname(filePath))
      fs.writeJsonSync(filePath, this.state, { spaces: 2 })
    } catch (error) {
      console.warn(
        `[Automation] 保存规则失败: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

export const automationRuleStore = new AutomationRuleStore()
