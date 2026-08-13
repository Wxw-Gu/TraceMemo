---
name: setup-wechat-share-card
description: 自动配置和部署 TraceMemo 实验性微信分享卡片服务。用户要求启用、部署、修复或迁移微信分享卡片，配置 Cloudflare Worker/R2/Wrangler，设置 UPLOAD_TOKEN、微信测试号 AppID/AppSecret、JS 接口安全域名，或希望由 Codex、Claude Code 等 Agent 代替手工阅读部署文档时使用。
---

# 部署微信分享卡片

尽量自行发现项目状态并完成部署。只在自动检查后仍缺少必要信息时，一次性询问用户；不要逐项反复确认。

## 安全边界

- 不把真实 AppSecret、`UPLOAD_TOKEN`、Cloudflare Token 或微信验证内容写入 Git。
- `.env.example` 只保存占位符；真实值写入项目根目录 `.env`，该文件必须被 Git 忽略。
- 不在最终回答中回显 Secret。日志中只报告“已配置/缺失”。
- `UPLOAD_TOKEN` 默认自动生成，不要求用户提供。
- AppID/AppSecret 必须来自用户自己的微信测试号或公众号。无法自动获取时才询问。
- 部署、创建 R2 和写 Secret 属于用户明确请求本 Skill 后的正常动作；不要提交、推送或创建 PR，除非用户另外明确要求。

## 自动工作流

1. 定位 TraceMemo 仓库根目录。确认存在 `services/share-card-worker/wrangler.jsonc`。
2. 运行：

   ```bash
   bash docs/skill/setup-wechat-share-card/scripts/setup.sh doctor
   ```

3. 检查根目录 `.env`。脚本会自动复用已有配置并生成缺失的 `WECHAT_SHARE_UPLOAD_TOKEN`。
4. 如果以下值缺失，只向用户发起一次集中询问：
   - 分享域名，例如 `share.example.com`；
   - 微信测试号 AppID；
   - 微信测试号 AppSecret。
5. 用户不知道从哪里获取时，告诉他打开：

   ```text
   https://mp.weixin.qq.com/debug/cgi-bin/sandboxinfo?action=showinfo&t=sandbox/index
   ```

   使用微信扫码登录后，复制页面上的 `appID` 和 `appsecret`。提醒用户把分享域名填入“JS 接口安全域名”，不带 `https://` 和路径。
6. 将缺失值交给交互脚本，不要把 Secret 放进命令行参数：

   ```bash
   bash docs/skill/setup-wechat-share-card/scripts/setup.sh configure
   ```

   该命令通过终端交互收集缺项，AppSecret 使用隐藏输入。
7. 执行完整部署：

   ```bash
   bash docs/skill/setup-wechat-share-card/scripts/setup.sh deploy
   ```

   脚本会依次：
   - 检查或临时下载 Wrangler；
   - 启动 Cloudflare OAuth 登录；
   - 执行 `whoami`；
   - 生成本地 `wrangler.local.jsonc`；
   - 创建或复用 R2 Bucket；
   - 写入三个 Worker Secret；
   - 部署 Worker；
   - 检查 `/health` 和微信签名接口。
8. OAuth 页面出现时，让用户只完成浏览器登录/授权；不要改用 API Token，除非用户主动要求。
9. 部署后把服务地址告诉用户，并提醒他在 TraceMemo 卡片弹窗粘贴 `.env` 中的 `WECHAT_SHARE_UPLOAD_TOKEN`。优先把 Token 复制到剪贴板，不在聊天中展示：

   ```bash
   bash docs/skill/setup-wechat-share-card/scripts/setup.sh copy-token
   ```

10. 如果微信要求 TXT 验证文件，读取 [references/wechat-domain-verification.md](references/wechat-domain-verification.md)，取得用户提供的文件后再修改 Worker。

## 决策规则

- Wrangler 未安装：优先使用项目依赖；否则通过 `pnpm dlx wrangler@latest` 临时下载，不强制全局安装。
- `whoami` 已登录正确账号：不要重复登录。
- R2 已存在：继续，不把“已存在”视为失败。
- 自定义域名有 A/AAAA/CNAME 冲突：报告准确域名并要求用户选择删除冲突记录或换子域名；不要擅自删除 DNS。
- HTTP 401：重新同步 `.env` 中的 `WECHAT_SHARE_UPLOAD_TOKEN` 到 Worker，再让用户更新 TraceMemo。
- “微信 JS-SDK 尚未配置”：重新写入 AppID/AppSecret 并部署。
- 微信返回 AppID/AppSecret 错误：让用户检查是否来自同一个测试号、AppSecret 是否已重置。
- 缺少 JS 接口安全域名或测试号关注：这是微信后台操作，明确告诉用户要填写什么，不要假装已完成。

## 验证结果

完成前必须确认：

- `wrangler whoami` 成功；
- Worker 部署成功；
- `/health` 返回 `storage: ready`；
- `/api/wx-signature` 返回 `appId`、`timestamp`、`nonceStr`、`signature`；
- Git 扫描未发现 `.env`、真实 AppSecret、上传密钥或用户域名被暂存。

详细产品和架构说明见：`docs/deployment/experimental-wechat-share-card.md`。
