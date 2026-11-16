/**
 * 扩展动作的输入参数 Schema。
 *
 * 刻意只支持一个**明确的子集**：完整 JSON Schema 会把「UI 怎么渲染」和
 * 「后台怎么校验」拆成两套实现，两边一旦不一致，用户看到的就是
 * 「表单说合法、执行时说参数错」。
 *
 * 支持范围：
 * - 顶层必须是 `type: 'object'` + `properties`
 * - 字段类型：string / number / integer / boolean
 * - 约束：required、enum、default、minimum/maximum、minLength/maxLength
 * - 展示：title、description
 */

export const ACTION_SCHEMA_MAX_BYTES = 4 * 1024
export const ACTION_SCHEMA_MAX_PROPERTIES = 24

export type ExtensionActionFieldType = 'string' | 'number' | 'integer' | 'boolean'

export interface ExtensionActionFieldSchema {
  type: ExtensionActionFieldType
  title?: string
  description?: string
  enum?: Array<string | number>
  default?: string | number | boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

export interface ExtensionActionInputSchema {
  type: 'object'
  properties: Record<string, ExtensionActionFieldSchema>
  required?: string[]
}

export type ActionSchemaParseResult =
  | { ok: true; schema: ExtensionActionInputSchema }
  | { ok: false; reason: string }

const FIELD_TYPES: readonly ExtensionActionFieldType[] = ['string', 'number', 'integer', 'boolean']
const MAX_STRING_CONSTRAINT = 4_000
const MAX_ABSOLUTE_NUMBER = 1e12
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const parsed = readFiniteNumber(value)
  if (parsed === undefined || parsed < 0 || !Number.isInteger(parsed)) return undefined
  return Math.min(parsed, MAX_STRING_CONSTRAINT)
}

/**
 * 解析并规范化 Schema。
 *
 * 任何无法安全表达的内容都**整体拒绝**，不做部分裁剪：静默丢掉一个字段，
 * 界面会少一个输入框，而后台仍在等这个必填项。
 */
export function parseActionInputSchema(value: unknown): ActionSchemaParseResult {
  if (value === undefined || value === null) return { ok: false, reason: 'schema 为空' }
  if (!isPlainObject(value)) return { ok: false, reason: 'schema 必须是对象' }

  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return { ok: false, reason: 'schema 不能序列化（可能含循环引用）' }
  }
  const byteLength = new TextEncoder().encode(serialized).length
  if (byteLength > ACTION_SCHEMA_MAX_BYTES) {
    return { ok: false, reason: `schema 超过 ${ACTION_SCHEMA_MAX_BYTES} 字节上限` }
  }

  if (value.type !== 'object') return { ok: false, reason: '顶层 type 必须是 object' }
  const properties = value.properties
  if (!isPlainObject(properties)) return { ok: false, reason: 'schema.properties 必须是对象' }
  const keys = Object.keys(properties)
  if (keys.length === 0) return { ok: false, reason: 'schema.properties 不能为空' }
  if (keys.length > ACTION_SCHEMA_MAX_PROPERTIES) {
    return { ok: false, reason: `参数数量超过 ${ACTION_SCHEMA_MAX_PROPERTIES} 个上限` }
  }

  const normalized: Record<string, ExtensionActionFieldSchema> = {}
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) return { ok: false, reason: `参数名不合法：${key}` }
    if (key.length > 40) return { ok: false, reason: `参数名过长：${key}` }
    const field = properties[key]
    if (!isPlainObject(field)) return { ok: false, reason: `参数 ${key} 的定义必须是对象` }
    const type = field.type
    if (typeof type !== 'string' || !FIELD_TYPES.includes(type as ExtensionActionFieldType)) {
      return { ok: false, reason: `参数 ${key} 的类型不支持：${String(type)}` }
    }
    const fieldType = type as ExtensionActionFieldType

    const entry: ExtensionActionFieldSchema = { type: fieldType }
    if (typeof field.title === 'string' && field.title.trim()) {
      entry.title = field.title.trim().slice(0, 60)
    }
    if (typeof field.description === 'string' && field.description.trim()) {
      entry.description = field.description.trim().slice(0, 200)
    }

    if (field.enum !== undefined) {
      if (!Array.isArray(field.enum) || field.enum.length === 0 || field.enum.length > 50) {
        return { ok: false, reason: `参数 ${key} 的 enum 不合法` }
      }
      const allowed: Array<string | number> = []
      for (const option of field.enum) {
        if (fieldType === 'string' && typeof option === 'string') {
          allowed.push(option.slice(0, 200))
        } else if (
          fieldType !== 'string' &&
          typeof option === 'number' &&
          Number.isFinite(option)
        ) {
          allowed.push(option)
        } else {
          return { ok: false, reason: `参数 ${key} 的 enum 项与类型不一致` }
        }
      }
      entry.enum = allowed
    }

    if (field.default !== undefined) {
      const fallback = normalizeActionFieldValue(fieldType, field.default)
      if (fallback === undefined)
        return { ok: false, reason: `参数 ${key} 的 default 与类型不一致` }
      entry.default = fallback
    }

    if (fieldType === 'string') {
      const minLength = readNonNegativeInteger(field.minLength)
      const maxLength = readNonNegativeInteger(field.maxLength)
      if (minLength !== undefined) entry.minLength = minLength
      if (maxLength !== undefined) entry.maxLength = maxLength
      if (
        entry.minLength !== undefined &&
        entry.maxLength !== undefined &&
        entry.minLength > entry.maxLength
      ) {
        return { ok: false, reason: `参数 ${key} 的 minLength 大于 maxLength` }
      }
    } else if (fieldType === 'number' || fieldType === 'integer') {
      const minimum = readFiniteNumber(field.minimum)
      const maximum = readFiniteNumber(field.maximum)
      if (minimum !== undefined && Math.abs(minimum) <= MAX_ABSOLUTE_NUMBER) entry.minimum = minimum
      if (maximum !== undefined && Math.abs(maximum) <= MAX_ABSOLUTE_NUMBER) entry.maximum = maximum
      if (
        entry.minimum !== undefined &&
        entry.maximum !== undefined &&
        entry.minimum > entry.maximum
      ) {
        return { ok: false, reason: `参数 ${key} 的 minimum 大于 maximum` }
      }
    }

    normalized[key] = entry
  }

  let required: string[] | undefined
  if (value.required !== undefined) {
    if (!Array.isArray(value.required)) return { ok: false, reason: 'required 必须是数组' }
    const list: string[] = []
    for (const item of value.required) {
      if (typeof item !== 'string' || !normalized[item]) {
        return { ok: false, reason: `required 引用了未定义的参数：${String(item)}` }
      }
      if (!list.includes(item)) list.push(item)
    }
    if (list.length) required = list
  }

  return {
    ok: true,
    schema: { type: 'object', properties: normalized, ...(required ? { required } : {}) }
  }
}

