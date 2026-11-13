/**
 * 扩展后台进程入口。
 *
 * 这个文件**跑在子进程里**，不是主进程：它只负责加载扩展代码、构造受限 SDK、
 * 把请求转成白名单 RPC。任何 `require` 都只发生在这里，主进程永远不会加载
 * 第三方扩展代码。
 *
 * 与主进程的协议见 `src/shared/extensions/rpc.ts`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  EXTENSION_HOST_PROTOCOL_VERSION,
  type ExtensionAutomationActionOutput,
  type ExtensionHostActivate,
  type ExtensionHostCall,
  type ExtensionHostCallResult,
  type ExtensionHostEvent,
  type ExtensionHostInboundMessage,
  type ExtensionHostInvokeAction,
  type ExtensionHostTestSend,
  type ExtensionHostOutboundMessage,
  type ExtensionHostRegisterAction
} from '../../shared/extensions/rpc'
import type { ExtensionMessageEvent } from '../../shared/extensions/events'

type MessageHandler = (event: ExtensionMessageEvent) => void | Promise<void>

interface RegisteredActionDefinition {
  id: string
  title: string
  description?: string
  inputSchema?: Record<string, unknown>
  handler: (input: Record<string, unknown>) => unknown
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingCalls = new Map<string, PendingCall>()
const eventHandlers = new Set<MessageHandler>()
const actions = new Map<string, RegisteredActionDefinition>()
let permissions: string[] = []
let activated = false
let extensionDir = ''
let extensionDataDir = ''
let extensionId = process.env.TM_EXTENSION_ID || ''

function post(message: ExtensionHostOutboundMessage): void {
  if (typeof process.send !== 'function') return
  try {
    process.send(message)
  } catch {
    // 父进程已断开；子进程会在 shutdown 或退出时结束。
  }
}

function sendLog(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'log', version: EXTENSION_HOST_PROTOCOL_VERSION, level, message })
}

function requirePermission(permission: string): void {
  if (!permissions.includes(permission)) {
    const error = new Error(`扩展没有 ${permission} 权限`)
    ;(error as Error & { code?: string }).code = 'PERMISSION_DENIED'
    throw error
  }
}

/** 白名单 RPC：扩展只能申请这些能力，且每次都要过权限检查。 */
function callHost(
  method: ExtensionHostCall['method'],
  params: Record<string, unknown>,
  timeoutMs = 8_000
): Promise<unknown> {
  if (!activated) return Promise.reject(new Error('扩展尚未激活'))
  const callId = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(callId)
      reject(Object.assign(new Error('宿主调用超时'), { code: 'ACTION_TIMEOUT' }))
    }, timeoutMs)
    pendingCalls.set(callId, { resolve, reject, timer })
    post({ type: 'call', version: EXTENSION_HOST_PROTOCOL_VERSION, callId, method, params })
  })
}

