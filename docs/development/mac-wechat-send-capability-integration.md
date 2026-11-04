# macOS 版本发送能力二次开发

如果你已经拥有 TraceMemo 发送能力授权，并希望基于源码进行二次开发，请联系授权人获取开发环境所需的发送能力组件包。

## 1. 安装发送能力组件

获取组件包后，将以下文件放到项目对应目录：

| 组件                    | 放入目录                          |
| ----------------------- | --------------------------------- |
| `tm-wechat-host`        | `resources/runtime/darwin-arm64/` |
| `libtmwechat.dylib`     | `resources/runtime/darwin-arm64/` |
| `runtime-manifest.json` | `resources/runtime/darwin-arm64/` |
| `libwcdb_api.dylib`     | `resources/wcdb/macos/arm64/`     |
| `libWCDB.dylib`         | `resources/wcdb/macos/arm64/`     |
| `tm-wcdb-config-helper` | `resources/wcdb/macos/arm64/`     |
| `libtmlicense.dylib`    | `resources/wcdb/macos/arm64/`     |

完成后，为以下两个文件添加执行权限：

```bash
chmod 755 resources/runtime/darwin-arm64/tm-wechat-host
chmod 755 resources/wcdb/macos/arm64/tm-wcdb-config-helper
```

完成配置后，启动 TraceMemo 开发环境，在「设置 → 微信发送」中查看发送能力与授权状态。

**注意：** 发送能力组件不包含授权。开发环境仍需使用有效的设备授权才能绑定微信和发送消息。
