/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEEPSEEK_API_KEY: string
  readonly VITE_SCHEDULED_REPORT_DEBUG: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
