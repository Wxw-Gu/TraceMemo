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
  if (!source.includes('var activeTriggerX1Payload = ptr(0);')) return

  const activeSend = `    const payloadData = hexToByteArray(payloadHex);
    activeTriggerX1Payload = Memory.alloc(payloadData.length);
    activeTriggerX1Payload.writeByteArray(payloadData);
    activeTriggerX1Payload.add(0x18).writePointer(info.cgiAddr);
    activeTriggerX1Payload.add(0xb8).writePointer(activeTriggerX1Payload.add(0xc0));
    activeTriggerX1Payload.add(0x190).writePointer(activeTriggerX1Payload.add(0x198));`
  const upstreamSend = `    const payloadData = hexToByteArray(payloadHex);
    triggerX1Payload.writeByteArray(payloadData);
    triggerX1Payload.add(0x18).writePointer(info.cgiAddr);
    triggerX1Payload.add(0xb8).writePointer(triggerX1Payload.add(0xc0));
    triggerX1Payload.add(0x190).writePointer(triggerX1Payload.add(0x198));`
  if (!source.includes(activeSend)) throw new Error('无法定位 wechat_chatter 连续发送补丁位置')
  source = source
    .replace(
      'var triggerX1Payload;\nvar activeTriggerX1Payload = ptr(0);\nvar triggerX0;',
      'var triggerX1Payload;\nvar triggerX0;'
    )
    .replace(activeSend, upstreamSend)
    .replace(
      '        MMStartTask(triggerX0, activeTriggerX1Payload);',
      '        MMStartTask(triggerX0, triggerX1Payload);'
    )
    .replace(
      '        activeTriggerX1Payload = ptr(0);\n        console.error("[!] Error trigger " + msgType + " MMStartTask: " + e);',
      '        console.error("[!] Error trigger " + msgType + " MMStartTask: " + e);'
    )
    .replace(
      '\t\t\t\tpendingSendMsgType = "";\n\t\t\t\tactiveTriggerX1Payload = ptr(0);\n\t\t\t\treturn',
      '\t\t\t\tpendingSendMsgType = "";\n\t\t\t\treturn'
    )
  fs.writeFileSync(scriptPath, source)
  console.log('[wechat-personal] 已恢复原生发送 payload 布局')
}

function patchSendContextCapture(scriptPath, strict = true) {
  let source = fs.readFileSync(scriptPath, 'utf8')
  if (source.includes('function isLikelySendContext(')) return
  const original = `function AttachSendFunc() {
    Interceptor.attach(sendFuncAddr.add(0x10), {
        onEnter: function (args) {

            if (triggerX1Payload) {
                return
            }

            triggerX0 = this.context.x0;
            triggerX1Payload = this.context.x1;
            console.log(\`[+] 捕获到 StartTask 调用，X0：\${triggerX0}, Payload: \${triggerX1Payload}\`);
        }
    })
}`
  const patched = `function isLikelySendContext(candidateX0, candidateX1) {
    try {
        if (!isReadablePointer(candidateX0) || !isReadablePointer(candidateX1)) return false;
        var manager = readPointerIfReadable(candidateX0.add(0x18));
        var cgi = readUtf8StringIfReadable(readPointerIfReadable(candidateX1.add(0x18)));
        console.log("[debug] StartTask candidate x0=" + candidateX0 + " x1=" + candidateX1 + " x0+0x18=" + manager + " cgi=" + cgi);
        return !manager.equals(ptr(0));
    } catch (e) {
        console.error("[debug] StartTask candidate inspect failed: " + e);
        return false;
    }
}

function AttachSendFunc() {
    Interceptor.attach(sendFuncAddr.add(0x10), {
        onEnter: function (args) {
            if (triggerX1Payload) return;
            var candidateX0 = this.context.x0;
            var candidateX1 = this.context.x1;
            if (!isLikelySendContext(candidateX0, candidateX1)) return;
            triggerX0 = candidateX0;
            triggerX1Payload = candidateX1;
            console.log(\`[+] 捕获到有效 StartTask 上下文，X0：\${triggerX0}, Payload: \${triggerX1Payload}\`);
        }
    })
}`
  if (!source.includes(original)) {
    if (strict) throw new Error('无法定位 StartTask 上下文 Hook')
    return
  }
  source = source.replace(original, patched)
  fs.writeFileSync(scriptPath, source)
}

