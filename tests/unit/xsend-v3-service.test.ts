import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/fixture/app' } }))

import {
  parseXsendManifest,
  parseXsendReceipt,
  validateXsendManifest,
  validateXsendText,
  XsendV3Service,
  type XsendV3ServiceDependencies
} from '../../src/main/services/xsend-v3-service'

const RESIDENT_SHA256 = '04ba738b27da9d07c48610226f115fc1b93359e3459427b4c7fe7fa241d12c1c'
const WECHAT_DYLIB_SHA256 = '964f653977f7e6d00400804eb492e230528c8e8e0653db6300e9b913e49973a9'
const WECHAT_BUILD = '269631'

const manifestSource = [
  'format=xsend-v3-resident',
  'version=0.1.0',
  'platform=darwin-arm64',
  'wechat_build=269631',
  'wechat_dylib_sha256=' + WECHAT_DYLIB_SHA256,
  'payload=embedded',
  'resident_binary=xsend-v3-resident',
  'resident_sha256=' + RESIDENT_SHA256,
  'onebot_dependency=none',
  'python_runtime_dependency=none'
].join('\n')

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

function createFixture(
  options: {
    platform?: string
    arch?: string
    pid?: number
    build?: string
    binaryHash?: string
    dylibHash?: string
    receipt?: string
    receiptInStderr?: boolean
    includeChecksum?: boolean
  } = {}
): { service: XsendV3Service; execFile: ReturnType<typeof vi.fn> } {
  const root = mkdtempSync(join(tmpdir(), 'tracememo-xsend-v3-'))
  temporaryDirectories.push(root)
  const manifestPath = join(root, 'MANIFEST')
  const binaryPath = join(root, 'xsend-v3-resident')
  const checksumPath = join(root, 'xsend-v3-resident.sha256')
  const dylibPath = join(root, 'wechat.dylib')
  writeFileSync(manifestPath, manifestSource)
  writeFileSync(binaryPath, 'resident fixture')
  if (options.includeChecksum !== false) {
    writeFileSync(checksumPath, RESIDENT_SHA256 + '  xsend-v3-resident\n')
  }
  writeFileSync(dylibPath, 'wechat dylib fixture')

  const execFile = vi.fn(async () => ({
    stdout: options.receiptInStderr ? '' : options.receipt || 'v3: state=2 detail=ready',
    stderr: options.receiptInStderr ? options.receipt || 'v3: state=2 detail=ready' : ''
  }))
  const dependencies: XsendV3ServiceDependencies = {
    platform: () => options.platform || 'darwin',
    arch: () => options.arch || 'arm64',
    findResource: (relativePath) =>
      relativePath === 'xsend-v3/MANIFEST'
        ? manifestPath
        : relativePath === 'xsend-v3/xsend-v3-resident'
          ? binaryPath
          : relativePath === 'xsend-v3/xsend-v3-resident.sha256'
            ? options.includeChecksum === false
              ? null
              : checksumPath
            : null,
    wechatDylibPath: dylibPath,
    readWechatPid: async () => (options.pid === undefined ? 123 : options.pid),
    readWechatBuild: async () => options.build || WECHAT_BUILD,
    hashFile: (filePath) => {
      if (filePath === binaryPath) return options.binaryHash || RESIDENT_SHA256
      if (filePath === dylibPath) return options.dylibHash || WECHAT_DYLIB_SHA256
      throw new Error('unexpected fixture path: ' + filePath)
    },
    execFile
  }
  return { service: new XsendV3Service(dependencies), execFile }
}

describe('xsend manifest and receipt parsing', () => {
  it('parses and validates the public manifest contract', () => {
    const manifest = parseXsendManifest(manifestSource)

    expect(manifest).toMatchObject({
      format: 'xsend-v3-resident',
      version: '0.1.0',
      platform: 'darwin-arm64',
      wechat_build: WECHAT_BUILD,
      resident_sha256: RESIDENT_SHA256
    })
    expect(() => validateXsendManifest(manifest)).not.toThrow()
  })

  it('rejects duplicate and missing manifest fields', () => {
    expect(() => parseXsendManifest(manifestSource + '\nformat=xsend-v3-resident')).toThrow(
      '重复字段'
    )
    const manifest = parseXsendManifest(manifestSource)
    expect(() => validateXsendManifest({ ...manifest, resident_binary: '' })).toThrow(
      '缺少字段：resident_binary'
    )
  })

  it('keeps spaces inside the detail field', () => {
    expect(
      parseXsendReceipt('v3: request_id=abc state=2 queue=1 retained=0 detail=send completed')
    ).toEqual({
      requestId: 'abc',
      state: 2,
      queue: 1,
      retained: 0,
      detail: 'send completed'
    })
  })
})

