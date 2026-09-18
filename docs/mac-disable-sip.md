# macOS 关闭 SIP 教程

SIP（System Integrity Protection，系统完整性保护）是 macOS 的系统安全机制。关闭 SIP 会降低系统安全性，只建议在确实需要读取或调试本地微信数据时临时关闭；操作完成后，建议重新开启。

> 只在连接页面明确提示需要关闭 SIP 时才处理。首次连接失败时，先确认微信版本、账号目录和登录时机，再按本文操作。关闭 SIP 不是 TraceMemo 的常规安装步骤，也不应长期保持关闭。

## 准备

- 一台 Mac 电脑，Intel 芯片和 Apple Silicon 芯片均可。
- 需要进入 macOS 恢复模式。
- 请先保存正在编辑的文件，并预留一次重启时间。

## 关闭 SIP

### Intel Mac

1. 关机。
2. 按下开机键后，立刻按住 `Command + R`。
3. 保持按住，直到进入 macOS 恢复模式。

### Apple Silicon Mac（M1/M2/M3/M4/M5）

1. 关机。
2. 长按开机键不放。
3. 直到出现启动选项界面后松开。
4. 选择"选项"，进入 macOS 恢复模式。

### 在恢复模式中执行命令

1. 进入恢复模式后，点击顶部菜单栏的 **Utilities（实用工具）**。
2. 选择 **Terminal（终端）**。
3. 在终端中输入：

```bash
csrutil disable
```

4. 按回车执行。
5. 看到关闭成功提示后，重启电脑。

## 确认是否生效

重启回到正常桌面后，打开"终端"，执行：

```bash
csrutil status
```

看到 `System Integrity Protection status: disabled.` 才算关闭成功。

若仍显示 `enabled`，说明没有生效。常见原因是没在恢复模式里执行，或系统刚做过大版本更新——
macOS 大版本更新会把 SIP 重置回开启状态，此前关过也会失效，需要重新按上面的步骤操作。

## 重新开启 SIP

拿到数据库密钥后，建议重新进入恢复模式，在终端中执行：

```bash
csrutil enable
```

然后重启电脑，恢复系统安全设置。
