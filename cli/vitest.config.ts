import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * The CLI's tests. `@app/*` resolves into the desktop app's sources so the tests
 * can exercise the CLI wiring against the same engine modules the bundle ships.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@app/shared': fileURLToPath(new URL('../app/src/shared', import.meta.url)),
      '@app/main': fileURLToPath(new URL('../app/src/main', import.meta.url)),
      '@cli': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
