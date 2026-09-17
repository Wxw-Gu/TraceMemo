# 界面开发规范：按钮与主题色

这份规范回答一件事：**为什么同一个产品里，有的按钮是主题色，有的还是浏览器默认的黑白方角。**

先看一个真实案例 —— 同一屏里的两组按钮：

```
主界面：「更新图片文字索引」        ← 主题色（正确）
弹窗里：「取消」「开始索引」        ← 浏览器默认样式（错误）
```

两者渲染出来完全不同，用户会以为是两个不同的产品。根因不是"设计没定颜色"，
而是**组件在导出时把样式丢了**。下面写清楚怎么避免。

---

## 1. 永远不要写裸 `<button>`

任何可点的按钮都必须来自 `components/ui/button`：

```tsx
import { Button } from '../ui'

<Button variant="outline" onClick={handleCancel}>取消</Button>
```

**唯一的例外**：结构性控件（导航项、Tab、列表行、图标热区）——它们有自己
成套的布局样式，用原生 `<button>` 是合理的，但**必须**带 `className`，
且样式写在对应的 `.scss` 里，不要在 JSX 里临时拼颜色。

```tsx
// 可以：结构性控件，样式来自 .scss
<button type="button" role="tab" className={active ? 'active' : ''} onClick={...}>
  今日日报
</button>
```

**判据**：如果这个按钮在别的界面也会以同样形态出现（"取消"、"保存"、"删除"），
它就该是 `Button`；如果它只在某一个位置有意义（侧栏导航项），才考虑原生。

---

## 2. 三种角色，只有三个默认变体

`Button` 提供 6 个变体，但**日常只用其中 3 个**：

| 角色 | `variant` | 长什么样 | 用在哪 |
| --- | --- | --- | --- |
| 主要 | `default` | 主题色实底 | 这一步用户唯一该做的事 |
| 次要 | `outline` / `ghost` | 描边 / 无底色 | 取消、返回、并列的辅助操作 |
| 危险 | `destructive` | 红色实底 | 删除、清空、不可恢复的操作 |

另外两个（`secondary` / `link`）按需用；`link` 只用于正文里的行内跳转。

**一条硬约束：同一个界面（或同一个弹窗）里，`default` 最多出现一次。**
两个主题色实底按钮并排，等于没有主次。

---

## 3. 弹窗按钮：组件已经带样式了，不要再包一层

`AlertDialogCancel` 和 `AlertDialogAction` **自带**按钮样式（分别是 `outline`
和 `default`），直接写文字即可：

```tsx
<AlertDialogFooter>
  <AlertDialogCancel>取消</AlertDialogCancel>
  <AlertDialogAction onClick={handleStart}>开始索引</AlertDialogAction>
</AlertDialogFooter>
```

**不要**再套一层 `Button`：

```tsx
// 反面写法：外层已经有样式了，再包一层只会产生重复类名
<AlertDialogCancel asChild>
  <Button variant="outline">取消</Button>
</AlertDialogCancel>
```

需要危险动作时，用 `className` 覆盖（`cn` 走 tailwind-merge，同族类后者生效）：

```tsx
<AlertDialogAction className="bg-destructive text-destructive-foreground">
  删除
</AlertDialogAction>
```

---

## 4. 颜色只能用语义 token，禁止硬编码

颜色全部走 Tailwind 的语义类，它们背后是 `--tm-*` 变量，换主题时自动跟随：

```
背景   bg-primary / bg-surface / bg-accent / bg-destructive
文字   text-foreground / text-primary-foreground / text-muted-foreground
描边   border-border / border-border-subtle / border-disabled-border
```

```tsx
// 对
<Button className="bg-primary text-primary-foreground">保存</Button>

// 错 —— 换主题时这行不会跟着变
<Button className="bg-[#247a63] text-white">保存</Button>
```

**判据**：JSX 里出现 `#` 开头的颜色、`rgb(...)`、或 Tailwind 的调色板名
（`bg-green-600`、`text-slate-500`）—— 都是漏用 semantic token 的信号。

---

## 5. 「默认样式」的三个常见来源

排查界面里冒出来的黑白方角按钮时，按这个顺序找：

**① 组件导出时把样式丢了。** 最常见。把 Radix 的 primitive 原样导出：

```tsx
// 错：渲染出来就是浏览器默认按钮
const AlertDialogCancel = AlertDialogPrimitive.Cancel
```

正确做法是 `forwardRef` 包一层，挂上 `buttonVariants`：

```tsx
const AlertDialogCancel = React.forwardRef<...>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Cancel
    ref={ref}
    className={cn(buttonVariants({ variant: 'outline' }), className)}
    {...props}
  />
))
```

**判据**：`components/ui/` 里凡是导出 Radix primitive 的地方，都要确认它是
"样式化的封装"还是"原样透传"。原样透传只对布局容器（`Root` / `Portal` /
`Group`）成立，对**可点元素**（`Close` / `Action` / `Cancel` / `Item`）不成立。

**② `asChild` 里重复包了一层。** 外层已经带样式、子元素又带一次，虽然因为
同族类后生效而不会出错，但会产生冗余类名。**能去掉一层就去掉。**

**③ 原生 `<button>` 忘写 `className`。** 见第 1 节的例外条款 —— 结构性控件也必须
有样式来源。

---

## 6. 提交前检查清单

- [ ] 新增的可点元素来自 `Button`，不是裸 `<button>`
- [ ] 同一界面里 `default` 变体不超过一个
- [ ] 危险操作走 `destructive`，不是红色硬编码
- [ ] 弹窗按钮没有重复包 `Button`
- [ ] JSX 里没有 `#` 开头的颜色、没有 Tailwind 调色板名
- [ ] `components/ui/` 里新导出的可点 primitive 已经挂上 `buttonVariants`
- [ ] 组件测试覆盖到按钮的可见性与点击行为（testid 用 `xxx-yyy` 连字符命名）

---

## 7. 一个反面案例的复盘

弹窗里的「取消 / 开始索引」显示成浏览器默认样式，原因就是第 5 节第 ① 条：
`alert-dialog.tsx` 把 `Cancel` / `Action` 两个 primitive 原样导出了。

修复是给它们各加一个 `forwardRef` 封装，挂上 `buttonVariants`。**组件本身没坏**，
所有调用方一行不用改，样式自动生效 —— 这正是把样式收在 `components/ui/` 里的价值：
**修一处，全产品对齐。**

如果你发现某个地方的按钮"没跟上主题"，先别去改那个界面 ——
**先看它用的组件是不是漏了样式。**
