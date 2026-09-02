import { cn } from '../../lib/cn'

export function Spinner({
  className,
  label = '加载中'
}: {
  className?: string
  label?: string
}): React.ReactElement {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent',
        className
      )}
    />
  )
}
