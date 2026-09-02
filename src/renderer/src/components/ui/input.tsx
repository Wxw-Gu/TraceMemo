/* eslint-disable react/prop-types */
import * as React from 'react'
import { cn } from '../../lib/cn'

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = 'text', ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'flex h-control-form w-full rounded-md border border-border-subtle bg-surface px-3 py-1 text-sm text-foreground transition-colors duration-fast ease-tm-standard placeholder:text-muted-foreground hover:border-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-disabled-border disabled:bg-disabled-surface disabled:text-disabled-foreground disabled:opacity-100 disabled:placeholder:text-disabled-foreground',
      className
    )}
    {...props}
  />
))
Input.displayName = 'Input'
