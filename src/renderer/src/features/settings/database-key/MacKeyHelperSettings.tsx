import { useEffect, useState } from 'react'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../../components/ui'
import type { MacKeyHelperMode } from '../../../../../shared/database-key'

/**
 * macOS Apple Silicon 密钥工具覆盖。
 *
 * 微信的 `CFBundleShortVersionString` 是外壳版本，可能和实际内核不一致
 * （例如显示 4.2.0，内核仍是 4.1.12）。自动模式按外壳版本选 helper 时会选错，
 * 这里允许用户显式指定，避免只能手动跑 helper。
 */
export function MacKeyHelperSettings({
  onNotice
}: {
  onNotice: (message: string) => void
}): React.ReactElement {
  const [mode, setMode] = useState<MacKeyHelperMode>('auto')
  const [helperPath, setHelperPath] = useState('')
  const [profile, setProfile] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    void window.api
      .getSettings()
      .then((result) => {
        if (!active) return
        setMode(result.settings.macKeyHelperMode)
        setHelperPath(result.settings.macKeyHelperPath)
        setProfile(result.settings.macKeyHelperProfile)
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await window.api.setSettings({
        macKeyHelperMode: mode,
        macKeyHelperPath: helperPath.trim(),
        macKeyHelperProfile: profile.trim()
      })
      setMode(result.settings.macKeyHelperMode)
      setHelperPath(result.settings.macKeyHelperPath)
      setProfile(result.settings.macKeyHelperProfile)
      onNotice('密钥工具设置已保存，将在下一次自动获取密钥时生效')
    } catch {
      onNotice('密钥工具设置保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-card database-key-helper">
      <div className="database-key-helper-heading">
        <strong>密钥工具</strong>
        <p>
          自动模式按微信版本选择工具。若微信外壳版本与实际内核不一致（例如显示 4.2 但内核为
          4.1.x），自动获取会匹配失败，可在这里手动指定 4.1.13 工具。
        </p>
      </div>
      <label className="database-key-helper-field">
        <span>工具选择</span>
        <Select
          value={mode}
          onValueChange={(value) => setMode(value as MacKeyHelperMode)}
          disabled={!loaded || saving}
        >
          <SelectTrigger aria-label="密钥工具选择">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">自动（按微信版本）</SelectItem>
            <SelectItem value="wechat-4.1.13">新版工具（xkey_helper_4_1_13）</SelectItem>
            <SelectItem value="legacy">旧版工具（xkey_helper）</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <details className="database-key-helper-advanced">
        <summary>高级选项：自定义工具路径 / Profile</summary>
        <label className="database-key-helper-field">
          <span>工具路径</span>
          <Input
            value={helperPath}
            onChange={(event) => setHelperPath(event.target.value)}
            placeholder="留空使用内置工具"
            disabled={!loaded || saving}
          />
        </label>
        <label className="database-key-helper-field">
          <span>Profile</span>
          <Input
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
            placeholder="wechat-4.1.13"
            disabled={!loaded || saving || mode === 'legacy'}
          />
        </label>
        <small>
          自定义路径会覆盖内置工具；Profile 只对新版工具生效，留空时使用 wechat-4.1.13。Profile
          仅支持字母、数字、点、下划线和短横线。
        </small>
      </details>
      <div className="database-key-helper-actions">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void save()}
          disabled={!loaded || saving}
        >
          {saving ? '保存中…' : '保存密钥工具设置'}
        </Button>
        <small>保存后，下一次“自动获取密钥”生效。</small>
      </div>
    </section>
  )
}
