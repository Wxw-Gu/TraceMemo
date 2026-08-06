import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'knowledge-benchmark',
    environment: 'node',
    include: ['tests/benchmark/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20 * 60 * 1000
  }
})
