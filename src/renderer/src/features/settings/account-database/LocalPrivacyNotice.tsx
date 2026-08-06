function ShieldIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5 19 6v5.8c0 4.5-3 7.5-7 8.7-4-1.2-7-4.2-7-8.7V6l7-2.5Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

export function LocalPrivacyNotice(): React.ReactElement {
  return (
    <section className="settings-privacy-notice">
      <ShieldIcon />
      <div>
        <strong>AI Search 的数据发送范围</strong>
        <p>
          使用 AI Search 且你确认后，当前显示的远程 AI Provider 可能收到：当前用户问题、受控检索所需的受限上下文，以及最终用于总结的 Evidence。不会发送完整微信数据库、全量聊天记录、未选中的聊天范围、密钥、内部索引结构或内部会话/消息引用 ID。本地解析、索引和原始聊天记录仍保留在本机。
        </p>
      </div>
    </section>
  )
}
