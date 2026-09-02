import * as React from 'react'
import { Button, type ButtonProps } from './button'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

export interface IconButtonProps extends Omit<ButtonProps, 'size' | 'children'> {
  label: string
  children: React.ReactNode
  tooltip?: string
}

export function IconButton({
  label,
  tooltip = label,
  children,
  variant = 'ghost',
  ...props
}: IconButtonProps): React.ReactElement {
  const button = (
    <Button aria-label={label} size="icon" variant={variant} {...props}>
      {children}
    </Button>
  )

  if (!tooltip) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
