/*
 * wechat_chatter runtime integration
 *
 * Upstream: https://github.com/yincongcyincong/wechat_chatter
 * Runtime version: v0.0.18
 * Upstream license: GNU General Public License version 3 (GPL-3.0)
 *
 * This file applies local compatibility patches to the upstream
 * onebot/script.js. See docs/third-party/wechat-chatter/NOTICE.md.
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const release = 'v0.0.18'
const asset = 'onebot_mac_arm64.tar.gz'
const url = `https://github.com/yincongcyincong/wechat_chatter/releases/download/${release}/${asset}`
const projectRoot = path.resolve(__dirname, '..')
const outputDir = path.join(
  projectRoot,
  'resources',
  'connectors',
  'wechat-personal',
  'darwin-arm64'
)
const archive = path.join(os.tmpdir(), `wechat-chatter-${release}-${asset}`)
const appleSilicon =
  process.platform === 'darwin' &&
  execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1'

if (!appleSilicon) {
  throw new Error('个人微信发送运行时当前仅支持 macOS arm64')
}

fs.mkdirSync(outputDir, { recursive: true })
let archiveReady = false
if (fs.existsSync(archive)) {
  try {
    execFileSync('/usr/bin/tar', ['-tzf', archive], { stdio: 'ignore' })
    archiveReady = true
    console.log(`[wechat-personal] 复用已下载归档：${archive}`)
  } catch {
    // The archive is partial or invalid; curl will resume it below.
  }
}
if (!archiveReady) {
  console.log(`[wechat-personal] 下载 ${release}，支持断点续传：${archive}`)
  execFileSync(
    '/usr/bin/curl',
    ['--http1.1', '-L', '--fail', '--retry', '3', '--continue-at', '-', '--output', archive, url],
    { stdio: 'inherit' }
  )
}

const extractionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-chatter-extract-'))
console.log(`[wechat-personal] 解压并原子安装到 ${outputDir}`)
try {
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', extractionDir], { stdio: 'inherit' })
  fs.mkdirSync(path.join(outputDir, 'onebot'), { recursive: true })
  fs.mkdirSync(path.join(outputDir, 'wechat_version'), { recursive: true })
  fs.copyFileSync(
    path.join(extractionDir, 'onebot', 'script.js'),
    path.join(outputDir, 'onebot', 'script.js')
  )
  fs.cpSync(path.join(extractionDir, 'wechat_version'), path.join(outputDir, 'wechat_version'), {
    recursive: true,
    force: true
  })
  const stagedExecutable = path.join(outputDir, 'onebot', `.onebot-${process.pid}.tmp`)
  fs.copyFileSync(path.join(extractionDir, 'onebot', 'onebot'), stagedExecutable)
  fs.chmodSync(stagedExecutable, 0o755)
  fs.renameSync(stagedExecutable, path.join(outputDir, 'onebot', 'onebot'))
} finally {
  fs.rmSync(extractionDir, { recursive: true, force: true })
}

const executable = path.join(outputDir, 'onebot', 'onebot')
const script = path.join(outputDir, 'onebot', 'script.js')
const config = path.join(outputDir, 'wechat_version', '4_1_11_53_mac.json')
for (const required of [executable, script, config]) {
  if (!fs.existsSync(required)) throw new Error(`运行时文件缺失：${required}`)
}

function patchPerSendPayload(scriptPath) {
  let source = fs.readFileSync(scriptPath, 'utf8')
  if (source.includes('var activeTriggerX1Payload = ptr(0);')) return

  const declarations = 'var triggerX1Payload;\nvar triggerX0;'
  const patchedDeclarations =
    'var triggerX1Payload;\nvar activeTriggerX1Payload = ptr(0);\nvar triggerX0;'
  const originalSend = `    const payloadData = hexToByteArray(payloadHex);
    triggerX1Payload.writeByteArray(payloadData);
    triggerX1Payload.add(0x18).writePointer(info.cgiAddr);
    triggerX1Payload.add(0xb8).writePointer(triggerX1Payload.add(0xc0));
    triggerX1Payload.add(0x190).writePointer(triggerX1Payload.add(0x198));`
  const patchedSend = `    const payloadData = hexToByteArray(payloadHex);
    activeTriggerX1Payload = Memory.alloc(payloadData.length);
    activeTriggerX1Payload.writeByteArray(payloadData);
    activeTriggerX1Payload.add(0x18).writePointer(info.cgiAddr);
    activeTriggerX1Payload.add(0xb8).writePointer(activeTriggerX1Payload.add(0xc0));
    activeTriggerX1Payload.add(0x190).writePointer(activeTriggerX1Payload.add(0x198));`

  if (!source.includes(declarations) || !source.includes(originalSend)) {
    throw new Error('无法定位 wechat_chatter 连续发送补丁位置')
  }
  source = source.replace(declarations, patchedDeclarations).replace(originalSend, patchedSend)
  source = source.replace(
    '        MMStartTask(triggerX0, triggerX1Payload);',
    '        MMStartTask(triggerX0, activeTriggerX1Payload);'
  )
  source = source.replace(
    '    } catch (e) {\n        console.error("[!] Error trigger " + msgType + " MMStartTask: " + e);',
    '    } catch (e) {\n        activeTriggerX1Payload = ptr(0);\n        console.error("[!] Error trigger " + msgType + " MMStartTask: " + e);'
  )
  source = source.replace(
    '\t\t\t\tpendingSendMsgType = "";\n\t\t\t\treturn',
    '\t\t\t\tpendingSendMsgType = "";\n\t\t\t\tactiveTriggerX1Payload = ptr(0);\n\t\t\t\treturn'
  )
  fs.writeFileSync(scriptPath, source)
  console.log('[wechat-personal] 已应用逐条发送 payload 隔离补丁')
}

function patchImageHookReadiness(scriptPath) {
  let source = fs.readFileSync(scriptPath, 'utf8')
  if (
    source.includes('捕获到图片上传上下文，uploadGlobalX0') &&
    source.includes('图片上传 Hook Setup Complete')
  )
    return
  const original = `\t\t\tuploadGlobalX0 = this.context.x0;`
  const patched = `\t\t\tconst capturedUploadX0 = this.context.x0;
\t\t\tif (uploadGlobalX0.equals(ptr(0)) && !capturedUploadX0.equals(ptr(0))) {
\t\t\t\tconsole.log("[+] 捕获到图片上传上下文，uploadGlobalX0：" + capturedUploadX0);
\t\t\t}
\t\t\tuploadGlobalX0 = capturedUploadX0;`
  if (!source.includes(original)) throw new Error('无法定位 wechat_chatter 图片 Hook 状态补丁位置')
  source = source.replace(original, patched)
  source = source.replace(
    '    })\n}\n\n\n\nfunction patchCdnOnComplete()',
    '    })\n    console.log("[+] 图片上传 Hook Setup Complete.");\n}\n\n\n\nfunction patchCdnOnComplete()'
  )
  fs.writeFileSync(scriptPath, source)
  console.log('[wechat-personal] 已应用图片 Hook 状态补丁')
}

function patchWechatCoreModuleBase(scriptPath) {
  let source = fs.readFileSync(scriptPath, 'utf8')
  if (source.includes('WeChat core module base:')) return
  const initMarker = 'function initAddresses() {'
  const initIndex = source.indexOf(initMarker)
  if (initIndex < 0 || !source.startsWith('var targetPath = ')) {
    throw new Error('无法定位 wechat_chatter 基址扫描逻辑')
  }
  const patchedHeader = `var targetPath = "/Applications/WeChat.app/Contents/Resources/wechat.dylib";
var module = Process.enumerateModules().find(function(m) {
    return m.path === targetPath || m.path.endsWith("/Contents/Resources/wechat.dylib");
});
if (!module) {
    throw new Error("[-] Cannot find WeChat core module: " + targetPath);
}
var moduleBase = module.base;
var baseAddr = moduleBase;
console.log("[+] WeChat core module base: " + baseAddr + " path=" + module.path);
setImmediate(initAddresses);

`
  source = patchedHeader + source.slice(initIndex)
  fs.writeFileSync(scriptPath, source)
  console.log('[wechat-personal] 已应用微信核心模块基址补丁')
}

function addModifiedWorkNotice(scriptPath) {
  let source = fs.readFileSync(scriptPath, 'utf8')
  if (source.includes('TraceMemo wechat_chatter compatibility modifications')) return

  const notice = `/*
 * TraceMemo wechat_chatter compatibility modifications
 * Modified: 2026-08-17
 * Upstream: https://github.com/yincongcyincong/wechat_chatter
 * Runtime version: v0.0.18
 * License: GNU General Public License version 3 (GPL-3.0)
 * Changes: WeChat module discovery, per-send payload isolation, and image Hook readiness logging.
 * These modifications are not provided by the upstream author.
 */

`
  source = notice + source
  fs.writeFileSync(scriptPath, source)
  console.log('[wechat-personal] 已写入 GPL 修改声明')
}

patchWechatCoreModuleBase(script)
patchPerSendPayload(script)
patchImageHookReadiness(script)
addModifiedWorkNotice(script)
fs.chmodSync(executable, 0o755)
console.log('[wechat-personal] 运行时准备完成')
