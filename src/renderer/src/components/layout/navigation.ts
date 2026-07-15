export type AppPage = 'archive' | 'search' | 'report' | 'agent-hub' | 'export' | 'api' | 'settings'

export interface NavigationItem {
  id: AppPage
  label: string
}

export const PRIMARY_NAV_ITEMS: NavigationItem[] = [
  { id: 'archive', label: '档案' },
  { id: 'search', label: '检索' },
  { id: 'report', label: '日报' },
  { id: 'agent-hub', label: 'Agent' },
  { id: 'export', label: '导出' },
  { id: 'api', label: 'API' },
  { id: 'settings', label: '设置' }
]
