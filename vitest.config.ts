import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@axiom\/core\/contracts$/, replacement: path.resolve(__dirname, 'packages/core/src/contracts/index.ts') },
      { find: /^@axiom\/core$/, replacement: path.resolve(__dirname, 'packages/core/src/index.ts') },
      { find: /^@axiom\/telegram$/, replacement: path.resolve(__dirname, 'packages/telegram/src/index.ts') },
      { find: /^@axiom\/web-backend$/, replacement: path.resolve(__dirname, 'packages/web-backend/src/index.ts') },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/web-frontend/**/*.test.ts'],
  },
})
