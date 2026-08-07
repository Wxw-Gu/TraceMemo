import type { Contact } from '../../../../shared/types'
import { type ReactElement } from 'react'
import { ApiRequestTester } from './components/ApiRequestTester'
import { ApiRuntimePanel } from './components/ApiRuntimePanel'
import { EndpointCatalog } from './components/EndpointCatalog'
import { ReaderSkillOverview } from './components/ReaderSkillOverview'
import { SkillPreviewDialog } from './components/SkillPreviewDialog'
import { useApiCenterController } from './hooks/useApiCenterController'

interface Props {
  selectedContact: Contact | null
  dbReady: boolean
  onOpenSettings: () => void
}

export function ApiWorkspace({ selectedContact, dbReady, onOpenSettings }: Props): ReactElement {
  const controller = useApiCenterController(selectedContact)
  const { state } = controller
  const clear = (): void => {
    controller.updateParams({})
    controller.updateBody('')
  }
  return (
    <div className="api-center-layout">
      <main className="api-main">
        <div className="api-main-scroll">
          <ReaderSkillOverview
            skill={state.skill}
            service={state.service}
            dbReady={dbReady}
            target={state.installTarget}
            onTargetChange={controller.setInstallTarget}
            onPreview={controller.showMarkdown}
            onOpenFolder={controller.openSkillDirectory}
            onOpenGithub={controller.openSkillGithub}
            onStart={() => void controller.controlService('start')}
            onCopyInstruction={() => void controller.copyInstallInstruction()}
            onCopyVerification={() => void controller.copyVerificationPrompt()}
          />
          <EndpointCatalog
            activeEndpointId={state.endpointId}
            onSelect={controller.selectEndpoint}
            onCopy={(path) => controller.copyText(path, '接口路径已复制')}
          />
          <ApiRequestTester
            endpoint={controller.endpoint}
            settings={state.settings}
            service={state.service}
            params={state.params}
            body={state.body}
            state={state.requestState}
            error={state.error}
            onParams={controller.updateParams}
            onBody={controller.updateBody}
            onSend={controller.runRequest}
            onClear={clear}
            onCopyCurl={controller.copyCurl}
          />
        </div>
        {state.rawMarkdown && (
          <SkillPreviewDialog
            content={state.rawMarkdown}
            version={state.skill?.version}
            onClose={controller.closeMarkdown}
          />
        )}
      </main>
      <ApiRuntimePanel
        service={state.service}
        tokenStatus={state.tokenStatus}
        revealedToken={state.revealedToken}
        dbReady={dbReady}
        response={state.response}
        history={state.history}
        onControl={controller.controlService}
        onOpenSettings={onOpenSettings}
        onCopy={controller.copyText}
        onRevealToken={controller.revealToken}
        onHideToken={controller.hideToken}
        onCopyToken={controller.copyToken}
        onRotateToken={controller.rotateToken}
      />
      {state.toast && <div className="app-toast">{state.toast}</div>}
    </div>
  )
}
