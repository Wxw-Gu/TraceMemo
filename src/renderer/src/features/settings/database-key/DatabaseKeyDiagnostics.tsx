import type { DatabaseKeyState } from './types'
import { formatValidationTime, isDatabaseKeyFormatValid } from './utils'
import { Button } from '../../../components/ui'

export function DatabaseKeyDiagnostics({
  state,
  input,
  wxid,
  accountRoot,
  onCopy
}: {
  state: DatabaseKeyState
  input: string
  wxid?: string
  accountRoot?: string
  onCopy: () => void
}): React.ReactElement {
  return (
    <details className="database-key-diagnostics">
      <summary>查看密钥诊断</summary>
      <dl>
        <div>
          <dt>是否已保存</dt>
          <dd>{state.saved ? '是' : '否'}</dd>
        </div>
        <div>
          <dt>是否已验证</dt>
          <dd>{state.validation?.success ? '是' : '否'}</dd>
        </div>
        <div>
          <dt>密钥长度是否合法</dt>
          <dd>{isDatabaseKeyFormatValid(input) ? '是' : '否'}</dd>
        </div>
        <div>
          <dt>当前账号 wxid</dt>
          <dd>{wxid || state.validation?.wxid || '未识别'}</dd>
        </div>
        <div>
          <dt>当前数据库目录</dt>
          <dd title={accountRoot || state.validation?.accountRoot}>
            {accountRoot || state.validation?.accountRoot || '未识别'}
          </dd>
        </div>
        <div>
          <dt>最近验证时间</dt>
          <dd>{formatValidationTime(state.lastValidatedAt)}</dd>
        </div>
        <div>
          <dt>安全错误代码</dt>
          <dd>{state.errorCode || '无'}</dd>
        </div>
        <div>
          <dt>当前平台</dt>
          <dd>{state.environment?.platform || '未知'}</dd>
        </div>
        <div>
          <dt>自动获取</dt>
          <dd>{state.environment?.autoDetectSupported ? '支持' : '不支持'}</dd>
        </div>
      </dl>
      <Button variant="ghost" size="sm" className="mx-4 mb-4" onClick={onCopy}>
        复制诊断信息
      </Button>
    </details>
  )
}
