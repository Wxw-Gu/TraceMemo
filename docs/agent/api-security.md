# Local API Security

WechatExplorer 的安全模型是：本机回环地址 + 高熵 Bearer Token。

- Token 使用密码学安全随机源生成，并由 Electron safeStorage 加密保存。
- 应用升级或首次启动时自动、幂等生成；应用重启后保持不变。
- API Center 可以显示、复制或重新生成 Token。重新生成后旧 Token 立即失效。
- `/api/v1/health` 公开且不返回聊天内容、数据库路径、Token 或 Provider 信息。
- 其他 endpoint 缺少或使用错误 Token 时返回 `401 Unauthorized`。
- CORS 仅允许精确的 localhost、127.0.0.1 和 ::1 HTTP Origin；无 Origin 的 curl、Node 和本地 Agent 请求正常工作。

本地 API 不应暴露到公网或不受信任网络。Bearer Token 提供本机 API 访问保护，但不是公网网关、用户账户系统或完整权限 Scope 系统。
