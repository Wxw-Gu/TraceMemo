import { DEFAULT_REPORT_IMAGE_POSTFIX_TEXT } from '../../../../shared/personal-wechat'

export function ReportImagePostfixInput({
  value,
  onChange,
  onBlur,
  disabled
}: {
  value: string
  onChange: (value: string) => void
  onBlur: () => void
  disabled: boolean
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">发送后置词</span>
      <input
        aria-label="发送后置词"
        className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary disabled:opacity-60"
        value={value}
        maxLength={200}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder={DEFAULT_REPORT_IMAGE_POSTFIX_TEXT}
      />
      <span className="text-xs text-muted-foreground">
        图片确认发送成功后，会发送一条文本消息；留空则只发图片。
      </span>
    </label>
  )
}