/** 把原始值按字段类型收敛；不合法返回 undefined。 */
export function normalizeActionFieldValue(
  type: ExtensionActionFieldType,
  value: unknown
): string | number | boolean | undefined {
  if (type === 'string') return typeof value === 'string' ? value.slice(0, 4_000) : undefined
  if (type === 'boolean') return typeof value === 'boolean' ? value : undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (type === 'integer' && !Number.isInteger(value)) return undefined
  return value
}

export interface ActionInputValidationResult {
  ok: boolean
  /** 逐字段错误，key 是参数名。 */
  errors: Record<string, string>
}

/**
 * 按 Schema 校验输入。
 *
 * UI 提交前与后台执行前都用这一个函数：两边规则一致才谈得上「所见即所得」。
 */
export function validateActionInput(
  schema: ExtensionActionInputSchema | undefined,
  input: Record<string, unknown> | undefined
): ActionInputValidationResult {
  const errors: Record<string, string> = {}
  if (!schema) return { ok: true, errors }

  const values = input && typeof input === 'object' ? input : {}
  const required = new Set(schema.required ?? [])

  for (const [key, field] of Object.entries(schema.properties)) {
    const raw = (values as Record<string, unknown>)[key]
    const missing = raw === undefined || raw === null || raw === ''
    if (missing) {
      if (required.has(key)) errors[key] = '必填'
      continue
    }
    const normalized = normalizeActionFieldValue(field.type, raw)
    if (normalized === undefined) {
      errors[key] = field.type === 'integer' ? '需要整数' : `需要 ${field.type}`
      continue
    }
    if (field.enum && !field.enum.includes(normalized as string | number)) {
      errors[key] = '不在可选范围内'
      continue
    }
    if (typeof normalized === 'string') {
      if (field.minLength !== undefined && normalized.length < field.minLength) {
        errors[key] = `至少 ${field.minLength} 个字符`
        continue
      }
      if (field.maxLength !== undefined && normalized.length > field.maxLength) {
        errors[key] = `最多 ${field.maxLength} 个字符`
        continue
      }
    }
    if (typeof normalized === 'number') {
      if (field.minimum !== undefined && normalized < field.minimum) {
        errors[key] = `不能小于 ${field.minimum}`
        continue
      }
      if (field.maximum !== undefined && normalized > field.maximum) {
        errors[key] = `不能大于 ${field.maximum}`
      }
    }
  }

  return { ok: Object.keys(errors).length === 0, errors }
}

/** 按 Schema 生成一份带默认值的输入；缺省值缺失时留空。 */
export function buildDefaultActionInput(
  schema: ExtensionActionInputSchema | undefined
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (!schema) return result
  for (const [key, field] of Object.entries(schema.properties)) {
    if (field.default !== undefined) result[key] = field.default
  }
  return result
}
