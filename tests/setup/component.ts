import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => cleanup())

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, String(value))
    }
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: createMemoryStorage()
})

Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: createMemoryStorage()
})

Object.defineProperty(globalThis.URL, 'createObjectURL', {
  configurable: true,
  value: vi.fn(() => 'blob:wxe-test-audio')
})

Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
  configurable: true,
  value: vi.fn()
})
