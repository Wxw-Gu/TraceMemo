/**
 * Query Agent POC 的 CLI 参数解析。
 *
 * 单独抽成纯函数，便于单测；避免 entry 文件的副作用（app bootstrap / app.whenReady）影响测试。
 */
export function parsePocQuestion(argv: readonly string[]): string {
  const args = [...argv]
  // npm / pnpm 在复合 script（`build && electron ...`）里会把 `--` 一并追加到命令末尾，
  // 于是 separator 会落到 POC 的 argv 里，污染问题正文。
  // 只移除开头的这一个独立 separator；问题正文中间的合法 `--` 必须保留。
  if (args[0] === '--') args.shift()
  return args.join(' ').trim()
}
