/**
 * 微信消息插入开关 —— 主进程侧封装。
 *
 * 为什么写操作不能在本进程做
 * --------------------------
 * WCDB 的 CommonCore 按**路径**池化底层库对象（CoreBridge.cpp:
 * `getOrCreateDatabase` + 只在 readOnly 时 `setReadOnly()`），而只读标志一旦
 * 设上去就没有逆操作。TraceMemo 启动后会用只读方式打开 message 分片，于是同一
 * 进程里任何「可写打开」拿到的都是那个只读对象 —— 写入必然得到
 * `-3004 attempt to write a readonly database`。
 *
 * 所以：
 *   **读**  → 本进程只读路径（分片目录 + 开关值），零写权限
 *   **写**  → spawn 一次性子进程 `tm-wcdb-config-helper`，池随进程销毁
 *
 * 子进程的密钥只从 stdin 进，绝不进 argv / env（否则会出现在 `ps` 与进程环境里）。
 *
 * 状态语义（不要退回「开关值写成功 = 功能已生效」）
 * ------------------------------------------------
 * 真正干活的是挂在 `Msg_<md5(roomId)>` 表上的规则。一个分片完全可能
 * 「有 _tm_config 却没规则」，此时开关写成 1 也毫无效果。而且一个会话可能同时
 * 存在于 2~4 个分片，必须**所有命中分片都 ready** 才算这个会话 ready。
 *
 * 判断「是否生效」始终按目标会话算，不按分片算。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { findResource } from '../resource-paths'
import { isMacNativeRuntimeUnavailable, resolveWcdbConfigHelper } from '../native-runtime-paths'
import type { Wcdb4Client } from '../wcdb4-client'
import {
  MSG_INSERT_SWITCHES,
  type MsgInsertApplyResult,
  type MsgInsertErrorCode,
  type MsgInsertScope,
  type MsgInsertSwitchName,
  type MsgInsertSwitchStatus,
  type MsgInsertSwitchesSnapshot
} from '../../shared/msg-insert-switch'

export {
  MSG_INSERT_SWITCHES,
  type MsgInsertSwitchName,
  type MsgInsertSwitchStatus,
  type MsgInsertSwitchesSnapshot
}

/* --------------------------------------------------------------- 常量 */

const HELPER_NAME = 'tm-wcdb-config-helper'
const HELPER_TIMEOUT_MS = 60_000
/** 分片里规则的名字（与 native 侧一致） */
const RULE_CAPTURE = '_tm_msg_insert_capture'
/* notice 规则只装在 winner 分片、且不参与就绪判据，读路径不需要它的名字。
 * 退群已改事件驱动，不再有 queue 规则（常量已退役）。 */

/**
 * 规则名在 native 侧按会话加了后缀。
 *
 * SQLite 的 trigger 名是**库级唯一**的：如果所有会话都用固定名字，给第二个会话装规则
 * 会直接覆盖第一个。所以真实名字形如 `_tm_msg_insert_capture_<md5(roomId)>`。
 *
 * ⚠️ 读路径必须用带后缀的名字去查目录，否则会得出「库里明明有规则、界面却显示 0」这种
 * 自相矛盾的结论。
 */
function ruleName(base: string, roomId: string): string {
  return `${base}_${md5Hex(roomId)}`
}

const SWITCH_SCOPE: Record<MsgInsertSwitchName, MsgInsertScope> = {
  // 防撤回：群聊和私聊都要覆盖，所以目标是「全部可定位会话」
  recall_notice: 'all_sessions',
  // 退群提示：任意群有人退出都要提示，所以目标是「全部群聊」（与退群监控的勾选无关）
  group_exit_notice: 'all_group_chats'
}

interface HelperRunResult {
  ok: boolean
  exitCode: number | null
  json?: Record<string, unknown>
  errorCode?: MsgInsertErrorCode
  message?: string
  detail?: string
}

