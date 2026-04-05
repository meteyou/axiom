import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@openagent/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@openagent/web-backend': path.resolve(__dirname, 'packages/web-backend/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/web-frontend/**/*.test.ts'],
  },
})
