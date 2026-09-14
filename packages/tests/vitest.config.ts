import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    isolate: false,
    printConsoleTrace: true,
    disableConsoleIntercept: true,
    slowTestThreshold: 3_000,
    testTimeout: 180_000,
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
})
