# 微信系统消息（sysmsg）解析与格式兼容

微信的「系统消息」（入群、撤回、成员变动等）以 XML（`<sysmsg>`）存放在消息内容里，
但**同一类提示的 XML 结构会随客户端版本变化**。本文说明 TraceMemo 的解析方式，
以及在遇到新格式时应当怎么扩展。

## 两类格式

### 旧格式：正文直接放在 `<plain>`

```xml
<sysmsg type="delchatroommember">
  <delchatroommember>
    <plain><![CDATA["成员昵称"通过扫描你分享的二维码加入群聊]]></plain>
    <text><![CDATA["成员昵称"通过扫描你分享的二维码加入群聊]]></text>
    <link>
      <scene>qrcode</scene>
      <text><![CDATA[撤销]]></text>
    </link>
  </delchatroommember>
</sysmsg>
```

解析：命中 `delchatroommember`，直接取 `<plain>`。

### 新格式：正文在 `<template>`，用 `$名称$` 引用 link

```xml
<sysmsg type="sysmsgtemplate">
  <sysmsgtemplate>
    <content_template type="tmpl_type_profilewithrevokeqrcode">
      <plain><![CDATA[]]></plain>
      <template><![CDATA["$adder$"通过扫描你分享的二维码加入群聊  $revoke$]]></template>
      <link_list>
        <link name="adder" type="link_profile">
          <memberlist><member>
            <username><![CDATA[wxid_xxxxxxxx]]></username>
            <nickname><![CDATA[成员昵称]]></nickname>
          </member></memberlist>
        </link>
        <link name="revoke" type="link_revoke_qrcode" hidden="1">
          <title><![CDATA[撤销]]></title>
        </link>
      </link_list>
    </content_template>
  </sysmsgtemplate>
</sysmsg>
```

三个要点：

- `<plain>` 变成**空 CDATA**，正文挪进 `<template>`；
- 正文里的 `$名称$` 是占位符，按 `<link_list>` 中 `link[name]` 回填；
- `hidden="1"` 的 link 在微信里是**可点击按钮**，纯文本展示时应省略其文案。

## 解析流程

`src/main/message-parser.ts` 的 `parseSystemMessage()` 按以下顺序尝试：

| 顺序 | 分支 | 处理对象 |
| --- | --- | --- |
| 1 | `extractRecallMessage` | `<revokemsg>` 撤回通知 |
| 2 | `extractSysmsgTemplateText` | `<sysmsgtemplate>` 模板消息 |
| 3 | `extractDelChatroomMemberText` | `<delchatroommember>` 成员变动 |
| 4 | 通用提取（`plain` → `text` → `title`），再退回 `fallbackSystemText` | 其余未覆盖类型 |

第 4 步之前会先调用 `stripSysmsgLinkList()` 剥掉 `<link_list>`。

## 为什么必须显式处理新格式

通用提取链只在第 1～3 步全部落空时才执行，而新格式恰好让它落空：
`<plain>` 是空 CDATA，又没有 `<text>`，于是取到 `<title>` ——
那是 `hidden="1"` 按钮的标题。**结果是整条系统消息只剩一个按钮文案**，
例如把「某某通过扫描你分享的二维码加入群聊」显示成「撤销」。

因此三处约束缺一不可：

1. 模板分支必须排在通用提取之前；
2. 占位符回填必须尊重 `hidden="1"`；
3. 通用提取前先剥 `<link_list>`，作为未知类型的防护。

## 新增一类系统消息时

1. 从真实消息中取出 `content`（`<sysmsg>` 原文），确认 `type` 与承载正文的标签；
2. 在 `parseSystemMessage()` 里加一个**早于通用提取**的分支；
3. 补 `tests/unit/message-parser.test.ts` 用例，**新旧两版各一条**，防止回归；
4. 文档与代码注释只写结构，不粘贴真实会话内容、昵称、wxid 或二维码链接。

## 相关位置

- 解析实现：`src/main/message-parser.ts`
- 单元测试：`tests/unit/message-parser.test.ts`
