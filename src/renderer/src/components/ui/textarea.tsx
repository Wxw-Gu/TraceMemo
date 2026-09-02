/* eslint-disable react/prop-types */
import * as React from 'react'
import { cn } from '../../lib/cn'

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-20 w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm text-foreground transition-colors duration-fast ease-tm-standard placeholder:text-muted-foreground hover:border-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-disabled-border disabled:bg-disabled-surface disabled:text-disabled-foreground disabled:opacity-100 disabled:placeholder:text-disabled-foreground',
      className
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'
