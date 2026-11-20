import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tracememo-agent-config' }
}))

import {
  DEFAULT_WORKBUDDY_AGENT_SETTINGS,
  loadWorkBuddyAgentSettings,
  loadWorkBuddyCredentials
} from '../../src/main/services/agent-task-config'

/**
 * 配置边界：
 * - 默认必须**禁用**；
 * - 配置损坏不能阻断启动；
 * - 凭证只能来自环境变量，配置文件里的同名字段必须被忽略。
 */

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracememo-agent-config-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('loadWorkBuddyAgentSettings', () => {
  it('没有配置文件时默认禁用且白名单为空', () => {
    const settings = loadWorkBuddyAgentSettings(root)
    expect(settings).toEqual(DEFAULT_WORKBUDDY_AGENT_SETTINGS)
    expect(settings.enabled).toBe(false)
    expect(settings.allowedConversations).toEqual([])
  })

  it('配置损坏时回落默认值，不抛异常', () => {
    fs.writeFileSync(path.join(root, 'workbuddy-agent.json'), '{not json')
    expect(loadWorkBuddyAgentSettings(root).enabled).toBe(false)
  })

  it('类型不合法时逐项回落（enabled 只接受 true）', () => {
    fs.writeFileSync(
      path.join(root, 'workbuddy-agent.json'),
      JSON.stringify({
        enabled: 'yes',
        allowedConversations: [' md5_a ', 42, 'md5_a', ''],
        timeoutMs: -5,
        pollIntervalMs: 'abc'
      })
    )
    const settings = loadWorkBuddyAgentSettings(root)
    expect(settings.enabled).toBe(false)
    expect(settings.allowedConversations).toEqual(['md5_a'])
    expect(settings.timeoutMs).toBe(DEFAULT_WORKBUDDY_AGENT_SETTINGS.timeoutMs)
    expect(settings.pollIntervalMs).toBe(DEFAULT_WORKBUDDY_AGENT_SETTINGS.pollIntervalMs)
  })

  it('配置文件里的凭证字段不会被读入（凭证只走环境变量）', () => {
    fs.writeFileSync(
      path.join(root, 'workbuddy-agent.json'),
      JSON.stringify({
        enabled: true,
        allowedConversations: ['md5_a'],
        accessToken: 'should-be-ignored',
        clientSecret: 'should-be-ignored'
      })
    )
    const settings = loadWorkBuddyAgentSettings(root) as unknown as Record<string, unknown>
    expect(settings.enabled).toBe(true)
    expect(settings.accessToken).toBeUndefined()
    expect(settings.clientSecret).toBeUndefined()
  })
})

describe('loadWorkBuddyCredentials', () => {
  it('只从环境变量读取，空字符串视为未配置', () => {
    expect(
      loadWorkBuddyCredentials({
        TRACEMEMO_WORKBUDDY_ACCESS_TOKEN: ' token ',
        TRACEMEMO_WORKBUDDY_REFRESH_TOKEN: '',
        TRACEMEMO_WORKBUDDY_CLIENT_ID: 'client',
        TRACEMEMO_WORKBUDDY_CLIENT_SECRET: 'secret'
      })
    ).toEqual({
      accessToken: 'token',
      refreshToken: undefined,
      clientId: 'client',
      clientSecret: 'secret'
    })
  })

  it('没有任何环境变量时返回空对象（由 provider 判 auth_missing）', () => {
    expect(loadWorkBuddyCredentials({})).toEqual({
      accessToken: undefined,
      refreshToken: undefined,
      clientId: undefined,
      clientSecret: undefined
    })
  })
})
