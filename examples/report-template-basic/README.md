# TraceMemo 日报模板示例

此目录是可安装的最小日报模板源文件，使用全部虚构数据进行预览。运行 `node scripts/build-report-template-example.cjs` 会生成 `examples/report-template-basic.zip`。

模板只能调整已有日报模块的 HTML/CSS 排版。作者不能加入 JavaScript、事件属性、外部网络资源、嵌套页面、数据库访问、AI Prompt 或新的业务分析。

占位符分为三类：普通文本（会被 HTML 转义）、应用生成的 HTML 片段（只能作为元素内容使用）、受限样式类（只能放进 `class` 属性，并由应用输出合法 token）。`*_MORE_NOTE` 是 HTML 片段，不是样式类。

允许的标签和属性由 `src/shared/report-template-package.ts` 统一定义；图片资源只能是包内 `assets/` 下的 PNG/JPEG/WebP。缺少可选模块时应用输出空字符串和 `*_EMPTY_CLASS`，模板应允许该模块隐藏。
