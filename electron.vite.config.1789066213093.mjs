// electron.vite.config.ts
import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
var electron_vite_config_default = defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          reportTemplateTest: resolve("src/main/report-template-test-entry.ts"),
          queryAgentPoc: resolve("src/main/query-agent-poc-entry.ts"),
          voiceRecognitionWorker: resolve("src/main/voice-pipeline/voice-recognition-worker.ts"),
          knowledgeWorker: resolve("src/main/knowledge/knowledge-worker.ts")
        },
        output: {
          entryFileNames: "[name].js"
        },
        external: ["koffi", "sherpa-onnx-node"]
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src")
      }
    },
    plugins: [react()]
  }
});
export {
  electron_vite_config_default as default
};
