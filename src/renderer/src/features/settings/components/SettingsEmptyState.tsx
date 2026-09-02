export function SettingsEmptyState({
  label,
  description = '当前分类暂无额外设置。'
}: {
  label: string
  description?: string
}): React.ReactElement {
  return (
    <div className="settings-empty-state">
      <h2>{label}</h2>
      <p>{description}</p>
    </div>
  )
}