const tm = {
  extension: {
    get id(): string {
      return extensionId
    },
    /** 扩展私有数据目录；下载/生成的媒体应放在这里。 */
    get dataDir(): string {
      return extensionDataDir
    },
    get permissions(): string[] {
      return [...permissions]
    }
  },
  events: {
    on(name: 'message.received', handler: MessageHandler): () => void {
      if (name !== 'message.received' || typeof handler !== 'function') return () => undefined
      eventHandlers.add(handler)
      return () => eventHandlers.delete(handler)
    },
    off(name: 'message.received', handler: MessageHandler): void {
      if (name !== 'message.received') return
      eventHandlers.delete(handler)
    }
  },
  messages: {
    async query(request: {
      conversationId: string
      startTime?: number
      endTime?: number
      limit?: number
    }): Promise<{ messages: unknown[] }> {
      requirePermission('messages.query')
      const result = (await callHost('messages.query', { ...request })) as { messages: unknown[] }
      return result
    }
  },
  wechat: {
    /**
     * 发送文本、图片或视频。
     *
     * 兼容旧调用：不传 `type` 视为 `text`。视频走独立的 video 通道，
     * 原生 Host 以 `{toWxid, type:'video', msg:<路径>}` 提交。
     */
    async send(request: {
      type?: 'text' | 'image' | 'video'
      to: string
      text?: string
      path?: string
      at?: Record<string, string>
      dedupeKey?: string
    }) {
      const type =
        request && (request.type === 'image' || request.type === 'video') ? request.type : 'text'
      if (type === 'image' || type === 'video') {
        requirePermission(type === 'video' ? 'wechat.send.video' : 'wechat.send.image')
        return (await callHost(
          type === 'video' ? 'wechat.send.video' : 'wechat.send.image',
          {
            to: request.to,
            path: request.path,
            ...(request.dedupeKey ? { dedupeKey: request.dedupeKey } : {})
          },
          180_000
        )) as {
          actionId: string
          status: 'sent'
        }
      }
      requirePermission('wechat.send.text')
      return (await callHost(
        'wechat.send.text',
        {
          to: request.to,
          text: request.text,
          ...(request.at ? { at: request.at } : {}),
          ...(request.dedupeKey ? { dedupeKey: request.dedupeKey } : {})
        },
        20_000
      )) as {
        actionId: string
        status: 'sent'
      }
    }
  },
  ai: {
    async chat(messages: Array<{ role: string; content: string }>) {
      requirePermission('ai.chat')
      return (await callHost('ai.chat', { messages }, 60_000)) as { text: string }
    }
  },
  storage: {
    async get(key: string): Promise<unknown> {
      requirePermission('storage')
      return callHost('storage.get', { key })
    },
    async set(key: string, value: unknown): Promise<void> {
      requirePermission('storage')
      await callHost('storage.set', { key, value })
    },
    async remove(key: string): Promise<boolean> {
      requirePermission('storage')
      const result = (await callHost('storage.remove', { key })) as { removed?: boolean }
      return result.removed === true
    },
    async list(): Promise<Array<{ key: string; value: unknown }>> {
      requirePermission('storage')
      const result = (await callHost('storage.list', {})) as {
        entries?: Array<{ key: string; value: unknown }>
      }
      return result.entries ?? []
    }
  },
  automation: {
    registerAction(definition: {
      id: string
      title: string
      description?: string
      inputSchema?: Record<string, unknown>
      handler: (input: Record<string, unknown>) => unknown
    }): void {
      requirePermission('automation.action')
      const id = String(definition?.id || '').trim()
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw new Error('动作 id 不合法')
      if (typeof definition.handler !== 'function') throw new Error('动作必须提供 handler')
      const title = String(definition.title || id)
        .trim()
        .slice(0, 60)
      if (!title) throw new Error('动作 title 不能为空')
      actions.set(id, {
        id,
        title,
        ...(definition.description
          ? { description: String(definition.description).slice(0, 200) }
          : {}),
        ...(definition.inputSchema ? { inputSchema: definition.inputSchema } : {}),
        handler: definition.handler
      })
      const message: ExtensionHostRegisterAction = {
        type: 'register-action',
        version: EXTENSION_HOST_PROTOCOL_VERSION,
        action: {
          id,
          title,
          ...(definition.description
            ? { description: String(definition.description).slice(0, 200) }
            : {}),
          hasInputSchema: Boolean(definition.inputSchema)
        }
      }
      post(message)
    }
  },
  capabilities: {
    async get(): Promise<unknown> {
      return callHost('capabilities.get', {})
    }
  },
  log: {
    info(message: unknown): void {
      sendLog('info', String(message ?? ''))
    },
    warn(message: unknown): void {
      sendLog('warn', String(message ?? ''))
    },
    error(message: unknown): void {
      sendLog('error', String(message ?? ''))
    }
  }
}

/** 入口文件必须真实位于扩展目录内；符号链接与越界路径都会被拒绝。 */
function resolveBackgroundEntry(dir: string): string | null {
  const manifestPath = path.join(dir, 'manifest.json')
  let manifest: { entrypoints?: { background?: unknown } }
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as typeof manifest
  } catch {
    return null
  }
  const relative = String(manifest.entrypoints?.background || '')
  if (!relative) return null
  const resolved = path.resolve(dir, relative)
  try {
    const realDir = fs.realpathSync(dir)
    const realEntry = fs.realpathSync(resolved)
    const inside = path.relative(realDir, realEntry)
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null
    return realEntry
  } catch {
    return null
  }
}

function pickExportedActivator(loaded: unknown): ((api: typeof tm) => unknown) | null {
  if (typeof loaded === 'function') return loaded as (api: typeof tm) => unknown
  if (loaded && typeof loaded === 'object') {
    const candidate = (loaded as { activate?: unknown }).activate
    if (typeof candidate === 'function') return candidate as (api: typeof tm) => unknown
  }
  return null
}

async function activate(message: ExtensionHostActivate): Promise<void> {
  extensionId = message.extensionId
  extensionDir = message.extensionDir
  extensionDataDir = message.dataDir
  permissions = Array.isArray(message.permissions) ? message.permissions : []
  const entry = resolveBackgroundEntry(extensionDir)
  if (!entry) {
    post({
      type: 'activated',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      ok: false,
      error: { code: 'EXTENSION_INVALID_PATH', message: '后台入口文件不合法或不存在' }
    })
    return
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(entry) as unknown
    const activator = pickExportedActivator(loaded)
    if (activator) await activator(tm)
    activated = true
    post({ type: 'activated', version: EXTENSION_HOST_PROTOCOL_VERSION, ok: true })
  } catch (error) {
    activated = false
    post({
      type: 'activated',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: 'ACTION_FAILED',
        message: error instanceof Error ? error.message.slice(0, 300) : '扩展激活失败'
      }
    })
  }
}