describe('XsendV3Service preflight', () => {
  it('reports unsupported platforms before reading resources', async () => {
    const { service, execFile } = createFixture({ platform: 'linux' })

    await expect(service.getStatus()).resolves.toMatchObject({
      supported: false,
      state: 'unsupported_platform',
      ready: false
    })
    expect(execFile).not.toHaveBeenCalled()
  })

  it('rejects a resident binary whose digest does not match the manifest', async () => {
    const { service } = createFixture({ binaryHash: 'f'.repeat(64) })

    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'integrity_error',
      ready: false,
      error: 'resident_sha256 与 MANIFEST 不一致'
    })
  })

  it('rejects a package whose resident checksum file is missing', async () => {
    const { service } = createFixture({ includeChecksum: false })

    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'integrity_error',
      error: '找不到 resident.sha256 校验文件'
    })
  })

  it('rejects a WeChat dylib whose digest does not match the manifest', async () => {
    const { service } = createFixture({ dylibHash: 'e'.repeat(64) })

    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'integrity_error',
      wechatBuild: WECHAT_BUILD,
      error: 'wechat.dylib 指纹不匹配'
    })
  })

  it('rejects an unsupported WeChat build', async () => {
    const { service } = createFixture({ build: '269630' })

    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'unsupported_version',
      wechatBuild: '269630'
    })
  })

  it('rejects an invalid WeChat PID', async () => {
    const { service } = createFixture({ pid: 0 })

    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'unavailable',
      ready: false,
      error: 'PID=0'
    })
  })
})

describe('XsendV3Service state handling', () => {
  it.each([
    ['ready', 'v3: request_id=status state=2 queue=0 retained=0 detail=ready'],
    ['failed', 'v3: request_id=status state=0 detail=failed'],
    ['accepted', 'v3: request_id=status state=1 queue=1 detail=accepted'],
    ['unknown', 'v3: request_id=status state=3 detail=unknown']
  ] as const)('maps state %s without changing its meaning', async (expected, receipt) => {
    const { service } = createFixture({ receipt })

    await expect(service.getStatus()).resolves.toMatchObject({ state: expected })
  })

  it('recognizes a not-installed resident from state zero detail', async () => {
    const { service } = createFixture({ receipt: 'v3: state=0 detail=resident not installed' })

    await expect(service.getStatus()).resolves.toMatchObject({ state: 'not_installed' })
  })

  it('reads a status receipt from stderr and preserves its detail', async () => {
    const { service } = createFixture({
      receiptInStderr: true,
      receipt: 'v3: request_id=abc state=2 detail=send completed'
    })

    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'ready',
      requestId: 'abc',
      detail: 'send completed'
    })
  })

  it.each([
    ['accepted', 'v3: request_id=send state=1 detail=queued'],
    ['unknown', 'v3: request_id=send state=3 detail=unknown']
  ] as const)('does not retry a %s send receipt', async (expected, receipt) => {
    const { service, execFile } = createFixture({ receipt })

    const result = await service.sendText('wxid_fixture', 'hello')

    expect(result).toMatchObject({ success: false, status: { state: expected } })
    expect(execFile).toHaveBeenCalledOnce()
  })
})

describe('validateXsendText', () => {
  it('rejects empty values and line breaks', () => {
    expect(() => validateXsendText('', 'hello')).toThrow()
    expect(() => validateXsendText('target', '')).toThrow()
    expect(() => validateXsendText('target\nnext', 'hello')).toThrow('目标不能包含换行')
    expect(() => validateXsendText('target', 'hello\rnext')).toThrow('内容不能包含换行')
  })

  it('accepts the exact byte limits and rejects values above them', () => {
    expect(() => validateXsendText('a'.repeat(255), 'ok')).not.toThrow()
    expect(() => validateXsendText('a'.repeat(256), 'ok')).toThrow('255 字节')
    expect(() => validateXsendText('target', 'a'.repeat(4095))).not.toThrow()
    expect(() => validateXsendText('target', 'a'.repeat(4096))).toThrow('4095 字节')
  })
})
