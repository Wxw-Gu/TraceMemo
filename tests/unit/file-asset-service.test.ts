import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileAssetService } from '../../src/main/file-asset-service'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('file asset service', () => {
  it('prefers the message month and supports duplicate download suffixes', () => {
    const accountRoot = mkdtempSync(join(tmpdir(), 'wxe-file-asset-'))
    roots.push(accountRoot)
    const august = join(accountRoot, 'msg', 'file', '2026-08')
    const july = join(accountRoot, 'msg', 'file', '2026-07')
    mkdirSync(august, { recursive: true })
    mkdirSync(july, { recursive: true })
    writeFileSync(join(july, '产品说明.txt'), 'old')
    writeFileSync(join(august, '产品说明(1).txt'), 'current')

    const service = new FileAssetService({ getAccountRoot: () => accountRoot })
    const result = service.resolve('产品说明.txt', new Date(2026, 7, 4).getTime() / 1000)

    expect(result).toMatchObject({ success: true, fileName: '产品说明(1).txt' })
    expect(result.filePath).toBe(realpathSync(join(august, '产品说明(1).txt')))
  })
})
