import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACTION_SCHEMA_MAX_BYTES,
  buildDefaultActionInput,
  parseActionInputSchema,
  validateActionInput
} from '../../src/shared/extensions/action-schema'
import { ExtensionSecretStore } from '../../src/main/extensions/extension-secret-store'

const roots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-m4-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
})

describe('动作参数 Schema', () => {
  it('解析受支持的子集并保留默认值', () => {
    const parsed = parseActionInputSchema({
      type: 'object',
      properties: {
        keyword: { type: 'string', title: '关键词', minLength: 1, maxLength: 20 },
        times: { type: 'integer', default: 2, minimum: 1, maximum: 5 },
        enabled: { type: 'boolean', default: true }
      },
      required: ['keyword']
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.schema.properties.keyword.type).toBe('string')
    expect(parsed.schema.required).toEqual(['keyword'])
    expect(buildDefaultActionInput(parsed.schema)).toEqual({ times: 2, enabled: true })
  })

  it('拒绝不支持的字段类型与非法结构', () => {
    expect(parseActionInputSchema({ type: 'array' }).ok).toBe(false)
    expect(parseActionInputSchema({ type: 'object', properties: { a: { type: 'date' } } }).ok).toBe(
      false
    )
    expect(parseActionInputSchema({ type: 'object', properties: {} }).ok).toBe(false)
    expect(
      parseActionInputSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['missing']
      }).ok
    ).toBe(false)
  })

  it('超过字节上限整体拒绝，不静默截断', () => {
    const huge = {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'x'.repeat(ACTION_SCHEMA_MAX_BYTES) }
      }
    }
    const parsed = parseActionInputSchema(huge)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('上限')
  })

  it('校验必填、类型、范围与枚举', () => {
    const parsed = parseActionInputSchema({
      type: 'object',
      properties: {
        keyword: { type: 'string', minLength: 2 },
        mode: { type: 'string', enum: ['a', 'b'] },
        count: { type: 'integer', minimum: 1, maximum: 3 }
      },
      required: ['keyword']
    })
    if (!parsed.ok) throw new Error('schema 应通过')
    const schema = parsed.schema

    expect(validateActionInput(schema, {}).errors.keyword).toBe('必填')
    expect(validateActionInput(schema, { keyword: 'x' }).errors.keyword).toContain('至少')
    expect(validateActionInput(schema, { keyword: 'ok', mode: 'c' }).errors.mode).toContain('范围')
    expect(validateActionInput(schema, { keyword: 'ok', count: 1.5 }).errors.count).toContain(
      '整数'
    )
    expect(validateActionInput(schema, { keyword: 'ok', count: 9 }).errors.count).toContain(
      '不能大于'
    )
    expect(validateActionInput(schema, { keyword: 'ok', mode: 'a', count: 2 }).ok).toBe(true)
  })

  it('没有 Schema 时一律通过（向后兼容旧扩展）', () => {
    expect(validateActionInput(undefined, { anything: 1 }).ok).toBe(true)
  })
})

describe('扩展凭据存储', () => {
  const cipher = {
    isAvailable: () => true,
    encrypt: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decrypt: (payload: Buffer) => {
      const text = payload.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad payload')
      return text.slice(4)
    }
  }

  it('按扩展命名空间隔离', () => {
    const root = tempRoot()
    const store = new ExtensionSecretStore({ root, cipher })
    store.set('com.example.a', 'cookie', 'value-a')
    store.set('com.example.b', 'cookie', 'value-b')

    expect(store.get('com.example.a', 'cookie')).toBe('value-a')
    expect(store.get('com.example.b', 'cookie')).toBe('value-b')
    expect(new ExtensionSecretStore({ root, cipher }).get('com.example.a', 'cookie')).toBe(
      'value-a'
    )
  })

  it('落盘只有密文，没有明文文件', () => {
    const root = tempRoot()
    const store = new ExtensionSecretStore({ root, cipher })
    store.set('com.example.a', 'cookie', 'super-secret-cookie')

    const files = fs.readdirSync(root)
    expect(files).toEqual(['com.example.a.bin'])
    const content = fs.readFileSync(path.join(root, 'com.example.a.bin'), 'utf8')
    expect(content.startsWith('enc:')).toBe(true)
    expect(fs.readdirSync(root).some((name) => name.endsWith('.txt'))).toBe(false)
  })

  it('安全存储不可用时明确失败，不退化成明文', () => {
    const root = tempRoot()
    const store = new ExtensionSecretStore({
      root,
      cipher: { ...cipher, isAvailable: () => false }
    })
    expect(() => store.set('com.example.a', 'cookie', 'x')).toThrowError(/安全存储/)
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([])
  })

  it('删除与清空', () => {
    const root = tempRoot()
    const store = new ExtensionSecretStore({ root, cipher })
    store.set('com.example.a', 'cookie', 'v')
    expect(store.delete('com.example.a', 'cookie')).toBe(true)
    expect(store.has('com.example.a', 'cookie')).toBe(false)

    store.set('com.example.a', 'cookie', 'v2')
    store.clear('com.example.a')
    expect(fs.existsSync(path.join(root, 'com.example.a.bin'))).toBe(false)
  })

  it('键名不合法时拒绝', () => {
    const root = tempRoot()
    const store = new ExtensionSecretStore({ root, cipher })
    expect(() => store.set('com.example.a', '../escape', 'v')).toThrowError(/键名/)
  })
})
