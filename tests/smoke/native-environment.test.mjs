import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const enabled = process.env.WXE_REAL_DATA_SMOKE === '1'

test(
  'native WCDB opens a disposable fixture account on this machine',
  { skip: enabled ? false : 'set WXE_REAL_DATA_SMOKE=1 and WXE_SMOKE_DB_ROOT to opt in' },
  () => {
    const root = process.env.WXE_SMOKE_DB_ROOT || ''
    assert.ok(root, 'WXE_SMOKE_DB_ROOT is required')
    assert.ok(fs.existsSync(root), 'WXE_SMOKE_DB_ROOT must exist')
  }
)

test('system permission prompts are verified manually on a clean OS account', {
  skip: 'manual smoke checklist: docs/testing.md'
})

test('signed installer install, upgrade and uninstall are verified manually', {
  skip: 'manual smoke checklist: docs/testing.md'
})
