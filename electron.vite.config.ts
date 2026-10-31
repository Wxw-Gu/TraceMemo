import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const editionOutDir = process.env.TRACEMEMO_EDITION_OUT_DIR

export default defineConfig({
  main: {
    build: {
      ...(editionOutDir ? { outDir: editionOutDir } : {}),
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          reportTemplateTest: resolve('src/main/report-template-test-entry.ts'),
          queryAgentPoc: resolve('src/main/query-agent-poc-entry.ts'),
          voiceRecognitionWorker: resolve('src/main/voice-pipeline/voice-recognition-worker.ts'),
          knowledgeWorker: resolve('src/main/knowledge/knowledge-worker.ts')
        },
        output: {
          entryFileNames: '[name].js'
        },
        external: ['koffi', 'sherpa-onnx-node', '@napi-rs/system-ocr']
      }
    }
  },
  preload: editionOutDir ? { build: { outDir: editionOutDir } } : {},
  renderer: {
    ...(editionOutDir ? { build: { outDir: editionOutDir } } : {}),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
