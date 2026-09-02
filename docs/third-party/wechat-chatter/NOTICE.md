# wechat_chatter / OneBot 第三方组件说明

TraceMemo 的 macOS 个人微信发送功能会按需使用以下第三方组件：

- 项目：`yincongcyincong/wechat_chatter`
- 上游仓库：https://github.com/yincongcyincong/wechat_chatter
- 当前运行时版本：`v0.0.18`
- 运行时文件：`onebot_mac_arm64.tar.gz`
- 许可证：GNU General Public License version 3（GPL-3.0）
- 上游版权：Copyright (C) 2026 yincongcyincong
- TraceMemo 修改日期：2026-08-17

## 集成方式

OneBot 运行时不会随 TraceMemo 安装包一起分发。用户启用该实验性功能时，TraceMemo 会从上述上游项目的 GitHub Release 按需下载运行时，并将其安装到应用的用户数据目录。

运行时作为独立进程启动，TraceMemo 通过本机 HTTP 接口与其通信。

## 本地修改

为适配连续发送、图片上传 Hook 状态检测以及微信核心模块基址定位，TraceMemo 会在用户设备上对上游 `onebot/script.js` 应用兼容性补丁。补丁逻辑位于：

- `scripts/prepare-wechat-chatter-runtime.cjs`
- `src/main/services/personal-wechat-runtime-manager.ts`

补丁中源自或修改自上游 `script.js` 的部分，以及补丁应用后产生的修改版 `script.js`，继续按照 GPL-3.0 提供。本说明只针对该第三方组件及相关修改，不用于声明 TraceMemo 仓库其他部分的许可证。

GPL-3.0 的完整文本见本目录下的 `LICENSE`。
