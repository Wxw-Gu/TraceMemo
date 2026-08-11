import type { SettingsSelfInfo } from '../model/types'
import { AutoDetectImageKeySection } from '../image-decryption/AutoDetectImageKeySection'
import { DangerZone } from '../image-decryption/DangerZone'
import { ImageDecryptStatus } from '../image-decryption/ImageDecryptStatus'
import { ImageKeyConfiguration } from '../image-decryption/ImageKeyConfiguration'
import { ImageTestSection } from '../image-decryption/ImageTestSection'
import { ResourceCheckSection } from '../image-decryption/ResourceCheckSection'
import { SecurityInfoSection } from '../image-decryption/SecurityInfoSection'
import { useImageDecryptionController } from '../image-decryption/useImageDecryptionController'

const STATUS_LABELS = {
  configured: '已配置',
  unconfigured: '未配置',
  partial: '部分能力不可用'
}

export function ImageDecryptionPage({
  selfInfo,
  onNotice
}: {
  selfInfo: SettingsSelfInfo | null
  onNotice: (message: string) => void
}): React.ReactElement {
  const controller = useImageDecryptionController({ selfInfo, onNotice })
  const revalidate = (): void => {
    if (controller.state.selectedUserMd5) {
      void controller.test()
      return
    }
    document.getElementById('image-test-chat')?.scrollIntoView({ behavior: 'smooth' })
    window.setTimeout(() => document.getElementById('image-test-chat')?.focus(), 250)
    onNotice('请先选择一条包含图片的聊天记录')
  }

  return (
    <div className="settings-page image-decryption-page">
      <header className="settings-page-header">
        <div>
          <h1>图片解密</h1>
          <p>管理微信图片、表情和媒体资源解析能力</p>
        </div>
        <span className={`settings-status-badge image-decrypt-badge ${controller.pageStatus}`}>
          {STATUS_LABELS[controller.pageStatus]}
        </span>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content image-decryption-content">
          <section className="settings-privacy-notice">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M12 3 5.5 5.7v5.2c0 4.3 2.7 8.2 6.5 10.1 3.8-1.9 6.5-5.8 6.5-10.1V5.7L12 3Z" />
            </svg>
            <div>
              <strong>图片仅在本机解析</strong>
              <p>TraceMemo 不会上传您的微信图片。所有图片解析和缓存处理均在本地完成。</p>
            </div>
          </section>

          <h2 className="settings-section-heading">图片解密状态</h2>
          <ImageDecryptStatus
            state={controller.state}
            selfInfo={selfInfo}
            disabled={controller.busy}
            onValidate={revalidate}
          />

          <h2 className="settings-section-heading">资源检测</h2>
          <ResourceCheckSection status={controller.state.status} />

          <h2 className="settings-section-heading">图片密钥管理</h2>
          <ImageKeyConfiguration
            state={controller.state}
            disabled={controller.busy}
            onEdit={controller.edit}
          />

          <h2 className="settings-section-heading">自动获取图片密钥</h2>
          <AutoDetectImageKeySection
            state={controller.state}
            disabled={controller.busy}
            canSave={controller.canSave}
            onDetect={() => void controller.autoDetect()}
            onSave={() => void controller.save()}
          />

          <h2 className="settings-section-heading">图片解析测试</h2>
          <ImageTestSection
            state={controller.state}
            batchTest={controller.batchTest}
            disabled={controller.busy}
            canSave={controller.canSave}
            onSelect={controller.selectChat}
            onTest={() => void controller.test()}
            onBatchTest={(contacts) => void controller.testMany(contacts)}
            onStopBatchTest={controller.stopBatchTest}
            onCopyLog={() => void controller.copyDiagnostics()}
            onSave={() => void controller.save()}
          />

          <h2 className="settings-section-heading">安全说明</h2>
          <SecurityInfoSection />
          <DangerZone
            disabled={controller.busy || !controller.state.config?.configured}
            onClear={() => void controller.clear()}
          />
        </div>
      </div>
    </div>
  )
}
