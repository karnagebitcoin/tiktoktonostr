import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const entryNames = new Set(["background", "content", "page-bridge"]);

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: path.resolve(__dirname, "index.html"),
        background: path.resolve(__dirname, "src/extension/background.ts"),
        content: path.resolve(__dirname, "src/extension/content.ts"),
        "page-bridge": path.resolve(__dirname, "src/extension/page-bridge.ts"),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          return entryNames.has(chunkInfo.name) ? "[name].js" : "assets/[name].js";
        },
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    onConsoleLog(log) {
      return !log.includes("React Router Future Flag Warning");
    },
  },
});
