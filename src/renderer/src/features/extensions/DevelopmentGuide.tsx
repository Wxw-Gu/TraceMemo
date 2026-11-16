import * as React from 'react'
import { Button } from '../../components/ui'

interface DevelopmentGuideProps {
  /** 回到扩展列表。 */
  onBack: () => void
  /** 打开「从模板创建项目」：切到模板画廊并展开第一条可用模板。 */
  onCreateProject: () => void
  /** 链接已有本地项目。 */
  onLinkProject: () => void
}

/**
 * 二次开发引导。
 *
 * 这里**不复制文档正文**：文档在 `docs/extensions/`，正文改一次要同步两处必然不一致。
 * 界面只负责把「从哪开始、做完在哪看效果」讲清楚，并指到文档。
 */
const DOCS: Array<{ name: string; file: string; description: string }> = [
  {
    name: '快速开始',
    file: 'docs/extensions/getting-started.md',
    description: '最小 manifest、目录结构、第一次跑起来'
  },
  {
    name: '克隆与改造成自己的扩展',
    file: 'docs/extensions/clone-and-customize.md',
    description: '从官方模板复制代码、改 id、改成自己的逻辑'
  },
  {
    name: 'API 参考',
    file: 'docs/extensions/api-reference.md',
    description: 'manifest 字段、权限表、tm.* 能力清单'
  },
  {
    name: '架构与安全边界',
    file: 'docs/extensions/architecture.md',
    description: '代码在哪、数据在哪、页面为什么在 iframe 里'
  }
]

export function DevelopmentGuide({
  onBack,
  onCreateProject,
  onLinkProject
}: DevelopmentGuideProps): React.ReactElement {
  return (
    <div className="extension-development-guide">
      <header className="extension-guide-header">
        <div>
          <h3>二次开发</h3>
          <p>
            扩展代码放在你自己的目录，TraceMemo 直接运行它。改完点「重新加载」即可生效，
            不需要重新安装；官方升级也不会覆盖你的代码。
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← 返回扩展列表
        </Button>
      </header>

      <ol className="extension-guide-steps">
        <li>
          <span className="extension-guide-index">1</span>
          <div>
            <strong>拿到一份代码</strong>
            <p>
              从官方模板生成独立项目（会替换成你自己的扩展 id），或直接链接已经在别处 clone
              好的目录。
            </p>
          </div>
        </li>
        <li>
          <span className="extension-guide-index">2</span>
          <div>
            <strong>链接到 TraceMemo</strong>
            <p>
              链接后代码不复制：宿主直接读你选的目录。配置、日志、缓存仍然写在 TraceMemo
              的用户数据目录，不会污染你的仓库。
            </p>
          </div>
        </li>
        <li>
          <span className="extension-guide-index">3</span>
          <div>
            <strong>改完重新加载</strong>
            <p>
              后台代码改动点「重新加载」；页面改动刷新 iframe 即可。Manifest 新增权限不会自动授予，
              需要在详情页逐项确认。
            </p>
          </div>
        </li>
      </ol>

      <div className="extension-guide-actions">
        <Button size="sm" onClick={onCreateProject}>
          从模板创建项目
        </Button>
        <Button size="sm" variant="outline" onClick={onLinkProject}>
          链接本地项目
        </Button>
      </div>

      <section className="extension-guide-docs">
        <h4>开发文档</h4>
        <ul>
          {DOCS.map((doc) => (
            <li key={doc.file}>
              <div>
                <strong>{doc.name}</strong>
                <span className="extension-muted">{doc.description}</span>
              </div>
              <code>{doc.file}</code>
            </li>
          ))}
        </ul>
        <p className="extension-muted">
          文档随仓库分发，路径以上方为准；打包后的应用里不包含 docs 目录。
        </p>
      </section>

      <section className="extension-guide-boundary">
        <h4>几个边界</h4>
        <ul>
          <li>不会自动安装、自动启用或自动创建规则——每一步都要你点。</li>
          <li>移除链接只断开引用，不会删除你的项目目录。</li>
          <li>
            页面跑在 sandbox iframe 里，只能调用你自己后台注册的处理器，拿不到 Node 或
            <code>window.api</code>。
          </li>
        </ul>
      </section>
    </div>
  )
}
