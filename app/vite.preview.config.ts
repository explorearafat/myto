import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Standalone browser preview config (NOT used by the app).
 *
 * `electron-vite dev` launches a native Electron window and cannot be captured
 * by the web preview tooling. This config serves the renderer as a plain web
 * page over HTTP so the UI can be screenshotted. `window.myto` is provided by
 * the browser-preview shim (src/renderer/src/lib/browser-preview-shim.ts), which
 * only activates when the Electron bridge is absent. Mirrors the `renderer`
 * block of electron.vite.config.ts (aliases, React, Tailwind).
 */
export default defineConfig({
  root: 'src/renderer',
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  server: { port: 5199, strictPort: true },
  worker: { format: 'es' }
})
