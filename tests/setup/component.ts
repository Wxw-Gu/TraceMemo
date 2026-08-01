import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => cleanup())

Object.defineProperty(globalThis.URL, 'createObjectURL', {
  configurable: true,
  value: vi.fn(() => 'blob:wxe-test-audio')
})

Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
  configurable: true,
  value: vi.fn()
})
