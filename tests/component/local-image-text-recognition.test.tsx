import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalImageTextRecognition } from '../../src/renderer/src/features/settings/ai-model/LocalImageTextRecognition'
import type { SystemOcrCapability, SystemOcrResult } from '../../src/shared/system-ocr'

const availableCapability: SystemOcrCapability = {
  available: true,
  engine: 'windows-system-ocr',
  platform: 'win32',
  arch: 'x64',
  runtimeVersion: '1.2.0',
  language: 'zh-Hans-CN',
  message: '本地图片文字识别可用（Windows 系统 OCR，zh-Hans-CN）。'
}

const unavailableCapability: SystemOcrCapability = {
  available: false,
  engine: 'windows-system-ocr',
  platform: 'win32',
  arch: 'x64',
  runtimeVersion: '1.2.0',
  language: null,
  reason: 'LANGUAGE_UNAVAILABLE',
  message: '当前 Windows 未安装可用的 OCR 语言支持。'
}

const successResult: SystemOcrResult = {
  success: true,
  text: 'TraceMemo 本地文字识别',
  lines: [],
  language: 'zh-Hans-CN',
  engine: 'windows-system-ocr',
  durationMs: 42
}

const emptyResult: SystemOcrResult = {
  success: false,
  text: '',
  lines: [],
  language: 'zh-Hans-CN',
  engine: 'windows-system-ocr',
  durationMs: 12,
  errorCode: 'OCR_EMPTY_RESULT',
  error: '没有在这张图片里识别到文字。'
}

const selectImage = (): void => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('file input missing')
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'fixture.png', {
    type: 'image/png'
  })
  fireEvent.change(input, { target: { files: [file] } })
}

describe('LocalImageTextRecognition', () => {
  beforeEach(() => {
    window.api = {
      getSystemOcrCapability: vi.fn().mockResolvedValue(availableCapability),
      recognizeLocalImageText: vi.fn().mockResolvedValue(successResult)
    } as typeof window.api
  })

  it('shows local availability without requiring any AI provider', async () => {
    render(<LocalImageTextRecognition />)
    expect(await screen.findByText('本机可用')).toBeInTheDocument()
    expect(screen.getByText(/组件 1\.2\.0/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '本地文字识别' })).toBeDisabled()
  })

  it('recognizes text locally and renders the extracted text', async () => {
    render(<LocalImageTextRecognition />)
    await screen.findByText('本机可用')

    selectImage()
    const button = await screen.findByRole('button', { name: '本地文字识别' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)

    expect(await screen.findByText('TraceMemo 本地文字识别')).toBeInTheDocument()
    expect(window.api.recognizeLocalImageText).toHaveBeenCalledWith({
      imageDataUrl: expect.stringContaining('data:image/png;base64,')
    })
  })

  it('surfaces an empty OCR result as a product message, not a native error', async () => {
    vi.mocked(window.api.recognizeLocalImageText).mockResolvedValue(emptyResult)
    render(<LocalImageTextRecognition />)
    await screen.findByText('本机可用')

    selectImage()
    const button = await screen.findByRole('button', { name: '本地文字识别' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)

    expect(await screen.findByText('没有在这张图片里识别到文字。')).toBeInTheDocument()
  })

  it('keeps the entry disabled and explains why when the language pack is missing', async () => {
    vi.mocked(window.api.getSystemOcrCapability).mockResolvedValue(unavailableCapability)
    render(<LocalImageTextRecognition />)

    expect(await screen.findByText('本机不可用')).toBeInTheDocument()
    expect(screen.getByText('当前 Windows 未安装可用的 OCR 语言支持。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '本地文字识别' })).toBeDisabled()
  })
})