async function dispatchEvent(message: ExtensionHostEvent): Promise<void> {
  if (!activated) return
  for (const handler of eventHandlers) {
    try {
      await withTimeout(Promise.resolve(handler(message.envelope.event)), 10_000)
    } catch (error) {
      sendLog('error', `消息处理失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function validateActionInput(
  schema: Record<string, unknown> | undefined,
  input: Record<string, unknown>
): void {
  if (!schema) return
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const key of required) {
    if (typeof key === 'string' && !(key in input)) {
      throw new Error(`缺少必填参数：${key}`)
    }
  }
  const properties = schema.properties
  if (!properties || typeof properties !== 'object') return
  for (const [key, definition] of Object.entries(properties as Record<string, unknown>)) {
    if (!(key in input)) continue
    const type = (definition as { type?: unknown })?.type
    const value = input[key]
    if (type === 'string' && typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`)
    if (type === 'number' && typeof value !== 'number') throw new Error(`参数 ${key} 必须是数字`)
    if (type === 'boolean' && typeof value !== 'boolean')
      throw new Error(`参数 ${key} 必须是布尔值`)
  }
}

async function invokeAction(message: ExtensionHostInvokeAction): Promise<void> {
  const definition = actions.get(message.actionId)
  if (!definition) {
    post({
      type: 'action-result',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      requestId: message.requestId,
      ok: false,
      error: { code: 'ACTION_FAILED', message: `动作不存在：${message.actionId}` }
    })
    return
  }
  try {
    validateActionInput(definition.inputSchema, message.input)
    const raw = await withTimeout(
      Promise.resolve(definition.handler(message.input)),
      Math.max(1_000, Math.min(message.timeoutMs - 500, 60_000))
    )
    const output = normalizeActionOutput(raw)
    post({
      type: 'action-result',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      requestId: message.requestId,
      ok: output.success,
      output,
      ...(output.success
        ? {}
        : {
            error: { code: 'ACTION_FAILED' as const, message: output.error || '扩展动作返回失败' }
          })
    })
  } catch (error) {
    post({
      type: 'action-result',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      requestId: message.requestId,
      ok: false,
      error: {
        code:
          error instanceof Error && /超时/.test(error.message) ? 'ACTION_TIMEOUT' : 'ACTION_FAILED',
        message: error instanceof Error ? error.message.slice(0, 300) : '扩展动作执行失败'
      }
    })
  }
}

function normalizeActionOutput(raw: unknown): ExtensionAutomationActionOutput {
  if (!raw || typeof raw !== 'object') {
    return { success: false, error: '动作必须返回对象' }
  }
  const value = raw as Partial<ExtensionAutomationActionOutput>
  const reply = value.reply
  const hasReply =
    reply && reply.type === 'text' && typeof reply.text === 'string' && reply.text.trim().length > 0
  return {
    success: value.success !== false,
    ...(value.output && typeof value.output === 'object' ? { output: value.output } : {}),
    ...(hasReply
      ? {
          reply: {
            type: 'text' as const,
            text: reply!.text.trim().slice(0, 2_000),
            ...(reply!.at && typeof reply!.at === 'object' ? { at: reply!.at } : {})
          }
        }
      : {}),
    ...(typeof value.error === 'string' && value.error.trim()
      ? { error: value.error.trim().slice(0, 300) }
      : {})
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('扩展处理超时')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

process.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return
  const message = raw as ExtensionHostInboundMessage
  if (message.version !== EXTENSION_HOST_PROTOCOL_VERSION) return
  switch (message.type) {
    case 'activate':
      void activate(message)
      return
    case 'event':
      void dispatchEvent(message)
      return
    case 'invoke-action':
      void invokeAction(message)
      return
    case 'test-send':
      if (extensionId !== 'com.example.douyin-sender') return
      void dispatchTestSend(message)
      return
    case 'call-result': {
      const result = message as ExtensionHostCallResult
      const pending = pendingCalls.get(result.callId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingCalls.delete(result.callId)
      if (result.ok) {
        pending.resolve(result.result)
      } else {
        pending.reject(
          Object.assign(new Error(result.error?.message || '宿主调用失败'), {
            code: result.error?.code || 'ACTION_FAILED'
          })
        )
      }
      return
    }
    case 'shutdown':
      process.exit(0)
  }
})

async function dispatchTestSend(message: ExtensionHostTestSend): Promise<void> {
  const handler = (
    globalThis as typeof globalThis & {
      __tmTestSend?: (params: Record<string, unknown>) => Promise<unknown>
    }
  ).__tmTestSend
  if (!handler) {
    post({
      type: 'test-result',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      requestId: message.requestId,
      ok: false,
      error: { code: 'ACTION_FAILED', message: '测试处理器不可用' }
    })
    return
  }
  try {
    const result = await handler(message.params)
    post({
      type: 'test-result',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      requestId: message.requestId,
      ok: true,
      result
    })
  } catch (error) {
    post({
      type: 'test-result',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      requestId: message.requestId,
      ok: false,
      error: {
        code: 'ACTION_FAILED',
        message: error instanceof Error ? error.message : '测试任务失败'
      }
    })
  }
}

process.on('uncaughtException', (error) => {
  sendLog('error', `未捕获异常：${error.message}`)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  sendLog(
    'warn',
    `未处理的 Promise 拒绝：${reason instanceof Error ? reason.message : String(reason)}`
  )
})

// 让宿主知道进程已就绪，可以发 activate。必须在监听器之后发送。
post({ type: 'ready', version: EXTENSION_HOST_PROTOCOL_VERSION })