function patchVoiceAudioBuffer(scriptPath) {
  let source = fs.readFileSync(scriptPath, 'utf8')
  if (source.includes('voiceAudioDataAddr = Memory.alloc(audioLen + 1);')) return

  const staticAllocation = 'voiceAudioDataAddr = Memory.alloc(5 * 1024 * 1024); // 预分配5MB'
  if (!source.includes(staticAllocation)) {
    throw new Error('无法定位 wechat_chatter 语音缓冲区')
  }
  source = source.replace(
    staticAllocation,
    'voiceAudioDataAddr = Memory.alloc(1); // 上传前按语音长度重新分配'
  )
  const audioLengthMarker = '    const audioLen = audioBytes.length;\n'
  if (!source.includes(audioLengthMarker)) {
    throw new Error('无法定位 wechat_chatter 语音上传逻辑')
  }
  source = source.replace(
    audioLengthMarker,
    `${audioLengthMarker}    voiceAudioDataAddr = Memory.alloc(audioLen + 1);\n`
  )
  fs.writeFileSync(scriptPath, source)
  console.log('[wechat-personal] 已应用按语音长度分配上传缓冲区补丁')
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

// Backport of wechat_chatter PR #36 by @Leslielu:
// https://github.com/yincongcyincong/wechat_chatter/pull/36
// TraceMemo adds the verified macOS WeChat 4.1.11.53 addresses.
// macOS WeChat 4.1.11.53, located and verified by TraceMemo
function patchCdnColdStart(scriptPath) {
  let source = fs.readFileSync(scriptPath, 'utf8')
  if (source.includes('function resolveCdnManager()')) return

  const initAddresses = `    uploadImageAddr = baseAddr.add({{.uploadImageAddr}});
    cndOnCompleteAddr = baseAddr.add({{.cndOnCompleteAddr}});`
  const patchedInitAddresses = `    uploadImageAddr = baseAddr.add({{.uploadImageAddr}});
    cndOnCompleteAddr = baseAddr.add({{.cndOnCompleteAddr}});
    // 冷启动 CdnManager 解析（旧版本缺少可选键时保持 hook 捕获行为）
    {{if .cdnGetServiceAddr}}cdnGetServiceAddr = baseAddr.add({{.cdnGetServiceAddr}});{{end}}
    {{if .cdnManagerGetterAddr}}cdnManagerGetterAddr = baseAddr.add({{.cdnManagerGetterAddr}});{{end}}`
  if (!source.includes(initAddresses)) throw new Error('下载的微信版本配置与当前应用不兼容')
  source = source.replace(initAddresses, patchedInitAddresses)

  const downloadChunkEnd = `}

function fillUploadX1AndStart`
  const resolver = `}

// 上传和下载共用同一个 mars::cdn::CdnManager。冷启动时通过服务定位器
// 取得 [ctx + 0x40]，避免必须先手动发送图片才能让 Hook 捕获上下文。
function resolveCdnManager() {
    if (cdnGetServiceAddr.equals(ptr(0)) || cdnManagerGetterAddr.equals(ptr(0))) {
        return ptr(0);
    }
    try {
        // libc++ SSO 短字符串：数据在 +0，长度写在 +0x17。
        var strDefault = Memory.alloc(24);
        strDefault.writeUtf8String("default");
        strDefault.add(0x17).writeU8(7);

        var getService = new NativeFunction(cdnGetServiceAddr, 'pointer', ['pointer']);
        var svc = getService(strDefault);
        if (!isReadablePointer(svc)) {
            console.error("[!] GetService(\\"default\\") 返回不可读: " + svc);
            return ptr(0);
        }
        var getCtx = new NativeFunction(cdnManagerGetterAddr, 'pointer', ['pointer']);
        var ctx = getCtx(svc);
        if (!isReadablePointer(ctx)) {
            console.error("[!] CdnManager getter 返回不可读: " + ctx);
            return ptr(0);
        }
        var mgr = readPointerIfReadable(ctx.add(0x40));
        if (!isReadablePointer(mgr)) {
            console.error("[!] ctx+0x40 管理器指针不可读: ctx=" + ctx);
            return ptr(0);
        }
        return mgr;
    } catch (e) {
        console.error("[!] resolveCdnManager 异常: " + e);
        return ptr(0);
    }
}

function ensureCdnManagerX0() {
    if (uploadGlobalX0.equals(ptr(0)) && downloadGlobalX0 && !downloadGlobalX0.equals(ptr(0))) {
        uploadGlobalX0 = downloadGlobalX0;
        console.log("[+] downloadGlobalX0 回填 uploadGlobalX0: " + uploadGlobalX0);
    }
    if ((!downloadGlobalX0 || downloadGlobalX0.equals(ptr(0))) && !uploadGlobalX0.equals(ptr(0))) {
        downloadGlobalX0 = uploadGlobalX0;
        console.log("[+] uploadGlobalX0 回填 downloadGlobalX0: " + downloadGlobalX0);
    }
    if (uploadGlobalX0.equals(ptr(0))) {
        var mgr = resolveCdnManager();
        if (!mgr.equals(ptr(0))) {
            uploadGlobalX0 = mgr;
            if (!downloadGlobalX0 || downloadGlobalX0.equals(ptr(0))) {
                downloadGlobalX0 = mgr;
            }
            console.log("[+] 冷启动服务定位器解析 CdnManager: " + mgr);
        }
    }
    return !uploadGlobalX0.equals(ptr(0));
}

function fillUploadX1AndStart`
  if (!source.includes(downloadChunkEnd)) throw new Error('无法定位 wechat_chatter 媒体上传逻辑')
  source = source.replace(downloadChunkEnd, resolver)

  const declarations = 'var uploadImageAddr;\n'
  const patchedDeclarations =
    'var uploadImageAddr;\nvar cdnGetServiceAddr = ptr(0);\nvar cdnManagerGetterAddr = ptr(0);\n'
  if (!source.includes(declarations)) throw new Error('无法定位 wechat_chatter 媒体地址声明')
  source = source.replace(declarations, patchedDeclarations)

  const uploadGuard = `function fillUploadX1AndStart(idAddr, pathAddr, x1Buffer, receiver, md5, filePath, payloadHex) {
    if (uploadGlobalX0.equals(ptr(0))) {`
  const patchedUploadGuard = `function fillUploadX1AndStart(idAddr, pathAddr, x1Buffer, receiver, md5, filePath, payloadHex) {
    if (uploadGlobalX0.equals(ptr(0))) {
        ensureCdnManagerX0();
    }
    if (uploadGlobalX0.equals(ptr(0))) {`
  if (!source.includes(uploadGuard)) throw new Error('无法定位 wechat_chatter 媒体上传入口')
  source = source.replace(uploadGuard, patchedUploadGuard)

  const voiceGuard = `function triggerUploadVoice(receiver, voicePath, payloadHex, audioDataHex, durationMs) {
    if (uploadGlobalX0.equals(ptr(0))) {`
  const patchedVoiceGuard = `function triggerUploadVoice(receiver, voicePath, payloadHex, audioDataHex, durationMs) {
    if (uploadGlobalX0.equals(ptr(0))) {
        ensureCdnManagerX0();
    }
    if (uploadGlobalX0.equals(ptr(0))) {`
  if (!source.includes(voiceGuard)) throw new Error('无法定位 wechat_chatter 语音上传入口')
  source = source.replace(voiceGuard, patchedVoiceGuard)

  const uploadHook = `\t\t\tuploadGlobalX0 = capturedUploadX0;`
  const patchedUploadHook = `\t\t\tuploadGlobalX0 = capturedUploadX0;
            if ((!downloadGlobalX0 || downloadGlobalX0.equals(ptr(0))) && !capturedUploadX0.equals(ptr(0))) {
                downloadGlobalX0 = capturedUploadX0;
                console.log("[+] 上传hook回填 downloadGlobalX0: " + downloadGlobalX0);
            }`
  if (!source.includes(uploadHook)) throw new Error('无法定位 wechat_chatter 图片 Hook')
  source = source.replace(uploadHook, patchedUploadHook)

  const downloadHook = `            downloadGlobalX0 = this.context.x0;`
  const patchedDownloadHook = `            downloadGlobalX0 = this.context.x0;
            if (uploadGlobalX0.equals(ptr(0)) && !downloadGlobalX0.equals(ptr(0))) {
                uploadGlobalX0 = downloadGlobalX0;
                console.log("[+] 下载hook回填 uploadGlobalX0: " + uploadGlobalX0);
            }`
  if (!source.includes(downloadHook)) throw new Error('无法定位 wechat_chatter 下载 Hook')
  source = source.replace(downloadHook, patchedDownloadHook)

  const downloadGuard = `function triggerDownload(receiver, cdnUrl, aesKey, filePath, fileType) {
    if (!downloadGlobalX0) {`
  const patchedDownloadGuard = `function triggerDownload(receiver, cdnUrl, aesKey, filePath, fileType) {
    if (!downloadGlobalX0 || downloadGlobalX0.equals(ptr(0))) {
        ensureCdnManagerX0();
    }
    if (!downloadGlobalX0) {`
  if (!source.includes(downloadGuard)) throw new Error('无法定位 wechat_chatter 媒体下载入口')
  source = source.replace(downloadGuard, patchedDownloadGuard)

  fs.writeFileSync(scriptPath, source)
  console.log('[wechat-personal] 已应用 CdnManager 冷启动解析补丁')
}

function patchCdnColdStartConfig(configPath) {
  const source = fs.readFileSync(configPath, 'utf8')
  let config
  try {
    config = JSON.parse(source)
  } catch {
    throw new Error('4.1.11.53 版本配置不是有效 JSON')
  }
  config.cdnGetServiceAddr = '0x50a15d0'
  config.cdnManagerGetterAddr = '0x5259290'
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  console.log('[wechat-personal] 已写入 4.1.11.53 CdnManager 地址')
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
 * Changes: WeChat module discovery, per-send payload isolation, dynamic voice upload buffers,
 * CdnManager cold-start resolution, media hook backfill, and image Hook readiness logging.
 * These modifications are not provided by the upstream author.
 */

`
  source = notice + source
  fs.writeFileSync(scriptPath, source)
  console.log('[wechat-personal] 已写入 GPL 修改声明')
}

patchWechatCoreModuleBase(script)
patchPerSendPayload(script)
patchSendContextCapture(script)
patchVoiceAudioBuffer(script)
patchImageHookReadiness(script)
patchCdnColdStartConfig(config)
patchCdnColdStart(script)
addModifiedWorkNotice(script)
fs.chmodSync(executable, 0o755)
console.log('[wechat-personal] 运行时准备完成')
