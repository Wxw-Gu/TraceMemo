import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border-0 bg-transparent text-sm font-medium transition-[color,background-color,border-color,transform] duration-fast ease-tm-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:translate-y-0 disabled:!text-disabled-foreground disabled:opacity-100',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary-hover disabled:bg-disabled-surface disabled:text-disabled-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/75 active:bg-secondary/60 disabled:bg-disabled-surface disabled:text-disabled-foreground',
        ghost:
          'text-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent/75 disabled:text-disabled-foreground',
        outline:
          'border border-border-subtle bg-transparent text-foreground hover:border-primary/20 hover:bg-accent active:border-primary/30 active:bg-accent/75 disabled:border-disabled-border disabled:bg-disabled-surface disabled:text-disabled-foreground',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80 disabled:bg-disabled-surface disabled:text-disabled-foreground',
        link: '!h-auto !p-0 text-primary underline-offset-4 hover:text-primary-hover hover:underline disabled:text-disabled-foreground'
      },
      size: {
        sm: 'h-control-compact rounded-md px-2.5 text-xs',
        default: 'h-control-standard px-3.5',
        lg: 'h-control-form rounded-lg px-5',
        icon: 'h-control-standard w-8 p-0'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
)
Button.displayName = 'Button'

// eslint-disable-next-line react-refresh/only-export-components
export { buttonVariants }
