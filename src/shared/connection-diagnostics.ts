import type { DatabaseKeyEnvironment } from './database-key'

export function buildSafeDiagnosticSummary(
  environment: Omit<DatabaseKeyEnvironment, 'diagnosticSummary'>
): string {
  return [
    `TraceMemo: ${environment.appVersion}`,
    `操作系统: ${environment.osVersion}`,
    `微信客户端: ${environment.wechatVersion}`,
    `数据结构: ${environment.dataStructureVersion}`,
    `数据目录: ${environment.dataDirectoryDetected ? '已检测到' : '未检测到'}`,
    `微信进程: ${environment.wechatRunning ? '运行中' : '未运行'}`,
    `数据库连接: ${environment.dbConnected ? '已连接' : '未连接'}`,
    `安全存储: ${environment.encryptionAvailable ? '可用' : '不可用'}`
  ].join('\n')
}