function md5Hex(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function messageTableFor(roomId: string): string {
  return `Msg_${md5Hex(roomId)}`
}

export const SWITCH_MODE: Record<MsgInsertSwitchName, 'rules' | 'event'> = {
  // 防撤回靠装规则
  recall_notice: 'rules',
  // 退群提示靠事件驱动的一次性插入，不装规则
  group_exit_notice: 'event'
}

/**
 * 事件驱动型开关的状态。
 *
 * 它没有 room / shard 维度（不装规则），所以 room 计数一律为 0 —— UI 据此不显示
 * 「N / M 已启用」。desired 与 effective 同值：这条路径没有「值写了对但规则没装」
 * 的中间态，插入失败会记在 service 的 recent 里，不影响开关本身。
 */
export function eventModeStatus(
  name: MsgInsertSwitchName,
  enabled: boolean,
  monitoredRoomCount = 0
): MsgInsertSwitchStatus {
  const status = emptyMsgInsertStatus(name)
  status.mode = 'event'
  status.desiredEnabled = enabled
  status.effectiveEnabled = enabled
  status.operationOk = true
  /* 事件驱动型没有「预装规则覆盖率」。这里给的只是**监控范围**，
   * 用来告诉用户「开了之后哪些群的退群会被插提示」，不是覆盖率。 */
  status.monitoredRoomCount = monitoredRoomCount
  return status
}

export function emptyMsgInsertStatus(
  name: MsgInsertSwitchName,
  errorCode?: MsgInsertErrorCode,
  message?: string
): MsgInsertSwitchStatus {
  return {
    switch: name,
    scope: SWITCH_SCOPE[name],
    mode: SWITCH_MODE[name],
    desiredEnabled: false,
    effectiveEnabled: false,
    operationOk: false,
    totalInstallableRooms: 0,
    readyInstallableRooms: 0,
    roomsWithoutTable: 0,
    totalShards: 0,
    targetShards: 0,
    configuredShards: 0,
    readyShards: 0,
    notReadyShards: 0,
    failedShards: 0,
    errorCode,
    message
  }
}

/* ------------------------------------------------------- helper 定位与调用 */

/**
 * helper 与 libwcdb_api.dylib 同目录部署（依赖 @loader_path 解析 dylib）。
 * 开发态与打包态都靠 findResource 解析，不依赖当前工作目录。
 */
export function resolveHelperPath(): string | null {
  if (process.platform === 'darwin') return resolveWcdbConfigHelper()
  /*
   * 平台/架构都要分。Windows 交付在 `resources/wcdb/win32/x64/`（注意是 win32 不是 windows），
   * 文件名带 `.exe`。以前这里三个候选全写死 macos —— Windows 上会恒返回 null，
   * 表现为「缺少写入组件」+ 开关永久置灰。
   *
   * 同目录还有 wcdb_api.dll / WCDB.dll / SDL2.dll，MSVC 运行库在 resources/runtime/win32/，
   * 两者都由 preload-env.ts 加进 DLL 搜索路径，所以 helper.exe 能直接加载。
   */
  const archDir = process.arch === 'x64' ? 'x64' : 'arm64'
  const otherArchDir = archDir === 'arm64' ? 'x64' : 'arm64'
  const platformDir = process.platform === 'win32' ? 'win32' : 'macos'
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const candidates = [
    `wcdb/${platformDir}/${archDir}/${HELPER_NAME}${suffix}`,
    `wcdb/${platformDir}/${otherArchDir}/${HELPER_NAME}${suffix}`,
    `wcdb/${platformDir}/${HELPER_NAME}${suffix}`
  ]
  for (const candidate of candidates) {
    const resolved = findResource(candidate)
    if (resolved) return resolved
  }
  return null
}

/** 从分片路径反推账号根目录（helper 需要它来枚举分片） */
function accountRootFromShard(shardPath: string): string {
  // <root>/db_storage/message/message_N.db
  return path.dirname(path.dirname(path.dirname(shardPath)))
}

/**
 * 跑一次 helper。**密钥只走 stdin**。
 *
 * 请求体是一行 JSON：{"key":"<hex>","rooms":[...],"myWxid":"..."}
 * 用 JSON 而不是 argv，是因为目标会话可能有上千个，argv 会被撑爆；
 * 顺带保证密钥永远不进进程参数表。
 */
function runHelper(
  helperPath: string,
  args: string[],
  request: { key: string; rooms: string[]; myWxid: string },
  timeoutMs = HELPER_TIMEOUT_MS
): Promise<HelperRunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({
        ok: false,
        exitCode: null,
        errorCode: 'HELPER_START_FAILED',
        message: 'helper 启动失败',
        detail: error instanceof Error ? error.message : String(error)
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: HelperRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出了 */
      }
      finish({
        ok: false,
        exitCode: null,
        errorCode: 'HELPER_TIMEOUT',
        message: '写入超时，已中止',
        detail: `timeout=${timeoutMs}ms stderr=${stderr.slice(-400)}`
      })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000)
    })
    child.on('error', (error) => {
      finish({
        ok: false,
        exitCode: null,
        errorCode: 'HELPER_START_FAILED',
        message: 'helper 启动失败',
        detail: error.message
      })
    })
    child.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean)
      let json: Record<string, unknown> | undefined
      try {
        json = JSON.parse(lines[lines.length - 1] || '') as Record<string, unknown>
      } catch {
        finish({
          ok: false,
          exitCode: code,
          errorCode: 'HELPER_BAD_OUTPUT',
          message: 'helper 返回了无法解析的结果',
          detail: `exit=${code} stdout=${stdout.slice(-400)} stderr=${stderr.slice(-400)}`
        })
        return
      }
      const success = json.success === true
      finish({
        ok: code === 0 || (code === 1 && json.success === false),
        exitCode: code,
        json,
        errorCode: success ? undefined : inferErrorCode(json),
        message: success ? undefined : describeFailure(json),
        detail: `exit=${code} ${stderr.slice(-400)}`.trim()
      })
    })

    /* 密钥与请求一起写进 stdin，然后立刻关闭 —— 不进 argv、不进 env、不落盘。 */
    try {
      child.stdin?.write(`${JSON.stringify(request)}\n`)
      child.stdin?.end()
    } catch (error) {
      finish({
        ok: false,
        exitCode: null,
        errorCode: 'HELPER_START_FAILED',
        message: '无法把密钥交给 helper',
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

function inferErrorCode(json: Record<string, unknown>): MsgInsertErrorCode {
  const code = String(json.code || '')
  if (code === 'HELPER_BAD_ARGS') return 'HELPER_BAD_OUTPUT'
  if (code === 'UNSUPPORTED_SWITCH') return 'UNSUPPORTED_SWITCH'
  if (code === 'HELPER_NO_SHARDS') return 'DATABASE_UNAVAILABLE'
  if (code === 'RULE_MISSING') return 'RULE_MISSING'
  const failed = Number(json.failedShards || 0)
  if (failed > 0) return 'SHARD_WRITE_FAILED'
  /* roomsWithoutTable 是中性 pending，不是失败 —— 只有当**一个可安装会话都没有**
   * 的时候才算没有目标。 */
  if (
    Number(json.totalTargetRooms || 0) > 0 &&
    Number(json.totalTargetRooms || 0) === Number(json.roomsWithoutTable || 0)
  ) {
    return 'NO_TARGET_ROOMS'
  }
  return 'UNKNOWN'
}

function describeFailure(json: Record<string, unknown>): string {
  const failed = Number(json.failedShards || 0)
  if (failed > 0) return `${failed} 个消息库写入失败`
  const without = Number(json.roomsWithoutTable || 0)
  if (Number(json.totalTargetRooms || 0) > 0 && Number(json.totalTargetRooms) === without) {
    return `${without} 个目标会话在微信库里都还没有消息表`
  }
  const code = String(json.code || '')
  const detail = String(json.error || '')
  return code ? `${code}${detail ? `：${detail}` : ''}` : '操作未完成'
}

/* ----------------------------------------------------------- 目标会话解析 */

export interface MsgInsertScopeInput {
  client: Wcdb4Client
  /** 退群监控当前选中的群（来自 group-exit-monitor 服务，不在这里另维护一份） */
  monitoredRoomIds: string[]
}

/**
 * 解析某个开关的目标会话集合。
 *
 * - group_exit_notice → 全部群聊（事件驱动：真实范围由 GroupExitMonitorService 持有，
 *   退群监控勾选的群只决定「哪些群的退群走自动化通知」）
 * - recall_notice     → 全部可定位会话（群聊 + 私聊）
 */
export function resolveTargetRooms(
  input: MsgInsertScopeInput,
  name: MsgInsertSwitchName
): { scope: MsgInsertScope; rooms: string[]; error?: string } {
  const scope = SWITCH_SCOPE[name]
  if (scope === 'monitored_rooms') {
    const rooms = Array.from(new Set(input.monitoredRoomIds.filter(Boolean)))
    return { scope, rooms }
  }
  if (scope === 'all_group_chats') {
    /* 事件驱动型：不装规则，真实范围由 GroupExitMonitorService 持有。
     * 这里回一份群聊清单只为状态展示口径一致（调用方不拿它装规则）。 */
    try {
      const rooms = Array.from(
        new Set(
          input.client
            .getSessions()
            .map((session) => String(session.username || '').trim())
            .filter((username) => username.endsWith('@chatroom'))
        )
      )
      return { scope, rooms }
    } catch (error) {
      return {
        scope,
        rooms: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
  try {
    const rooms = Array.from(
      new Set(
        input.client
          .getSessions()
          .map((session) => String(session.username || '').trim())
          .filter(Boolean)
      )
    )
    return { scope, rooms }
  } catch (error) {
    return {
      scope,
      rooms: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/* --------------------------------------------------------------- 只读状态 */

interface CatalogShard {
  shard: string
  dbPath: string
  configTable: boolean
  tables: Set<string>
  ruleTables: Map<string, string>
}

function readCatalog(client: Wcdb4Client): {
  shards: CatalogShard[]
  rawCount: number
  error?: string
} {
  const result = client.listMsgInsertShardCatalog()
  if (!result.success || !result.catalog) {
    return { shards: [], rawCount: 0, error: result.error || '分片目录读取失败' }
  }
  const shards = result.catalog.shards.map<CatalogShard>((entry) => ({
    shard: entry.shard,
    dbPath: entry.dbPath,
    configTable: entry.configTable,
    tables: new Set(entry.tables || []),
    ruleTables: new Map((entry.rules || []).map((rule) => [rule.name, rule.table]))
  }))
  return { shards, rawCount: shards.length }
}

function roomReadiness(
  shards: CatalogShard[],
  roomId: string,
  name: MsgInsertSwitchName
): { matched: string[]; ready: boolean; notReady: string[] } {
  const table = messageTableFor(roomId)
  const matched: string[] = []
  const notReady: string[] = []
  const captureName = ruleName(RULE_CAPTURE, roomId)
  /* notice 规则只装在 winner 分片，就绪判据不看它（见下），所以这里不需要它的名字。 */
  for (const shard of shards) {
    if (!shard.tables.has(table)) continue
    matched.push(shard.shard)
    /* 同时接受历史遗留的无后缀规则（只要它挂在同一张表上）—— 与 native 侧判据一致，
     * 否则用旧脚本装过的那一个会话会被误判成未就绪。 */
    const attachedTo = (...names: string[]): boolean =>
      names.some((candidate) => shard.ruleTables.get(candidate) === table)
    const capture = attachedTo(captureName, RULE_CAPTURE)
    /*
     * ⚠️ 只要求 capture。
     *
     * notice 规则**只装在 winner 分片**上（分片之间是独立数据库文件、没有共享状态，
     * 每个分片各生成一条会重复插提示）。所以这里不能再要求每个分片都有 notice ——
     * 否则所有跨分片会话都会显示成「未就绪」。
     * 这条必须与 native 侧 `msgInsertEvaluateRoomShard` 的 `recallReady = capture` 一致。
     */
    const ready = name === 'recall_notice' ? capture : true
    if (!ready) notReady.push(shard.shard)
  }
  return { matched, ready: matched.length > 0 && notReady.length === 0, notReady }
}

/**
 * 本进程只读地聚合两个开关的状态。
 *
 * 只用「分片目录 + 开关值」：目录一次拿全，之后在本地用 md5(roomId) 匹配，
 * 所以哪怕目标会话很多也不会有额外的查库开销。
 */
export function readMsgInsertSwitches(input: MsgInsertScopeInput): MsgInsertSwitchesSnapshot {
  const catalog = readCatalog(input.client)
  const shardCount = catalog.rawCount
  const switches = {} as Record<MsgInsertSwitchName, MsgInsertSwitchStatus>

  if (catalog.error || shardCount === 0) {
    for (const name of MSG_INSERT_SWITCHES) {
      switches[name] = emptyMsgInsertStatus(
        name,
        'DATABASE_UNAVAILABLE',
        catalog.error || '找不到消息分片（数据库可能尚未连接）'
      )
    }
    return { success: false, switches, helperAvailable: resolveHelperPath() !== null }
  }

  /* 每个分片读一次开关值，后面既用来算 desired，也用来算分片级 ready */
  const valuesByShard = new Map<string, Record<string, boolean>>()
  for (const shard of catalog.shards) {
    const read = input.client.getMsgInsertSwitches(shard.dbPath)
    valuesByShard.set(
      shard.shard,
      read.success && read.switches
        ? read.switches
        : { recall_notice: false, group_exit_notice: false }
    )
  }

  for (const name of MSG_INSERT_SWITCHES) {
    const resolved = resolveTargetRooms(input, name)
    const status = emptyMsgInsertStatus(
      name,
      resolved.error ? 'DATABASE_UNAVAILABLE' : undefined,
      resolved.error
    )
    status.scope = resolved.scope
    status.totalShards = shardCount

    const targetShardNames = new Set<string>()
    const notReadyRooms: MsgInsertSwitchStatus['notReadyRooms'] = []
    let readyRooms = 0
    let roomsWithoutTable = 0

    for (const room of resolved.rooms) {
      const readiness = roomReadiness(catalog.shards, room, name)
      if (readiness.matched.length === 0) {
        /* 公众号 / 服务号 / 系统会话没有 Msg_ 表，装不了规则 —— **中性 pending**，
         * 既不算失败，也不进 notReadyRooms，更不能拖累 effectiveEnabled。 */
        roomsWithoutTable += 1
        continue
      }
      for (const shard of readiness.matched) targetShardNames.add(shard)
      if (readiness.ready) {
        readyRooms += 1
      } else {
        notReadyRooms.push({
          roomId: room,
          reason: 'rules-missing',
          matchedShards: readiness.matched,
          notReadyShards: readiness.notReady
        })
      }
    }

    status.targetShards = targetShardNames.size
    /* 分母是「有消息表、可安装」的会话数，不是全部会话数。
     * 否则总会有一部分会话装不了规则，界面会一直显示「部分成功」。 */
    status.totalInstallableRooms = readyRooms + notReadyRooms.length
    status.readyInstallableRooms = readyRooms
    status.roomsWithoutTable = roomsWithoutTable

    let configured = 0
    let readyShards = 0
    let notReadyShards = 0
    for (const shard of catalog.shards) {
      const values = valuesByShard.get(shard.shard)
      const on = Boolean(values?.[name])
      if (on) configured += 1
      if (!targetShardNames.has(shard.shard)) continue
      const recallOk = roomShardsReady(catalog.shards, shard.shard, resolved.rooms, name)
      if (on && recallOk) readyShards += 1
      else if (on) notReadyShards += 1
    }
    status.configuredShards = configured
    status.readyShards = readyShards
    status.notReadyShards = notReadyShards
    status.failedShards = 0
    status.desiredEnabled = configured > 0
    status.operationOk = true
    /* 生效判定只看可安装会话：roomsWithoutTable 不能阻止 effectiveEnabled。 */
    status.effectiveEnabled =
      status.desiredEnabled &&
      status.totalInstallableRooms > 0 &&
      readyRooms === status.totalInstallableRooms
    status.notReadyRooms = notReadyRooms.slice(0, 20)

    if (resolved.rooms.length === 0) {
      status.message = '没有可作用的目标会话'
    }
    switches[name] = status
  }

  return { success: true, switches, helperAvailable: resolveHelperPath() !== null }
}

/** 某分片上「所有目标会话」的规则是否都齐 */
function roomShardsReady(
  shards: CatalogShard[],
  shardName: string,
  rooms: string[],
  name: MsgInsertSwitchName
): boolean {
  const shard = shards.find((entry) => entry.shard === shardName)
  if (!shard) return false
  let any = false
  for (const room of rooms) {
    const table = messageTableFor(room)
    if (!shard.tables.has(table)) continue
    any = true
    const attachedTo = (...names: string[]): boolean =>
      names.some((candidate) => shard.ruleTables.get(candidate) === table)
    const capture = attachedTo(ruleName(RULE_CAPTURE, room), RULE_CAPTURE)
    /* 与 roomReadiness、以及 native 侧 `msgInsertEvaluateRoomShard` 用同一判据：
     * notice 只装在 winner 分片，就绪只看 capture。 */
    const ready = name === 'recall_notice' ? capture : true
    if (!ready) return false
  }
  return any
}

/* --------------------------------------------------------------- 写入动作 */

export interface MsgInsertApplyInput extends MsgInsertScopeInput {
  name: MsgInsertSwitchName
  enabled: boolean
  myWxid: string
  databaseKey: string
}

/**
 * 打开 / 关闭一个开关。
 *
 * 顺序是**先规则、后开关**：开的时候必须先把目标会话的规则补齐并确认 ready，
 * 才写开关值；关的时候只写值（规则体自己读 _tm_config，值为 0 时一行都不执行，
 * 所以关闭不需要昂贵 DDL，下次打开直接恢复）。
 */
export async function applyMsgInsertSwitch(
  input: MsgInsertApplyInput
): Promise<MsgInsertApplyResult> {
  /*
   * 防御：事件驱动型开关（退群提示）**不允许**走规则路径。
   *
   * 它没有 per-room 规则，走 apply 只会把 `_tm_config.group_exit_notice` 写成 1 ——
   * 一个写了也没人读的脏值，界面还会显示成关闭。
   */
  if (SWITCH_MODE[input.name] !== 'rules') {
    return {
      success: false,
      status: eventModeStatus(input.name, false),
      errorCode: 'UNSUPPORTED_SWITCH',
      message: '这个开关不走规则路径'
    }
  }

  const resolved = resolveTargetRooms(input, input.name)
  if (resolved.rooms.length === 0) {
    return {
      success: false,
      status: emptyMsgInsertStatus(input.name, 'NO_TARGET_ROOMS', '没有可作用的目标会话'),
      errorCode: 'NO_TARGET_ROOMS',
      message: '没有可作用的目标会话'
    }
  }
  if (!input.databaseKey) {
    return {
      success: false,
      status: emptyMsgInsertStatus(input.name, 'DATABASE_UNAVAILABLE', '数据库密钥不可用'),
      errorCode: 'DATABASE_UNAVAILABLE',
      message: '数据库密钥不可用，请先连接微信数据库'
    }
  }

  if (isMacNativeRuntimeUnavailable()) {
    return {
      success: false,
      status: emptyMsgInsertStatus(input.name, 'HELPER_NOT_FOUND', '微信内消息插入仅在 TraceMemo 具备发送能力时开放'),
      errorCode: 'HELPER_NOT_FOUND',
      message: '微信内防撤回与退群消息插入仅在 TraceMemo 具备发送能力时开放；退群检测和历史记录不受影响'
    }
  }
  const helperPath = resolveHelperPath()
  if (!helperPath) {
    return {
      success: false,
      status: emptyMsgInsertStatus(input.name, 'HELPER_NOT_FOUND', '暂无法使用'),
      errorCode: 'HELPER_NOT_FOUND',
      /* 面向用户是能力语义；errorCode 仍是 HELPER_NOT_FOUND，门禁/授权层照旧能判。 */
      message: '暂无法使用：当前安装不包含微信内消息写入组件'
    }
  }

  const shards = input.client.listMessageShardPaths()
  const accountRoot = shards.length > 0 ? accountRootFromShard(shards[0]) : ''
  if (!accountRoot) {
    return {
      success: false,
      status: emptyMsgInsertStatus(input.name, 'DATABASE_UNAVAILABLE', '找不到账号目录'),
      errorCode: 'DATABASE_UNAVAILABLE',
      message: '找不到微信账号目录'
    }
  }

  const run = await runHelper(
    helperPath,
    [
      '--account-root',
      accountRoot,
      '--action',
      'apply',
      '--switch',
      input.name === 'recall_notice' ? 'recall' : 'group_exit',
      '--value',
      input.enabled ? '1' : '0'
    ],
    { key: input.databaseKey, rooms: resolved.rooms, myWxid: input.myWxid }
  )

  /* 无论 helper 成功与否，都用本进程只读路径复核一遍，不拿 helper 的自述当结论 */
  const snapshot = readMsgInsertSwitches(input)
  const status = snapshot.switches[input.name]

  if (!run.json) {
    return {
      success: false,
      status,
      errorCode: run.errorCode || 'UNKNOWN',
      message: run.message || '操作失败',
      detail: run.detail
    }
  }

  const success = run.json.success === true
  /* 用 helper 的权威计数覆盖本地只读快照里的 room 分母，避免两边口径漂移。 */
  status.totalInstallableRooms = Number(
    run.json.installableTargetRooms ?? status.totalInstallableRooms
  )
  status.readyInstallableRooms = Number(run.json.readyTargetRooms ?? status.readyInstallableRooms)
  status.roomsWithoutTable = Number(run.json.roomsWithoutTable ?? status.roomsWithoutTable)
  return {
    success,
    status,
    errorCode: success ? undefined : run.errorCode || 'PARTIAL_SUCCESS',
    message: success ? undefined : run.message,
    detail: run.detail
  }
}

/**
 * 轻量 reconciliation：把目标会话缺失的规则补齐，**不动开关值**。
 *
 * 触发时机：启动连库后 / 退群监控群列表变化后 / 用户打开开关时。
 * 微信新建 message_4.db 并把某个目标群的新表放进去时，下一次触发就会自动补上。
 */
export async function reconcileMsgInsertRules(
  input: MsgInsertScopeInput & { myWxid: string; databaseKey: string; extraRooms?: string[] }
): Promise<{ done: boolean; rooms: number; written: number; errorCode?: MsgInsertErrorCode }> {
  if (isMacNativeRuntimeUnavailable()) {
    return { done: false, rooms: 0, written: 0, errorCode: 'HELPER_NOT_FOUND' }
  }
  const helperPath = resolveHelperPath()
  if (!helperPath || !input.databaseKey) {
    return {
      done: false,
      rooms: 0,
      written: 0,
      errorCode: helperPath ? 'DATABASE_UNAVAILABLE' : 'HELPER_NOT_FOUND'
    }
  }
  const shards = input.client.listMessageShardPaths()
  if (shards.length === 0) {
    return { done: false, rooms: 0, written: 0, errorCode: 'DATABASE_UNAVAILABLE' }
  }
  /*
   * 目标会话 = 退群监控选中的群 ∪ 调用方额外指定的会话。
   * 清残留与规则定义自愈都复用这条链路，只是换会话集合。
   */
  const rooms = Array.from(
    new Set([
      ...input.monitoredRoomIds.filter(Boolean),
      ...(input.extraRooms || []).filter(Boolean)
    ])
  )
  if (rooms.length === 0) return { done: true, rooms: 0, written: 0 }

  const run = await runHelper(
    helperPath,
    ['--account-root', accountRootFromShard(shards[0]), '--action', 'ensure-rules'],
    { key: input.databaseKey, rooms, myWxid: input.myWxid },
    /* 目标会话可能是「全部可定位会话」（几百个），比默认 60s 给宽一点。 */
    180_000
  )
  if (!run.json) {
    return { done: false, rooms: rooms.length, written: 0, errorCode: run.errorCode || 'UNKNOWN' }
  }
  return {
    done: run.json.success === true,
    rooms: rooms.length,
    written: Number(run.json.rulesWritten || 0),
    errorCode: run.json.success === true ? undefined : 'RULE_MISSING'
  }
}
