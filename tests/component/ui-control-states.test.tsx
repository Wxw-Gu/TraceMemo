import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  Button,
  Checkbox,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea
} from '../../src/renderer/src/components/ui'
import { IconButton } from '../../src/renderer/src/components/ui/icon-button'
import {
  SegmentedControl,
  SegmentedControlItem
} from '../../src/renderer/src/components/ui/segmented-control'

describe('TraceMemo UI control states', () => {
  it('uses the compact, standard, and form control height contract', () => {
    render(
      <>
        <Button size="sm">紧凑</Button>
        <Button>标准</Button>
        <Button size="lg">表单</Button>
        <Input aria-label="表单输入" />
      </>
    )

    expect(screen.getByRole('button', { name: '紧凑' })).toHaveClass('h-control-compact')
    expect(screen.getByRole('button', { name: '标准' })).toHaveClass('h-control-standard')
    expect(screen.getByRole('button', { name: '表单' })).toHaveClass('h-control-form')
    expect(screen.getByRole('textbox', { name: '表单输入' })).toHaveClass('h-control-form')
  })

  it('keeps secondary and icon actions visually quiet by default', () => {
    render(
      <>
        <Button variant="outline">次要操作</Button>
        <IconButton label="刷新" tooltip="">
          ↻
        </IconButton>
      </>
    )

    expect(screen.getByRole('button', { name: '次要操作' })).toHaveClass(
      'border-border-subtle',
      'bg-transparent'
    )
    expect(screen.getByRole('button', { name: '刷新' })).toHaveClass(
      'text-foreground',
      'hover:bg-accent'
    )
    expect(screen.getByRole('button', { name: '刷新' })).not.toHaveClass('bg-primary')
  })

  it('uses a surface-free selected contract for segmented choices', () => {
    render(
      <SegmentedControl aria-label="模式" defaultValue="one">
        <SegmentedControlItem value="one">一</SegmentedControlItem>
        <SegmentedControlItem value="two">二</SegmentedControlItem>
      </SegmentedControl>
    )

    const selected = screen.getByRole('radio', { name: '一' })
    expect(selected).toHaveClass(
      'data-[state=checked]:bg-accent',
      'data-[state=checked]:font-semibold'
    )
    expect(selected).not.toHaveClass('data-[state=checked]:shadow-surface')
  })

  it('keeps disabled controls readable without the old opacity and surface shadow', () => {
    render(
      <>
        <Button disabled>不可用操作</Button>
        <Input aria-label="不可用输入" value="仍可读取" disabled readOnly />
        <Textarea aria-label="不可用多行输入" value="仍可读取" disabled readOnly />
        <Checkbox aria-label="不可用多选" disabled />
        <RadioGroup aria-label="不可用单选组">
          <RadioGroupItem value="disabled" aria-label="不可用单选" disabled />
        </RadioGroup>
        <Switch aria-label="不可用开关" disabled />
      </>
    )

    for (const control of [
      screen.getByRole('button', { name: '不可用操作' }),
      screen.getByRole('textbox', { name: '不可用输入' }),
      screen.getByRole('textbox', { name: '不可用多行输入' }),
      screen.getByRole('checkbox', { name: '不可用多选' }),
      screen.getByRole('radio', { name: '不可用单选' }),
      screen.getByRole('switch', { name: '不可用开关' })
    ]) {
      expect(control).toHaveClass('disabled:opacity-100')
      expect(control).not.toHaveClass('shadow-surface')
    }

    expect(screen.getByRole('button', { name: '不可用操作' })).toHaveClass(
      'disabled:bg-disabled-surface',
      'disabled:text-disabled-foreground',
      'disabled:!text-disabled-foreground'
    )
    expect(screen.getByRole('textbox', { name: '不可用多行输入' })).toHaveClass(
      'border-border-subtle',
      'disabled:border-disabled-border',
      'disabled:bg-disabled-surface',
      'disabled:text-disabled-foreground'
    )
    expect(screen.getByRole('textbox', { name: '不可用多行输入' })).not.toHaveClass(
      'shadow-surface'
    )
    expect(screen.getByRole('checkbox', { name: '不可用多选' })).toHaveClass(
      'border-muted-foreground/60'
    )
    expect(screen.getByRole('radio', { name: '不可用单选' })).toHaveClass(
      'border-muted-foreground/60'
    )
  })

  it('keeps selection semantics while removing text glyph indicators', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Select defaultValue="recent">
          <SelectTrigger aria-label="时间范围">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">最近 30 天</SelectItem>
            <SelectItem value="all">全部时间</SelectItem>
          </SelectContent>
        </Select>
        <Checkbox aria-label="包含图片" />
        <RadioGroup aria-label="密度" defaultValue="compact">
          <RadioGroupItem value="compact" aria-label="紧凑密度" />
          <RadioGroupItem value="comfortable" aria-label="舒适密度" />
        </RadioGroup>
        <Switch aria-label="显示头像" />
      </>
    )

    const trigger = screen.getByRole('combobox', { name: '时间范围' })
    expect(trigger).not.toHaveTextContent('⌄')
    await user.click(trigger)
    expect(await screen.findByRole('option', { name: '最近 30 天' })).not.toHaveTextContent('✓')
    await user.keyboard('{Escape}')

    const checkbox = screen.getByRole('checkbox', { name: '包含图片' })
    await user.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(checkbox).not.toHaveTextContent('✓')

    await user.click(screen.getByRole('radio', { name: '舒适密度' }))
    expect(screen.getByRole('radio', { name: '舒适密度' })).toBeChecked()

    const toggle = screen.getByRole('switch', { name: '显示头像' })
    expect(toggle).toHaveClass('h-5', 'w-9', 'border-0', 'p-0.5')
    expect(toggle.firstElementChild).toHaveClass('h-4', 'w-4')
    await user.click(toggle)
    expect(toggle).toBeChecked()
  })
})
