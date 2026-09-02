import * as React from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { cn } from '../../lib/cn'

const SegmentedControl = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root
    ref={ref}
    className={cn('inline-flex flex-wrap gap-1 rounded-md bg-muted p-1', className)}
    {...props}
  />
))
SegmentedControl.displayName = 'SegmentedControl'

const SegmentedControlItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      'inline-flex h-8 min-w-0 items-center justify-center rounded-sm border-0 bg-transparent px-3 text-xs font-medium text-muted-foreground transition-[color,background-color,font-weight,transform] duration-fast ease-tm-standard hover:bg-accent hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:text-disabled-foreground disabled:opacity-100 data-[state=checked]:bg-accent data-[state=checked]:font-semibold data-[state=checked]:text-accent-foreground',
      className
    )}
    {...props}
  />
))
SegmentedControlItem.displayName = 'SegmentedControlItem'

export { SegmentedControl, SegmentedControlItem }
