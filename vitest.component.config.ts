import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    name: 'component',
    environment: 'jsdom',
    include: ['tests/component/**/*.test.tsx'],
    setupFiles: ['tests/setup/component.ts'],
    clearMocks: true,
    restoreMocks: true
  }
})
