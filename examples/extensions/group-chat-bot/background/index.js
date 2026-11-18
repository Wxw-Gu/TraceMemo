'use strict'

/** 群聊机器人后台入口壳：核心逻辑由 lib/bot-engine 承载，缺失时保持静默空操作且不报错。 */

let engine = null
try {
  engine = require('../lib/bot-engine')
} catch {
  engine = null
}

function registerFallbackHandlers(tm) {
  if (!tm || !tm.page || typeof tm.page.onRequest !== 'function') return
  const unavailable = async () => {
    throw new Error('当前功能暂不可用')
  }
  tm.page.onRequest('previewReply', unavailable)
  tm.page.onRequest('refreshGroupMemory', unavailable)
  tm.page.onRequest('testSend', unavailable)
}

module.exports = function activate(api) {
  if (engine && typeof engine.activateBotRuntime === 'function') {
    engine.activateBotRuntime(api)
  } else {
    registerFallbackHandlers(api)
  }
  if (api && api.log && typeof api.log.info === 'function') {
    api.log.info('群聊机器人已启动')
  }
}
